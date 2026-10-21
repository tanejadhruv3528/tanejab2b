import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Role } from '../src/auth/sessions.js';
import type { RecordingSmsSender } from '../src/auth/sms.js';
import { createPool, withTransaction, type Db } from '../src/db.js';
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

describe.skipIf(!TEST_DATABASE_URL)('delivery and COD collection (integration)', () => {
  let db: Db;
  let app: FastifyInstance;
  let sms: RecordingSmsSender;
  let counter = 0;
  let operator: { token: string; userId: string };
  let support: { token: string; userId: string };
  let picker: { token: string; userId: string };
  let billing: { token: string; userId: string };
  let dispatcher: { token: string; userId: string };
  let rider: { token: string; userId: string };
  let rider2: { token: string; userId: string };
  let finance: { token: string; userId: string };
  let a: Retailer;
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

  const post = (url: string, token: string, payload?: object) =>
    app.inject({ method: 'POST', url, headers: bearer(token), ...(payload ? { payload } : {}) });
  const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: bearer(token) });
  const PACKED = { packageCount: 1, checklist: { quantitiesMatch: true, batchAndExpiryChecked: true, sealedAndLabelled: true } };
  let invoiceSeq = 0;

  /** A COD order taken all the way through the warehouse to ready_for_dispatch. */
  async function readyOrder() {
    const quote = await quoteFor(a, { P1: 30 });
    const order = (await place(a, quote.id, 'cod')).json().order;
    await post(`/admin/orders/${order.id}/accept`, support.token);
    const tasks = (await get('/warehouse/tasks', picker.token)).json().items;
    const taskId = tasks.find((t: { orderId: string }) => t.orderId === order.id).id;
    await post(`/warehouse/tasks/${taskId}/start`, picker.token);
    const lines = (await get(`/warehouse/tasks/${taskId}`, picker.token)).json().task.lines.map(
      (l: { id: string; expectedQty: number }) => ({ lineId: l.id, pickedQty: l.expectedQty }),
    );
    await post(`/warehouse/tasks/${taskId}/pick-confirmation`, picker.token, { lines });
    await post(`/warehouse/tasks/${taskId}/pack-confirmation`, picker.token, PACKED);
    const inv = await post(`/billing/orders/${order.id}/invoice`, billing.token, { invoiceNumber: `INV-${++invoiceSeq}`, amountPaise: 3_410_00 });
    expect(inv.json().order.status).toBe('ready_for_dispatch');
    return order as { id: string; orderNumber: string };
  }

  async function assigned(riderUser = rider) {
    const order = await readyOrder();
    const res = await post('/dispatch/assignments', dispatcher.token, { orderId: order.id, riderUserId: riderUser.userId });
    expect(res.statusCode).toBe(201);
    return { order, assignmentId: res.json().assignmentId as string };
  }

  async function orderView(id: string) {
    return (await get(`/admin/orders/${id}`, support.token)).json().order;
  }

  beforeAll(async () => {
    db = createPool({ databaseUrl: TEST_DATABASE_URL!, databaseSsl: false });
    await resetDatabase(db);
    const deps = testDeps(db);
    sms = deps.sms;
    app = await buildApp(deps);
    operator = await withRole('catalog_operator');
    support = await withRole('support_operator');
    picker = await withRole('picker_packer');
    billing = await withRole('billing_operator');
    dispatcher = await withRole('dispatcher');
    rider = await withRole('rider');
    rider2 = await withRole('rider');
    finance = await withRole('finance_admin');
    a = await retailer();
    await app.inject({
      method: 'POST',
      url: '/admin/catalog/imports?source=manual_entry&dryRun=false',
      headers: { ...bearer(operator.token), 'content-type': 'text/csv' },
      payload: CATALOG,
    });
    const { rows } = await db.query<{ sku: string; id: string }>('SELECT sku, id FROM products');
    for (const r of rows) ids[r.sku] = r.id;
    const stock = ['sku,batch,expiry,qty,mrp,rate', `P1,B1,${inDays(300)},1000,120.00,100.00`].join('\n');
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
    await db?.end();
  });

  it('assigns only ready orders to active riders, and riders see only their own stops', async () => {
    const order = await readyOrder();
    expect((await post('/dispatch/assignments', rider.token, { orderId: order.id, riderUserId: rider.userId })).statusCode).toBe(403);
    expect((await post('/dispatch/assignments', dispatcher.token, { orderId: order.id, riderUserId: picker.userId })).statusCode).toBe(400);
    const res = await post('/dispatch/assignments', dispatcher.token, { orderId: order.id, riderUserId: rider.userId });
    expect(res.json().order.status).toBe('assigned_to_rider');
    // Already assigned: not ready for dispatch any more.
    expect((await post('/dispatch/assignments', dispatcher.token, { orderId: order.id, riderUserId: rider2.userId })).statusCode).toBe(409);

    const riders = (await get('/dispatch/riders', dispatcher.token)).json().items;
    expect(riders.map((r: { id: string }) => r.id).sort()).toEqual([rider.userId, rider2.userId].sort());
    expect(riders.find((r: { id: string }) => r.id === rider.userId).liveStops).toBe(1);
    expect((await get('/dispatch/riders', rider.token)).statusCode).toBe(403);

    const stops = (await get('/delivery/assignments', rider.token)).json();
    expect(stops.deliveryWindow).toEqual({ start: '13:00', end: '20:00' });
    expect(stops.items).toEqual([
      expect.objectContaining({
        orderNumber: order.orderNumber,
        businessName: 'Test Pharmacy',
        paymentMethod: 'cod',
        collectPaise: 3_410_00,
        packageCount: 1,
        otpAttemptsLeft: 5,
        items: [{ name: 'Dolo 650', packSize: null, quantity: 30 }],
        deliveryAddress: expect.objectContaining({ city: 'Samastipur', postalCode: '848101' }),
      }),
    ]);
    // Riders get the amount to collect, never line prices or costs.
    expect(JSON.stringify(stops.items)).not.toMatch(/totalPaise|valuePaise|ratePaise|cost/);
    expect((await get('/delivery/assignments', rider2.token)).json().items).toEqual([]);
    const assignmentId = res.json().assignmentId;
    expect((await post(`/delivery/assignments/${assignmentId}/start`, rider2.token)).statusCode).toBe(404);
    expect((await get('/delivery/assignments', dispatcher.token)).statusCode).toBe(403);

    // Unassigning puts it back in the dispatch queue.
    await post(`/dispatch/assignments/${assignmentId}/cancel`, dispatcher.token, { reason: 'Rider bike broke down' });
    expect((await orderView(order.id)).status).toBe('ready_for_dispatch');
    expect((await get('/delivery/assignments', rider.token)).json().items).toEqual([]);
  });

  it('confirms delivery only with the retailer’s code and records exact COD as collected', async () => {
    const { order, assignmentId } = await assigned();
    expect((await post(`/delivery/assignments/${assignmentId}/confirm`, rider.token, { otp: '123456' })).statusCode).toBe(409);
    expect((await post(`/delivery/assignments/${assignmentId}/start`, rider.token)).statusCode).toBe(200);
    expect((await orderView(order.id)).status).toBe('out_for_delivery');
    const code = sms.deliveryCodes.get(order.orderNumber)!;
    expect(code).toMatch(/^\d{6}$/);

    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await post(`/delivery/assignments/${assignmentId}/confirm`, rider.token, { otp: wrong, cod: { method: 'cash', amountPaise: 3_410_00 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatchObject({ code: 'OTP_INVALID', details: { attemptsLeft: 4 } });
    expect((await post(`/delivery/assignments/${assignmentId}/confirm`, rider.token, { otp: code })).statusCode).toBe(400);
    expect(
      (await post(`/delivery/assignments/${assignmentId}/confirm`, rider.token, { otp: code, cod: { method: 'upi', amountPaise: 3_410_00 } })).statusCode,
    ).toBe(400);

    const ok = await post(`/delivery/assignments/${assignmentId}/confirm`, rider.token, { otp: code, cod: { method: 'cash', amountPaise: 3_410_00 } });
    expect(ok.json()).toEqual({ delivered: true, collection: { expectedPaise: 3_410_00, collectedPaise: 3_410_00, matches: true } });
    expect(await orderView(order.id)).toMatchObject({ status: 'delivered', paymentStatus: 'cod_collected' });
    // The code cannot be used twice.
    expect((await post(`/delivery/assignments/${assignmentId}/confirm`, rider.token, { otp: code })).statusCode).toBe(409);

    expect((await get('/finance/cod-collections', rider.token)).statusCode).toBe(403);
    const collections = (await get('/finance/cod-collections?status=collected', finance.token)).json().items;
    const mine = collections.find((c: { orderId: string }) => c.orderId === order.id);
    expect(mine).toMatchObject({ method: 'cash', expectedPaise: 3_410_00, collectedPaise: 3_410_00, riderUserId: rider.userId });
    const rec = await post(`/finance/cod-collections/${mine.id}/reconcile`, finance.token, { handedOverPaise: 3_410_00 });
    expect(rec.json()).toEqual({ status: 'reconciled' });
    expect((await post(`/finance/cod-collections/${mine.id}/reconcile`, finance.token, { handedOverPaise: 3_410_00 })).statusCode).toBe(409);
  });

  it('treats a short COD collection as a discrepancy, never a changed order total', async () => {
    const { order, assignmentId } = await assigned();
    await post(`/delivery/assignments/${assignmentId}/start`, rider.token);
    const code = sms.deliveryCodes.get(order.orderNumber)!;
    const res = await post(`/delivery/assignments/${assignmentId}/confirm`, rider.token, {
      otp: code,
      cod: { method: 'upi', amountPaise: 3_000_00, upiReference: 'UPI4471230011' },
    });
    expect(res.json().collection).toEqual({ expectedPaise: 3_410_00, collectedPaise: 3_000_00, matches: false });
    expect(await orderView(order.id)).toMatchObject({ status: 'delivered', paymentStatus: 'cod_due', payablePaise: 3_410_00 });

    const c = (await get('/finance/cod-collections?status=discrepancy', finance.token)).json().items.find(
      (x: { orderId: string }) => x.orderId === order.id,
    );
    expect(c).toMatchObject({ method: 'upi', upiReference: 'UPI4471230011' });
    expect((await post(`/finance/cod-collections/${c.id}/reconcile`, finance.token, { handedOverPaise: 3_000_00 })).statusCode).toBe(400);
    const noted = await post(`/finance/cod-collections/${c.id}/reconcile`, finance.token, {
      handedOverPaise: 3_000_00,
      note: 'Retailer to pay ₹410 balance with next order',
    });
    expect(noted.json()).toEqual({ status: 'discrepancy' });
    const audit = await db.query("SELECT reason FROM audit_logs WHERE action = 'finance.cod_reconcile' AND entity_id = $1", [c.id]);
    expect(audit.rows).toEqual([{ reason: 'Retailer to pay ₹410 balance with next order' }]);
  });

  it('locks the code after five wrong tries until the retailer asks for a new one', async () => {
    const { order, assignmentId } = await assigned();
    await post(`/delivery/assignments/${assignmentId}/start`, rider.token);
    const first = sms.deliveryCodes.get(order.orderNumber)!;
    const wrong = first === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) await post(`/delivery/assignments/${assignmentId}/confirm`, rider.token, { otp: wrong });
    const locked = await post(`/delivery/assignments/${assignmentId}/confirm`, rider.token, {
      otp: first,
      cod: { method: 'cash', amountPaise: 3_410_00 },
    });
    expect(locked.json().error.code).toBe('OTP_TOO_MANY_ATTEMPTS');

    expect((await post(`/orders/${order.id}/delivery-otp`, rider.token)).statusCode).toBe(403);
    expect((await post(`/orders/${order.id}/delivery-otp`, a.token)).json()).toEqual({ sent: true });
    const second = sms.deliveryCodes.get(order.orderNumber)!;
    // The old code is dead once a new one is sent (unless the random code repeats).
    if (second !== first) {
      expect(
        (await post(`/delivery/assignments/${assignmentId}/confirm`, rider.token, { otp: first, cod: { method: 'cash', amountPaise: 3_410_00 } })).json()
          .error.code,
      ).toBe('OTP_INVALID');
    }
    const ok = await post(`/delivery/assignments/${assignmentId}/confirm`, rider.token, { otp: second, cod: { method: 'cash', amountPaise: 3_410_00 } });
    expect(ok.json().delivered).toBe(true);
  });

  it('records failed attempts and lets dispatch send the order out again', async () => {
    const { order, assignmentId } = await assigned();
    await post(`/delivery/assignments/${assignmentId}/start`, rider.token);
    expect((await post(`/delivery/assignments/${assignmentId}/fail`, rider.token, { reason: 'closed' })).statusCode).toBe(400);
    const failed = await post(`/delivery/assignments/${assignmentId}/fail`, rider.token, { reason: 'store_closed', note: 'Shutter down at 3 PM' });
    expect(failed.statusCode).toBe(200);
    expect((await orderView(order.id)).status).toBe('delivery_failed');
    const audit = await db.query("SELECT reason FROM audit_logs WHERE action = 'delivery.fail' AND entity_id = $1", [assignmentId]);
    expect(audit.rows).toEqual([{ reason: 'store_closed: Shutter down at 3 PM' }]);
    // The retailer sees the failed attempt in their history.
    const mine = (await get(`/orders/${order.id}`, a.token)).json().order;
    expect(mine.events.at(-1)).toMatchObject({ to: 'delivery_failed', note: 'Delivery attempt failed: store closed' });

    expect((await post('/dispatch/assignments', dispatcher.token, { orderId: order.id, riderUserId: rider2.userId })).statusCode).toBe(409);
    await post(`/dispatch/orders/${order.id}/redispatch`, dispatcher.token, { reason: 'Retailer open tomorrow' });
    const again = await post('/dispatch/assignments', dispatcher.token, { orderId: order.id, riderUserId: rider2.userId });
    expect(again.statusCode).toBe(201);
    const history = (await get('/dispatch/assignments', dispatcher.token)).json().items.filter((x: { orderId: string }) => x.orderId === order.id);
    expect(history.map((x: { status: string }) => x.status)).toEqual(['assigned', 'failed']);
  });

  it('collects nothing on delivery for a prepaid order', async () => {
    const { order, assignmentId } = await assigned();
    await db.query("UPDATE orders SET payment_method = 'prepaid', payment_status = 'paid' WHERE id = $1", [order.id]);
    expect((await get('/delivery/assignments', rider.token)).json().items.find((x: { id: string }) => x.id === assignmentId).collectPaise).toBe(0);
    await post(`/delivery/assignments/${assignmentId}/start`, rider.token);
    const code = sms.deliveryCodes.get(order.orderNumber)!;
    expect(
      (await post(`/delivery/assignments/${assignmentId}/confirm`, rider.token, { otp: code, cod: { method: 'cash', amountPaise: 1 } })).statusCode,
    ).toBe(400);
    expect((await post(`/delivery/assignments/${assignmentId}/confirm`, rider.token, { otp: code })).json()).toEqual({ delivered: true, collection: null });
    expect(await orderView(order.id)).toMatchObject({ status: 'delivered', paymentStatus: 'paid' });
  });
});
