import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Role } from '../src/auth/sessions.js';
import type { RecordingSmsSender } from '../src/auth/sms.js';
import { createPool, withTransaction, type Db } from '../src/db.js';
import { grantRole } from '../src/users.js';
import { resetDatabase, TEST_DATABASE_URL, testDeps } from './helpers.js';

const CATALOG = [
  'sku,name,generic_name,manufacturer,gst_rate,cold_chain',
  'P1,Dolo 650,Paracetamol,Micro Labs,12,no',
  'P2,Augmentin 625 Duo,Amoxicillin,GSK,12,no',
  'P3,Human Insulin,Insulin,Novo Nordisk,5,yes',
].join('\n');

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

describe.skipIf(!TEST_DATABASE_URL)('procurement and special orders (integration)', () => {
  let db: Db;
  let app: FastifyInstance;
  let sms: RecordingSmsSender;
  let counter = 0;
  let operator: { token: string; userId: string };
  let support: { token: string; userId: string };
  let picker: { token: string; userId: string };
  let buyer: { token: string; userId: string };
  let a: Retailer;
  let b: Retailer;
  const ids: Record<string, string> = {};

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
  const post = (url: string, token: string, payload?: object) =>
    app.inject({ method: 'POST', url, headers: bearer(token), ...(payload ? { payload } : {}) });
  const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: bearer(token) });
  const mine = async (r: Retailer) => (await get('/special-orders', r.token)).json().items;

  beforeAll(async () => {
    db = createPool({ databaseUrl: TEST_DATABASE_URL!, databaseSsl: false });
    await resetDatabase(db);
    const deps = testDeps(db);
    sms = deps.sms;
    app = await buildApp(deps);
    operator = await withRole('catalog_operator');
    picker = await withRole('picker_packer');
    buyer = await withRole('procurement');
    a = await retailer();
    b = await retailer();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/catalog/imports?source=manual_entry&dryRun=false',
      headers: { ...bearer(operator.token), 'content-type': 'text/csv' },
      payload: CATALOG,
    });
    expect(res.statusCode).toBe(201);
    const { rows } = await db.query<{ sku: string; id: string }>('SELECT sku, id FROM products');
    for (const r of rows) ids[r.sku] = r.id;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it('lets retailers request special orders with the ETA shown as to be confirmed', async () => {
    const byProduct = await post('/special-orders', a.token, { productId: ids.P2, quantity: 10, note: 'Needed this week' });
    expect(byProduct.statusCode).toBe(201);
    expect(byProduct.json().request).toMatchObject({
      name: 'Augmentin 625 Duo',
      quantity: 10,
      status: 'open',
      etaDate: null,
      etaConfirmed: false,
    });
    expect(byProduct.json().request.requestNumber).toMatch(/^SR-\d+$/);
    const typed = await post('/special-orders', a.token, { requestedName: 'Dolo 650 strip', quantity: 5 });
    expect(typed.json().request).toMatchObject({ name: 'Dolo 650 strip', productId: null });

    expect((await post('/special-orders', a.token, { quantity: 5 })).statusCode).toBe(400);
    const cold = await post('/special-orders', a.token, { productId: ids.P3, quantity: 1 });
    expect(cold.statusCode).toBe(409);
    expect((await post('/special-orders', operator.token, { productId: ids.P2, quantity: 1 })).statusCode).toBe(403);

    // Retailers see only their own requests and cannot reach the procurement desk.
    expect(await mine(b)).toEqual([]);
    expect((await post(`/special-orders/${byProduct.json().request.id}/cancel`, b.token)).statusCode).toBe(404);
    expect((await get('/procurement/requests', a.token)).statusCode).toBe(403);
    expect((await get('/procurement/requests', picker.token)).statusCode).toBe(403);
    expect((await get('/procurement/suppliers', a.token)).statusCode).toBe(403);
  });

  it('orders from a supplier, confirms the ETA and checks goods in at the warehouse', async () => {
    const queue = (await get('/procurement/requests?status=open', buyer.token)).json().items;
    const forP2 = queue.find((r: { productId: string | null }) => r.productId === ids.P2);
    const typed = queue.find((r: { productId: string | null }) => r.productId === null);
    expect(typed).toMatchObject({ requestedName: 'Dolo 650 strip', businessName: 'Test Pharmacy' });

    const supplier = await post('/procurement/suppliers', buyer.token, { name: 'Patna Pharma Distributors', gstin: '10ABCDE1234F1Z5' });
    expect(supplier.statusCode).toBe(201);
    expect((await post('/procurement/suppliers', buyer.token, { name: 'Patna Pharma Distributors' })).statusCode).toBe(409);
    const supplierId = supplier.json().id;

    // The line product must match a request that already names one.
    const mismatched = await post('/procurement/purchase-orders', buyer.token, {
      supplierId,
      items: [{ productId: ids.P1, quantity: 10, unitCostPaise: 80_00, requestId: forP2.id }],
    });
    expect(mismatched.statusCode).toBe(400);
    const created = await post('/procurement/purchase-orders', buyer.token, {
      supplierId,
      items: [
        { productId: ids.P2, quantity: 10, unitCostPaise: 85_00, requestId: forP2.id },
        { productId: ids.P1, quantity: 5, unitCostPaise: 20_00, requestId: typed.id },
      ],
    });
    expect(created.statusCode).toBe(201);
    const po = created.json().purchaseOrder;
    expect(po).toMatchObject({ status: 'draft', supplierName: 'Patna Pharma Distributors' });
    expect(po.poNumber).toMatch(/^PO-\d+$/);
    expect((await mine(a)).map((r: { status: string }) => r.status)).toEqual(['ordered', 'ordered']);
    // The typed-in request is now linked to the catalogue product.
    expect((await mine(a)).find((r: { id: string }) => r.id === typed.id)).toMatchObject({ productId: ids.P1, name: 'Dolo 650' });

    // ETA appears for the retailer only once the supplier confirms it, and never in the past.
    expect((await post(`/procurement/requests/${forP2.id}/eta`, buyer.token, { etaDate: '2020-01-01' })).statusCode).toBe(400);
    expect((await post(`/procurement/requests/${forP2.id}/eta`, buyer.token, { etaDate: inDays(3) })).statusCode).toBe(200);
    expect((await mine(a)).find((r: { id: string }) => r.id === forP2.id)).toMatchObject({ etaDate: inDays(3), etaConfirmed: true });

    const item = (sku: string) => po.items.find((i: { sku: string }) => i.sku === sku);
    const receipt = { itemId: item('P2').id, batchNumber: 'AUG24', expiryDate: inDays(400), acceptedQty: 8, rejectedQty: 2 };
    // Nothing can be received before the order is sent, or without a reason for rejects.
    expect((await post(`/procurement/purchase-orders/${po.id}/receive`, picker.token, { items: [receipt] })).statusCode).toBe(409);
    expect((await post(`/procurement/purchase-orders/${po.id}/send`, picker.token)).statusCode).toBe(403);
    expect((await post(`/procurement/purchase-orders/${po.id}/send`, buyer.token)).json().purchaseOrder.status).toBe('sent');
    expect((await post(`/procurement/purchase-orders/${po.id}/receive`, picker.token, { items: [receipt] })).statusCode).toBe(400);

    const first = await post(`/procurement/purchase-orders/${po.id}/receive`, picker.token, {
      supplierInvoiceRef: 'PPD/778',
      items: [{ ...receipt, rejectReason: 'damaged' }],
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().purchaseOrder.status).toBe('partially_received');
    expect(first.json().purchaseOrder.items.find((i: { sku: string }) => i.sku === 'P2')).toMatchObject({ receivedQty: 8, rejectedQty: 2 });

    // Accepted units are on hand, but unpriced until Marg supplies the selling rate, so not yet for sale.
    const { rows } = await db.query('SELECT on_hand_qty, rate_paise FROM inventory_batches WHERE product_id = $1', [ids.P2]);
    expect(rows).toEqual([{ on_hand_qty: 8, rate_paise: null }]);
    const product = await get(`/catalog/products/${ids.P2}`, a.token);
    expect(product.statusCode).toBe(200);
    expect(product.json().availability).toBe('out_of_stock');

    const over = await post(`/procurement/purchase-orders/${po.id}/receive`, picker.token, {
      items: [{ itemId: item('P1').id, batchNumber: 'DL1', expiryDate: inDays(300), acceptedQty: 6, rejectedQty: 0 }],
    });
    expect(over.statusCode).toBe(409);
    const rest = await post(`/procurement/purchase-orders/${po.id}/receive`, picker.token, {
      items: [{ itemId: item('P1').id, batchNumber: 'DL1', expiryDate: inDays(300), acceptedQty: 5, rejectedQty: 0 }],
    });
    expect(rest.json().purchaseOrder.status).toBe('received');
    expect(rest.json().purchaseOrder.receipts).toHaveLength(2);

    const statuses = await mine(a);
    expect(statuses.map((r: { status: string }) => r.status)).toEqual(['received', 'received']);
    // Supplier, cost and internal notes never reach the retailer.
    expect(JSON.stringify(statuses)).not.toMatch(/Patna|cost|supplier|PPD/i);

    const movements = await db.query("SELECT quantity, reference FROM inventory_movements WHERE kind = 'receipt' ORDER BY created_at");
    expect(movements.rows).toEqual([
      { quantity: 8, reference: po.poNumber },
      { quantity: 5, reference: po.poNumber },
    ]);
    const audit = await db.query("SELECT action FROM audit_logs WHERE entity_type = 'purchase_order' AND entity_id = $1 ORDER BY occurred_at", [po.id]);
    expect(audit.rows.map((r) => r.action)).toEqual([
      'procurement.po_create',
      'procurement.po_send',
      'procurement.goods_receive',
      'procurement.goods_receive',
    ]);
  });

  it('returns requests to the queue when a purchase order is cancelled and records supplier failure', async () => {
    const req = (await post('/special-orders', b.token, { productId: ids.P2, quantity: 3 })).json().request;
    const supplierId = (await get('/procurement/suppliers', buyer.token)).json().items[0].id;
    const po = (
      await post('/procurement/purchase-orders', buyer.token, {
        supplierId,
        items: [{ productId: ids.P2, quantity: 3, unitCostPaise: 85_00, requestId: req.id }],
      })
    ).json().purchaseOrder;
    await post(`/procurement/requests/${req.id}/eta`, buyer.token, { etaDate: inDays(2) });

    // Retailers can cancel only before procurement orders it; staff must cancel the PO first.
    expect((await post(`/special-orders/${req.id}/cancel`, b.token)).statusCode).toBe(409);
    expect((await post(`/procurement/requests/${req.id}/close`, buyer.token, { outcome: 'unavailable', reason: 'x' })).statusCode).toBe(400);
    expect((await post(`/procurement/requests/${req.id}/close`, buyer.token, { outcome: 'unavailable', reason: 'Out at supplier' })).statusCode).toBe(409);

    await post(`/procurement/purchase-orders/${po.id}/cancel`, buyer.token, { reason: 'Supplier out of stock' });
    const back = (await mine(b))[0];
    expect(back).toMatchObject({ status: 'open', etaDate: null, etaConfirmed: false });

    const closed = await post(`/procurement/requests/${req.id}/close`, buyer.token, {
      outcome: 'unavailable',
      reason: 'No supplier has stock this month',
    });
    expect(closed.statusCode).toBe(200);
    expect((await mine(b))[0].status).toBe('unavailable');
    const audit = await db.query("SELECT reason FROM audit_logs WHERE action = 'procurement.request_close'");
    expect(audit.rows).toEqual([{ reason: 'No supplier has stock this month' }]);

    const another = (await post('/special-orders', b.token, { productId: ids.P1, quantity: 2 })).json().request;
    expect((await post(`/special-orders/${another.id}/cancel`, b.token)).statusCode).toBe(200);
    expect((await mine(b))[0]).toMatchObject({ id: another.id, status: 'cancelled' });
  });
});
