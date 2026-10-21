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

describe.skipIf(!TEST_DATABASE_URL)('warehouse pick, pack and invoice (integration)', () => {
  let db: Db;
  let app: FastifyInstance;
  let sms: RecordingSmsSender;
  let counter = 0;
  let operator: { token: string; userId: string };
  let support: { token: string; userId: string };
  let picker: { token: string; userId: string };
  let billing: { token: string; userId: string };
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

  async function batch(sku: string, batchNumber: string) {
    const { rows } = await db.query<{ id: string; on_hand: number; reserved: number; quarantined: number }>(
      `SELECT id, on_hand_qty AS on_hand, reserved_qty AS reserved, quarantined_qty AS quarantined
       FROM inventory_batches WHERE product_id = $1 AND batch_number = $2`,
      [ids[sku], batchNumber],
    );
    return rows[0]!;
  }

  async function acceptedOrder(items: Record<string, number>) {
    const quote = await quoteFor(a, items);
    const order = (await place(a, quote.id, 'cod')).json().order;
    const res = await app.inject({ method: 'POST', url: `/admin/orders/${order.id}/accept`, headers: bearer(support.token) });
    expect(res.statusCode).toBe(200);
    const tasks = (await app.inject({ method: 'GET', url: '/warehouse/tasks', headers: bearer(picker.token) })).json().items;
    const task = tasks.find((t: { orderId: string }) => t.orderId === order.id);
    return { order, taskId: task.id as string };
  }

  const post = (url: string, token: string, payload?: object) =>
    app.inject({ method: 'POST', url, headers: bearer(token), ...(payload ? { payload } : {}) });
  const task = async (id: string) =>
    (await app.inject({ method: 'GET', url: `/warehouse/tasks/${id}`, headers: bearer(picker.token) })).json().task;
  const PACKED = { packageCount: 2, checklist: { quantitiesMatch: true, batchAndExpiryChecked: true, sealedAndLabelled: true } };

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
    a = await retailer();
    await app.inject({
      method: 'POST',
      url: '/admin/catalog/imports?source=manual_entry&dryRun=false',
      headers: { ...bearer(operator.token), 'content-type': 'text/csv' },
      payload: CATALOG,
    });
    const { rows } = await db.query<{ sku: string; id: string }>('SELECT sku, id FROM products');
    for (const r of rows) ids[r.sku] = r.id;
    const stock = [
      'sku,batch,expiry,qty,mrp,rate',
      `P1,B1,${inDays(200)},20,120.00,100.00`,
      `P1,B2,${inDays(300)},1000,120.00,100.00`,
      `P2,A1,${inDays(300)},60,250.00,100.00`,
    ].join('\n');
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

  it('keeps warehouse and billing actions to their roles', async () => {
    const { order, taskId } = await acceptedOrder({ P1: 30 });
    expect((await app.inject({ method: 'GET', url: '/warehouse/tasks', headers: bearer(a.token) })).statusCode).toBe(403);
    expect((await post(`/warehouse/tasks/${taskId}/start`, billing.token)).statusCode).toBe(403);
    expect((await post(`/warehouse/tasks/${taskId}/start`, support.token)).statusCode).toBe(403);
    expect((await post(`/billing/orders/${order.id}/invoice`, picker.token, { invoiceNumber: 'X1', amountPaise: 1 })).statusCode).toBe(403);
    expect((await post(`/admin/orders/${order.id}/short-pick/reallocate`, picker.token, { reason: 'try' })).statusCode).toBe(403);
    await post(`/admin/orders/${order.id}/cancel`, support.token, { reason: 'Test cleanup' });
    expect((await task(taskId)).status).toBe('cancelled');
  });

  it('picks earliest expiry first, packs with a full checklist and records the Marg invoice', async () => {
    const before = { b1: await batch('P1', 'B1'), b2: await batch('P1', 'B2') };
    const { order, taskId } = await acceptedOrder({ P1: 30 });
    let t = await task(taskId);
    expect(t).toMatchObject({ status: 'open', orderNumber: order.orderNumber, orderStatus: 'accepted' });
    expect(t.lines.map((l: { batchNumber: string; expectedQty: number }) => [l.batchNumber, l.expectedQty])).toEqual([
      ['B1', 20],
      ['B2', 10],
    ]);
    // Pickers see goods, not money.
    expect(JSON.stringify(t)).not.toMatch(/paise|rate/i);

    expect((await post(`/warehouse/tasks/${taskId}/pack-confirmation`, picker.token, PACKED)).statusCode).toBe(409);
    expect((await post(`/warehouse/tasks/${taskId}/start`, picker.token)).statusCode).toBe(200);
    expect((await post(`/warehouse/tasks/${taskId}/start`, picker.token)).statusCode).toBe(409);
    t = await task(taskId);
    expect(t).toMatchObject({ status: 'picking', orderStatus: 'picking', assignedTo: picker.userId });

    const [l1, l2] = t.lines;
    const partial = await post(`/warehouse/tasks/${taskId}/pick-confirmation`, picker.token, { lines: [{ lineId: l1.id, pickedQty: 20 }] });
    expect(partial.statusCode).toBe(400);
    const tooMany = await post(`/warehouse/tasks/${taskId}/pick-confirmation`, picker.token, {
      lines: [{ lineId: l1.id, pickedQty: 21 }, { lineId: l2.id, pickedQty: 10 }],
    });
    expect(tooMany.statusCode).toBe(400);
    const picked = await post(`/warehouse/tasks/${taskId}/pick-confirmation`, picker.token, {
      lines: [{ lineId: l1.id, pickedQty: 20 }, { lineId: l2.id, pickedQty: 10 }],
    });
    expect(picked.json().task).toMatchObject({ status: 'picked', orderStatus: 'picking' });

    const unticked = { ...PACKED, checklist: { ...PACKED.checklist, sealedAndLabelled: false } };
    expect((await post(`/warehouse/tasks/${taskId}/pack-confirmation`, picker.token, unticked)).statusCode).toBe(400);
    const packed = await post(`/warehouse/tasks/${taskId}/pack-confirmation`, picker.token, PACKED);
    expect(packed.json().task).toMatchObject({ status: 'packed', orderStatus: 'packed', packageCount: 2, packedBy: picker.userId });

    const wrong = await post(`/billing/orders/${order.id}/invoice`, billing.token, { invoiceNumber: 'GST/1001', amountPaise: 3_400_00 });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.details).toEqual({ payablePaise: 3_410_00, invoiceAmountPaise: 3_400_00 });
    const invoiced = await post(`/billing/orders/${order.id}/invoice`, billing.token, { invoiceNumber: 'GST/1001', amountPaise: 3_410_00 });
    expect(invoiced.statusCode).toBe(201);
    expect(invoiced.json().order).toMatchObject({
      status: 'ready_for_dispatch',
      invoice: { invoiceNumber: 'GST/1001', amountPaise: 3_410_00 },
    });

    // Invoiced units leave both reserved and on-hand stock.
    const after = { b1: await batch('P1', 'B1'), b2: await batch('P1', 'B2') };
    expect(after.b1).toMatchObject({ on_hand: before.b1.on_hand - 20, reserved: before.b1.reserved });
    expect(after.b2).toMatchObject({ on_hand: before.b2.on_hand - 10, reserved: before.b2.reserved });

    // An invoice number can only be used once.
    const next = await acceptedOrder({ P1: 30 });
    await post(`/warehouse/tasks/${next.taskId}/start`, picker.token);
    const lines = (await task(next.taskId)).lines.map((l: { id: string; expectedQty: number }) => ({ lineId: l.id, pickedQty: l.expectedQty }));
    await post(`/warehouse/tasks/${next.taskId}/pick-confirmation`, picker.token, { lines });
    await post(`/warehouse/tasks/${next.taskId}/pack-confirmation`, picker.token, PACKED);
    const dup = await post(`/billing/orders/${next.order.id}/invoice`, billing.token, { invoiceNumber: 'GST/1001', amountPaise: 3_410_00 });
    expect(dup.statusCode).toBe(409);
    const accepted = await post(`/billing/orders/${next.order.id}/invoice`, billing.token, {
      invoiceNumber: 'GST/1002',
      amountPaise: 3_410_00 - 40,
      mismatchReason: 'Marg rounded off the total',
    });
    expect(accepted.statusCode).toBe(201);

    const audit = await db.query(
      "SELECT action FROM audit_logs WHERE entity_type = 'warehouse_task' AND entity_id = $1 ORDER BY occurred_at",
      [taskId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['warehouse.pick_start', 'warehouse.pick_confirm', 'warehouse.pack_confirm']);
  });

  it('turns a short pick into a review, quarantines the shortfall and re-allocates from another batch', async () => {
    const before = { b1: await batch('P1', 'B1'), b2: await batch('P1', 'B2') };
    expect(before.b1.on_hand - before.b1.reserved).toBe(0);
    // B1 is used up, so put stock back to force a two-batch pick.
    await db.query("UPDATE inventory_batches SET on_hand_qty = on_hand_qty + 20 WHERE id = $1", [before.b1.id]);
    const { order, taskId } = await acceptedOrder({ P1: 30 });
    await post(`/warehouse/tasks/${taskId}/start`, picker.token);
    const [l1, l2] = (await task(taskId)).lines;
    expect(l1).toMatchObject({ batchNumber: 'B1', expectedQty: 20 });

    const noReason = await post(`/warehouse/tasks/${taskId}/pick-confirmation`, picker.token, {
      lines: [{ lineId: l1.id, pickedQty: 15 }, { lineId: l2.id, pickedQty: 10 }],
    });
    expect(noReason.statusCode).toBe(400);
    const short = await post(`/warehouse/tasks/${taskId}/pick-confirmation`, picker.token, {
      lines: [{ lineId: l1.id, pickedQty: 15, shortReason: 'damaged', shortNote: 'Strips crushed' }, { lineId: l2.id, pickedQty: 10 }],
    });
    expect(short.json().task).toMatchObject({ status: 'short_pick', orderStatus: 'short_pick_review' });
    const b1 = await batch('P1', 'B1');
    expect(b1).toMatchObject({ reserved: before.b1.reserved + 15, quarantined: 5 });

    // The retailer sees that the order is under review, not the warehouse detail.
    const mine = (await app.inject({ method: 'GET', url: `/orders/${order.id}`, headers: bearer(a.token) })).json().order;
    expect(mine.status).toBe('short_pick_review');
    expect(JSON.stringify(mine)).not.toMatch(/damaged|crushed|B1/);

    // Packing waits for the review.
    expect((await post(`/warehouse/tasks/${taskId}/pick-confirmation`, picker.token, { lines: [{ lineId: l1.id, pickedQty: 5 }] })).statusCode).toBe(409);

    const realloc = await post(`/admin/orders/${order.id}/short-pick/reallocate`, support.token, { reason: 'Use next batch' });
    expect(realloc.statusCode).toBe(200);
    expect(realloc.json().order.status).toBe('picking');
    const t = await task(taskId);
    const fresh = t.lines.filter((l: { confirmedAt: string | null }) => !l.confirmedAt);
    // Never the damaged batch again, and always the same product.
    expect(fresh.map((l: { batchNumber: string; expectedQty: number; sku: string }) => [l.sku, l.batchNumber, l.expectedQty])).toEqual([
      ['P1', 'B2', 5],
    ]);
    expect((await batch('P1', 'B2')).reserved).toBe(before.b2.reserved + 15);

    const done = await post(`/warehouse/tasks/${taskId}/pick-confirmation`, picker.token, { lines: [{ lineId: fresh[0].id, pickedQty: 5 }] });
    expect(done.json().task.status).toBe('picked');
    const allocations = (await app.inject({ method: 'GET', url: `/admin/orders/${order.id}`, headers: bearer(support.token) })).json().order
      .allocations;
    const live = allocations.filter((x: { releasedAt: string | null }) => !x.releasedAt);
    expect(live.reduce((n: number, x: { quantity: number }) => n + x.quantity, 0)).toBe(30);

    // A stock check puts usable quarantined units back on sale; it cannot release more than is held.
    const tooMuch = await post(`/admin/inventory/batches/${b1.id}/quarantine/release`, operator.token, { quantity: 6, reason: 'Recount' });
    expect(tooMuch.statusCode).toBe(409);
    expect((await post(`/admin/inventory/batches/${b1.id}/quarantine/release`, picker.token, { quantity: 5, reason: 'Recount' })).statusCode).toBe(403);
    const released = await post(`/admin/inventory/batches/${b1.id}/quarantine/release`, operator.token, { quantity: 2, reason: 'Two strips fine' });
    expect(released.json()).toEqual({ batchId: b1.id, quarantined: 3 });

    const audit = await db.query("SELECT action FROM audit_logs WHERE action IN ('warehouse.short_pick', 'order.short_pick_reallocate')");
    expect(audit.rows.map((r) => r.action).sort()).toEqual(['order.short_pick_reallocate', 'warehouse.short_pick']);
  });

  it('cancels a short-picked order when no other stock exists, releasing what was reserved', async () => {
    const { order, taskId } = await acceptedOrder({ P2: 30 });
    await post(`/warehouse/tasks/${taskId}/start`, picker.token);
    const [line] = (await task(taskId)).lines;
    await post(`/warehouse/tasks/${taskId}/pick-confirmation`, picker.token, {
      lines: [{ lineId: line.id, pickedQty: 20, shortReason: 'not_found' }],
    });
    const realloc = await post(`/admin/orders/${order.id}/short-pick/reallocate`, support.token, { reason: 'Try other batches' });
    expect(realloc.statusCode).toBe(409);
    expect(realloc.json().error.code).toBe('INSUFFICIENT_STOCK');
    expect((await task(taskId)).status).toBe('short_pick');

    const cancelled = await post(`/admin/orders/${order.id}/cancel`, support.token, { reason: 'Item short, retailer informed' });
    expect(cancelled.json().order).toMatchObject({ status: 'cancelled', paymentStatus: 'not_charged' });
    expect(await batch('P2', 'A1')).toMatchObject({ reserved: 0, quarantined: 10 });
    expect((await task(taskId)).status).toBe('cancelled');
  });

  it('pauses picking while a cancellation request is open and resumes when staff decline it', async () => {
    const { order, taskId } = await acceptedOrder({ P2: 30 });
    await post(`/warehouse/tasks/${taskId}/start`, picker.token);
    expect((await post(`/orders/${order.id}/cancel-request`, a.token, { reason: 'Changed my mind' })).json().result).toBe('cancel_requested');
    const lines = (await task(taskId)).lines.map((l: { id: string; expectedQty: number }) => ({ lineId: l.id, pickedQty: l.expectedQty }));
    const blocked = await post(`/warehouse/tasks/${taskId}/pick-confirmation`, picker.token, { lines });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.details).toEqual({ orderStatus: 'cancel_requested' });

    expect((await post(`/admin/orders/${order.id}/cancel-request/decline`, picker.token, { reason: 'Already packed' })).statusCode).toBe(403);
    const declined = await post(`/admin/orders/${order.id}/cancel-request/decline`, support.token, { reason: 'Retailer confirmed by phone' });
    expect(declined.json().order.status).toBe('picking');
    expect((await post(`/admin/orders/${order.id}/cancel-request/decline`, support.token, { reason: 'Again' })).statusCode).toBe(409);
    expect((await post(`/warehouse/tasks/${taskId}/pick-confirmation`, picker.token, { lines })).json().task.status).toBe('picked');
  });
});
