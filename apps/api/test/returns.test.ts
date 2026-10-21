import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Role } from '../src/auth/sessions.js';
import type { RecordingSmsSender } from '../src/auth/sms.js';
import { createPool, withTransaction, type Db } from '../src/db.js';
import type { MemoryDocumentStore } from '../src/storage.js';
import { grantRole } from '../src/users.js';
import { resetDatabase, SAMPLE_JPEG, TEST_DATABASE_URL, testDeps } from './helpers.js';

const CATALOG = [
  'sku,name,generic_name,manufacturer,gst_rate',
  'P1,Dolo 650,Paracetamol,Micro Labs,12',
  'P2,Augmentin 625 Duo,Amoxicillin,GSK,12',
].join('\n');

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

describe.skipIf(!TEST_DATABASE_URL)('returns (integration)', () => {
  let db: Db;
  let documents: MemoryDocumentStore;
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
    documents = deps.documents;
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
    b = await retailer();
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

  async function deliveredOrder() {
    const { order, assignmentId } = await assigned();
    await post(`/delivery/assignments/${assignmentId}/start`, rider.token);
    const otp = sms.deliveryCodes.get(order.orderNumber)!;
    const res = await post(`/delivery/assignments/${assignmentId}/confirm`, rider.token, { otp, cod: { method: 'cash', amountPaise: 3_410_00 } });
    expect(res.json().delivered).toBe(true);
    return order;
  }

  const onHand = async () =>
    (await db.query<{ n: number }>("SELECT on_hand_qty AS n FROM inventory_batches WHERE batch_number = 'B1'")).rows[0]!.n;

  it('accepts returns only for delivered lines, within the window and up to what was delivered', async () => {
    const pending = await readyOrder();
    const notYet = await post('/returns', a.token, { orderId: pending.id, items: [{ productId: ids.P1, quantity: 1, reason: 'damaged' }] });
    expect(notYet.statusCode).toBe(409);

    const order = await deliveredOrder();
    expect((await post('/returns', b.token, { orderId: order.id, items: [{ productId: ids.P1, quantity: 1, reason: 'damaged' }] })).statusCode).toBe(404);
    expect((await post('/returns', a.token, { orderId: order.id, items: [{ productId: ids.P2, quantity: 1, reason: 'damaged' }] })).statusCode).toBe(400);
    const tooMany = await post('/returns', a.token, { orderId: order.id, items: [{ productId: ids.P1, quantity: 31, reason: 'damaged' }] });
    expect(tooMany.json().error).toMatchObject({ code: 'CONFLICT', details: { returnable: 30 } });

    const first = await post('/returns', a.token, {
      orderId: order.id,
      note: 'Box crushed in transit',
      items: [{ productId: ids.P1, quantity: 20, reason: 'damaged', batchNumber: 'B1' }],
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().return).toMatchObject({ status: 'requested', orderNumber: order.orderNumber, items: [expect.objectContaining({ quantity: 20 })] });
    expect(first.json().return.returnNumber).toMatch(/^RT-\d+$/);
    // Only 10 more can be returned while the first is open.
    const second = await post('/returns', a.token, { orderId: order.id, items: [{ productId: ids.P1, quantity: 11, reason: 'expired' }] });
    expect(second.json().error.details).toEqual({ productId: ids.P1, returnable: 10 });
    // Cancelling frees the quantity again.
    expect((await post(`/returns/${first.json().return.id}/cancel`, a.token)).json().return.status).toBe('cancelled');
    expect((await post('/returns', a.token, { orderId: order.id, items: [{ productId: ids.P1, quantity: 30, reason: 'expired' }] })).statusCode).toBe(201);

    // Outside the return window.
    const old = await deliveredOrder();
    await db.query("UPDATE delivery_assignments SET delivered_at = now() - interval '8 days' WHERE order_id = $1", [old.id]);
    const late = await post('/returns', a.token, { orderId: old.id, items: [{ productId: ids.P1, quantity: 1, reason: 'damaged' }] });
    expect(late.json().error).toMatchObject({ code: 'CONFLICT', details: { windowDays: 7 } });
  });

  it('runs review, pickup, inspection and close, restocking only what is fit to sell', async () => {
    const order = await deliveredOrder();
    const created = (
      await post('/returns', a.token, { orderId: order.id, items: [{ productId: ids.P1, quantity: 10, reason: 'damaged' }] })
    ).json().return;

    // Photo evidence is private and its viewing is audited.
    const upload = await app.inject({
      method: 'POST',
      url: `/returns/${created.id}/evidence`,
      headers: { ...bearer(a.token), 'content-type': 'image/jpeg' },
      payload: SAMPLE_JPEG,
    });
    expect(upload.statusCode).toBe(201);
    const spoofed = await app.inject({
      method: 'POST',
      url: `/returns/${created.id}/evidence`,
      headers: { ...bearer(a.token), 'content-type': 'image/png' },
      payload: SAMPLE_JPEG,
    });
    expect(spoofed.statusCode).toBe(400);
    expect(documents.files.size).toBeGreaterThan(0);
    const evidenceId = upload.json().id;
    expect((await get(`/admin/returns/${created.id}/evidence/${evidenceId}`, a.token)).statusCode).toBe(403);
    const view = await get(`/admin/returns/${created.id}/evidence/${evidenceId}`, support.token);
    expect(view.statusCode).toBe(200);
    expect(view.headers['content-type']).toBe('image/jpeg');

    // Nothing happens before review; only support decides.
    expect((await post(`/admin/returns/${created.id}/receive`, picker.token)).statusCode).toBe(409);
    expect((await post(`/returns/${created.id}/decision`, picker.token, { decision: 'approve', reason: 'Looks fine' })).statusCode).toBe(403);
    const approved = await post(`/returns/${created.id}/decision`, support.token, { decision: 'approve', reason: 'Photos show crushed strips' });
    expect(approved.json().return.status).toBe('approved');
    // Evidence is locked once reviewed.
    const lateUpload = await app.inject({
      method: 'POST',
      url: `/returns/${created.id}/evidence`,
      headers: { ...bearer(a.token), 'content-type': 'image/jpeg' },
      payload: SAMPLE_JPEG,
    });
    expect(lateUpload.statusCode).toBe(409);

    expect((await post(`/admin/returns/${created.id}/pickup`, dispatcher.token, { riderUserId: picker.userId, pickupDate: inDays(1) })).statusCode).toBe(400);
    const pickup = await post(`/admin/returns/${created.id}/pickup`, dispatcher.token, { riderUserId: rider.userId, pickupDate: inDays(1) });
    expect(pickup.json().return).toMatchObject({ status: 'pickup_scheduled', pickupRiderUserId: rider.userId });
    expect((await post(`/admin/returns/${created.id}/receive`, picker.token)).json().return.status).toBe('received');

    const item = (await get(`/admin/returns/${created.id}`, picker.token)).json().return.items[0];
    const before = await onHand();
    const noRef = await post(`/admin/returns/${created.id}/inspection`, picker.token, {
      grReference: 'GR/88',
      resolution: 'credit_note',
      items: [{ itemId: item.id, acceptedQty: 10, disposition: 'destroy' }],
    });
    expect(noRef.statusCode).toBe(400);
    const noBatch = await post(`/admin/returns/${created.id}/inspection`, picker.token, {
      grReference: 'GR/88',
      resolution: 'credit_note',
      resolutionReference: 'CN/12',
      items: [{ itemId: item.id, acceptedQty: 4, disposition: 'restock' }],
    });
    expect(noBatch.statusCode).toBe(400);
    const closed = await post(`/admin/returns/${created.id}/inspection`, picker.token, {
      grReference: 'GR/88',
      resolution: 'credit_note',
      resolutionReference: 'CN/12',
      items: [{ itemId: item.id, acceptedQty: 4, disposition: 'restock', batchNumber: 'B1', note: '4 strips undamaged' }],
    });
    expect(closed.json().return).toMatchObject({ status: 'closed', grReference: 'GR/88', resolution: 'credit_note', resolutionReference: 'CN/12' });
    expect(await onHand()).toBe(before + 4);

    // The retailer sees the outcome, not internal dispositions or notes.
    const mine = (await get(`/returns/${created.id}`, a.token)).json().return;
    expect(mine).toMatchObject({ status: 'closed', resolution: 'credit_note', resolutionReference: 'CN/12' });
    expect(JSON.stringify(mine)).not.toMatch(/restock|undamaged|GR\/88/);
    const audit = await db.query("SELECT action FROM audit_logs WHERE entity_type = 'return_request' AND entity_id = $1 ORDER BY occurred_at", [created.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['return.decision', 'return.pickup_schedule', 'return.receive', 'return.inspect_close']);
  });

  it('records rejections with a reason the retailer can see', async () => {
    const order = await deliveredOrder();
    const created = (
      await post('/returns', a.token, { orderId: order.id, items: [{ productId: ids.P1, quantity: 5, reason: 'excess_supply' }] })
    ).json().return;
    const rejected = await post(`/returns/${created.id}/decision`, support.token, { decision: 'reject', reason: 'Excess stock is not returnable' });
    expect(rejected.json().return.status).toBe('rejected');
    expect((await get('/returns', a.token)).json().items.find((r: { id: string }) => r.id === created.id)).toMatchObject({
      status: 'rejected',
      decisionReason: 'Excess stock is not returnable',
    });
    expect((await get('/returns', b.token)).json().items).toEqual([]);
    expect((await get('/admin/returns', a.token)).statusCode).toBe(403);
  });
});
