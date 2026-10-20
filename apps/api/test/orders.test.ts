import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Role } from '../src/auth/sessions.js';
import type { RecordingSmsSender } from '../src/auth/sms.js';
import { createPool, withTransaction, type Db } from '../src/db.js';
import { expireUnpaidOrders } from '../src/orders.js';
import { DevFakePaymentProvider } from '../src/payments.js';
import { grantRole } from '../src/users.js';
import { resetDatabase, TEST_DATABASE_URL, testDeps } from './helpers.js';

const CATALOG = [
  'sku,name,generic_name,manufacturer,gst_rate',
  'P1,Dolo 650,Paracetamol,Micro Labs,12',
  'P2,Augmentin 625 Duo,Amoxicillin,GSK,12',
].join('\n');

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

describe.skipIf(!TEST_DATABASE_URL)('orders and payments (integration)', () => {
  let db: Db;
  let app: FastifyInstance;
  let noProviderApp: FastifyInstance;
  let sms: RecordingSmsSender;
  const fake = new DevFakePaymentProvider('test-webhook-secret-123');
  let counter = 0;
  let operator: { token: string; userId: string };
  let support: { token: string; userId: string };
  let a: Retailer;
  let b: Retailer;
  const ids: Record<string, string> = {};
  let keySeq = 0;

  type Retailer = { token: string; userId: string; accountId: string };

  async function login(): Promise<{ token: string; userId: string }> {
    counter += 1;
    const phone = `+9193000${String(counter).padStart(5, '0')}`;
    await app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone } });
    const res = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: sms.sent.get(phone) } });
    return { token: res.json().token, userId: res.json().user.id };
  }

  async function withRole(role: Role) {
    const user = await login();
    await withTransaction(db, (c) => grantRole(c, { userId: null, role: 'cli' }, user.userId, role));
    return user;
  }

  async function retailer(): Promise<Retailer> {
    const user = await login();
    const accountId = await withTransaction(db, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "INSERT INTO retailer_accounts (owner_user_id, status, cod_allowed, business_name) VALUES ($1, 'approved', true, 'Test Pharmacy') RETURNING id",
        [user.userId],
      );
      await c.query(
        `INSERT INTO store_locations (retailer_account_id, address_line1, city, district, postal_code, service_zone, verified)
         VALUES ($1, 'Main Road', 'Samastipur', 'Samastipur', '848101', 'SMP-1', true)`,
        [rows[0]!.id],
      );
      await c.query("INSERT INTO user_roles (user_id, role, scope_retailer_account_id) VALUES ($1, 'retailer', $2)", [
        user.userId,
        rows[0]!.id,
      ]);
      return rows[0]!.id;
    });
    return { ...user, accountId };
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const newKey = () => `test-key-${++keySeq}-${Date.now()}`;

  async function quoteFor(r: Retailer, items: Record<string, number>, target = app) {
    await target.inject({ method: 'DELETE', url: '/cart', headers: bearer(r.token) });
    for (const [sku, quantity] of Object.entries(items)) {
      await target.inject({ method: 'PUT', url: `/cart/items/${ids[sku]}`, headers: bearer(r.token), payload: { quantity } });
    }
    const res = await target.inject({ method: 'POST', url: '/cart/quote', headers: bearer(r.token) });
    return res.json().quote;
  }

  function place(r: Retailer, quoteId: string, paymentMethod: 'cod' | 'prepaid', key: string | null = newKey(), target = app) {
    return target.inject({
      method: 'POST',
      url: '/orders',
      headers: { ...bearer(r.token), ...(key ? { 'idempotency-key': key } : {}) },
      payload: { quoteId, paymentMethod },
    });
  }

  async function reserved(sku: string): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      'SELECT coalesce(sum(reserved_qty), 0)::int AS n FROM inventory_batches WHERE product_id = $1',
      [ids[sku]],
    );
    return rows[0]!.n;
  }

  function webhook(body: object, signature?: string) {
    const raw = JSON.stringify(body);
    return app.inject({
      method: 'POST',
      url: '/payments/webhooks/dev_fake',
      headers: { 'content-type': 'application/json', 'x-dev-signature': signature ?? fake.sign(raw) },
      payload: raw,
    });
  }

  beforeAll(async () => {
    db = createPool({ databaseUrl: TEST_DATABASE_URL!, databaseSsl: false });
    await resetDatabase(db);
    const deps = testDeps(db);
    sms = deps.sms;
    app = await buildApp({ ...deps, payments: fake });
    noProviderApp = await buildApp(deps);
    operator = await withRole('catalog_operator');
    support = await withRole('support_operator');
    a = await retailer();
    b = await retailer();
    await app.inject({
      method: 'POST',
      url: '/admin/catalog/imports?source=manual_entry&dryRun=false',
      headers: { ...bearer(operator.token), 'content-type': 'text/csv' },
      payload: CATALOG,
    });
    const { rows } = await db.query<{ sku: string; id: string }>('SELECT sku, id FROM products');
    for (const r of rows) ids[r.sku] = r.id;
    const stock = ['sku,batch,expiry,qty,mrp,rate', `P1,B1,${inDays(300)},1000,120.00,100.00`, `P2,A1,${inDays(300)},6,250.00,100.00`].join('\n');
    const res = await app.inject({
      method: 'POST',
      url: `/admin/inventory/imports?source=marg_export&dryRun=false&asOf=${new Date(Date.now() - 60_000).toISOString()}`,
      headers: { ...bearer(operator.token), 'content-type': 'text/csv' },
      payload: stock,
    });
    expect(res.statusCode).toBe(201);
  });

  afterAll(async () => {
    await app?.close();
    await noProviderApp?.close();
    await db?.end();
  });

  it('requires an idempotency key and an approved retailer', async () => {
    const quote = await quoteFor(a, { P1: 30 });
    expect((await place(a, quote.id, 'cod', null)).statusCode).toBe(400);
    const outsider = await login();
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { ...bearer(outsider.token), 'idempotency-key': newKey() },
      payload: { quoteId: quote.id, paymentMethod: 'cod' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('places a COD order, reserves stock, empties the cart and replays safely', async () => {
    const quote = await quoteFor(a, { P1: 30 });
    const key = newKey();
    const res = await place(a, quote.id, 'cod', key);
    expect(res.statusCode).toBe(201);
    const order = res.json().order;
    expect(order).toMatchObject({
      status: 'placed',
      paymentMethod: 'cod',
      paymentStatus: 'cod_due',
      subtotalPaise: 3_000_00,
      taxPaise: 360_00,
      deliveryFeePaise: 50_00,
      payablePaise: 3_410_00,
    });
    expect(order.orderNumber).toMatch(/^TDA-\d+$/);
    expect(order.items).toEqual([expect.objectContaining({ sku: 'P1', quantity: 30, totalPaise: 3_360_00 })]);
    expect(order.allocations).toBeUndefined();
    expect(await reserved('P1')).toBe(30);
    const cart = (await app.inject({ method: 'GET', url: '/cart', headers: bearer(a.token) })).json().cart;
    expect(cart.lines).toEqual([]);

    // Same key again (e.g. the phone lost the response): same order, nothing reserved twice.
    const again = await place(a, quote.id, 'cod', key);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true, order: { id: order.id } });
    expect(await reserved('P1')).toBe(30);

    // A new key cannot reuse the quote.
    expect((await place(a, quote.id, 'cod')).statusCode).toBe(409);
    // The same key cannot be reused for another quote.
    const other = await quoteFor(a, { P1: 31 });
    expect((await place(a, other.id, 'cod', key)).statusCode).toBe(409);
  });

  it('rejects expired and out-of-date quotes', async () => {
    const quote = await quoteFor(a, { P1: 30 });
    await db.query("UPDATE price_quotes SET expires_at = now() - interval '1 minute' WHERE id = $1", [quote.id]);
    expect((await place(a, quote.id, 'cod')).json().error.code).toBe('QUOTE_EXPIRED');

    const fresh = await quoteFor(a, { P1: 30 });
    await app.inject({ method: 'PUT', url: `/cart/items/${ids.P1}`, headers: bearer(a.token), payload: { quantity: 40 } });
    expect((await place(a, fresh.id, 'cod')).json().error.code).toBe('QUOTE_CHANGED');
  });

  it('refuses COD above ₹10,000 and prepaid when no provider is configured', async () => {
    const big = await quoteFor(a, { P1: 100 });
    const res = await place(a, big.id, 'cod');
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: 'PAYMENT_METHOD_NOT_ALLOWED', details: { allowed: ['prepaid'] } });

    const q = await quoteFor(a, { P1: 30 }, noProviderApp);
    const refused = await place(a, q.id, 'prepaid', newKey(), noProviderApp);
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error.code).toBe('PAYMENT_UNAVAILABLE');
    await app.inject({ method: 'DELETE', url: '/cart', headers: bearer(a.token) });
  });

  it('marks prepaid orders paid only from a verified, de-duplicated webhook', async () => {
    const quote = await quoteFor(b, { P1: 30 });
    const placed = await place(b, quote.id, 'prepaid');
    expect(placed.statusCode).toBe(201);
    const order = placed.json().order;
    expect(order).toMatchObject({ paymentStatus: 'awaiting_payment' });
    expect(order.paymentDueBy).toBeTruthy();

    // Staff cannot accept an unpaid prepaid order.
    expect(
      (await app.inject({ method: 'POST', url: `/admin/orders/${order.id}/accept`, headers: bearer(support.token) })).statusCode,
    ).toBe(409);

    const session = await app.inject({ method: 'POST', url: '/payments/session', headers: bearer(b.token), payload: { orderId: order.id } });
    expect(session.statusCode).toBe(201);
    const { paymentId } = session.json();
    const { rows } = await db.query<{ provider_ref: string }>('SELECT provider_ref FROM payments WHERE id = $1', [paymentId]);
    const providerRef = rows[0]!.provider_ref;

    // Another retailer cannot start payment for or read this order.
    expect(
      (await app.inject({ method: 'POST', url: '/payments/session', headers: bearer(a.token), payload: { orderId: order.id } })).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/payments/${paymentId}/status`, headers: bearer(a.token) })).statusCode).toBe(404);

    const event = { eventId: 'evt-1', providerRef, status: 'succeeded', amountPaise: 3_410_00 };
    expect((await webhook(event, 'f'.repeat(64))).statusCode).toBe(401);
    expect((await webhook({ ...event, eventId: 'evt-0', amountPaise: 1 })).json().outcome).toBe('amount_mismatch');
    expect((await webhook(event)).json().outcome).toBe('applied');
    expect((await webhook(event)).json().outcome).toBe('duplicate');

    const status = await app.inject({ method: 'GET', url: `/payments/${paymentId}/status`, headers: bearer(b.token) });
    expect(status.json()).toMatchObject({ status: 'succeeded', orderPaymentStatus: 'paid' });
    const events = (await app.inject({ method: 'GET', url: `/orders/${order.id}`, headers: bearer(b.token) })).json().order.events;
    expect(events.filter((e: { kind: string }) => e.kind === 'payment').map((e: { to: string }) => e.to)).toEqual([
      'awaiting_payment',
      'paid',
    ]);
  });

  it('keeps retailers to their own orders', async () => {
    const mine = (await app.inject({ method: 'GET', url: '/orders', headers: bearer(a.token) })).json().items;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((o: { retailerAccountId: string }) => o.retailerAccountId === a.accountId)).toBe(true);
    const theirs = (await app.inject({ method: 'GET', url: '/orders', headers: bearer(b.token) })).json().items[0];
    expect((await app.inject({ method: 'GET', url: `/orders/${theirs.id}`, headers: bearer(a.token) })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: `/orders/${theirs.id}/cancel-request`, headers: bearer(a.token), payload: {} })).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/admin/orders', headers: bearer(a.token) })).statusCode).toBe(403);
  });

  it('lets a retailer cancel before acceptance and only request it after', async () => {
    const before = await reserved('P1');
    const q1 = await quoteFor(a, { P1: 30 });
    const o1 = (await place(a, q1.id, 'cod')).json().order;
    expect(await reserved('P1')).toBe(before + 30);
    const cancelled = await app.inject({
      method: 'POST',
      url: `/orders/${o1.id}/cancel-request`,
      headers: bearer(a.token),
      payload: { reason: 'Ordered by mistake' },
    });
    expect(cancelled.json()).toMatchObject({ result: 'cancelled', order: { status: 'cancelled', paymentStatus: 'not_charged' } });
    expect(await reserved('P1')).toBe(before);

    const q2 = await quoteFor(a, { P1: 30 });
    const o2 = (await place(a, q2.id, 'cod')).json().order;
    const accepted = await app.inject({ method: 'POST', url: `/admin/orders/${o2.id}/accept`, headers: bearer(support.token) });
    expect(accepted.json().order.status).toBe('accepted');
    const requested = await app.inject({ method: 'POST', url: `/orders/${o2.id}/cancel-request`, headers: bearer(a.token) });
    expect(requested.json().result).toBe('cancel_requested');
    expect(await reserved('P1')).toBe(before + 30);

    const staff = await app.inject({
      method: 'POST',
      url: `/admin/orders/${o2.id}/cancel`,
      headers: bearer(support.token),
      payload: { reason: 'Retailer asked by phone' },
    });
    expect(staff.json().order).toMatchObject({ status: 'cancelled', paymentStatus: 'not_charged' });
    expect(staff.json().order.allocations.every((x: { releasedAt: string | null }) => x.releasedAt)).toBe(true);
    expect(await reserved('P1')).toBe(before);
    const audit = await db.query("SELECT action FROM audit_logs WHERE entity_type = 'order' AND entity_id = $1 ORDER BY occurred_at", [o2.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['order.accept', 'order.cancel']);
  });

  it('cancels unpaid prepaid orders after the window and flags late payments for refund', async () => {
    const before = await reserved('P1');
    const quote = await quoteFor(b, { P1: 30 });
    const order = (await place(b, quote.id, 'prepaid')).json().order;
    const { paymentId } = (
      await app.inject({ method: 'POST', url: '/payments/session', headers: bearer(b.token), payload: { orderId: order.id } })
    ).json();
    await db.query("UPDATE orders SET payment_due_by = now() - interval '1 minute' WHERE id = $1", [order.id]);
    expect(await expireUnpaidOrders(db)).toEqual([order.orderNumber]);
    expect(await reserved('P1')).toBe(before);

    const { rows } = await db.query<{ provider_ref: string }>('SELECT provider_ref FROM payments WHERE id = $1', [paymentId]);
    const late = await webhook({ eventId: 'evt-late', providerRef: rows[0]!.provider_ref, status: 'succeeded', amountPaise: 3_410_00 });
    expect(late.json().outcome).toBe('paid_after_cancel');
    const view = (await app.inject({ method: 'GET', url: `/orders/${order.id}`, headers: bearer(b.token) })).json().order;
    expect(view).toMatchObject({ status: 'cancelled', paymentStatus: 'refund_pending' });
  });

  it('never lets two retailers order the same last units', async () => {
    // P2 has 6 units; both carts are valid when quoted.
    const [qa, qb] = [await quoteFor(a, { P1: 30, P2: 6 }), await quoteFor(b, { P1: 30, P2: 6 })];
    const results = await Promise.all([place(a, qa.id, 'cod'), place(b, qb.id, 'cod')]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409]);
    const loser = results.find((r) => r.statusCode === 409)!;
    expect(['INSUFFICIENT_STOCK', 'QUOTE_CHANGED']).toContain(loser.json().error.code);
    expect(await reserved('P2')).toBe(6);
  });
});
