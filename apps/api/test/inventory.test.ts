import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Role } from '../src/auth/sessions.js';
import type { RecordingSmsSender } from '../src/auth/sms.js';
import { createPool, withTransaction, type Db } from '../src/db.js';
import { releaseStock, reserveStock } from '../src/inventory.js';
import { grantRole } from '../src/users.js';
import { resetDatabase, TEST_DATABASE_URL, testDeps } from './helpers.js';

const CATALOG = [
  'sku,name,generic_name,manufacturer',
  'P1,Dolo 650,Paracetamol,Micro Labs',
  'P2,Augmentin 625 Duo,Amoxicillin,GSK',
  'P3,Pan 40,Pantoprazole,Alkem',
].join('\n');

/** A date `days` from today in YYYY-MM-DD. */
function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

describe.skipIf(!TEST_DATABASE_URL)('inventory (integration)', () => {
  let db: Db;
  let app: FastifyInstance;
  let sms: RecordingSmsSender;
  let counter = 0;
  let operator: { token: string; userId: string };
  let retailer: { token: string; userId: string };
  const ids: Record<string, string> = {};

  async function login(): Promise<{ token: string; userId: string }> {
    counter += 1;
    const phone = `+9195000${String(counter).padStart(5, '0')}`;
    await app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone } });
    const res = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: sms.sent.get(phone) } });
    return { token: res.json().token, userId: res.json().user.id };
  }

  async function withRole(role: Role) {
    const user = await login();
    await withTransaction(db, (c) => grantRole(c, { userId: null, role: 'cli' }, user.userId, role));
    return user;
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  function stockImport(csv: string, query: string, token = operator.token) {
    return app.inject({
      method: 'POST',
      url: `/admin/inventory/imports?${query}`,
      headers: { ...bearer(token), 'content-type': 'text/csv' },
      payload: csv,
    });
  }

  async function product(token: string, sku: string) {
    return (await app.inject({ method: 'GET', url: `/catalog/products/${ids[sku]}`, headers: bearer(token) })).json();
  }

  async function batches(sku: string) {
    return (
      await app.inject({ method: 'GET', url: `/admin/inventory/products/${ids[sku]}`, headers: bearer(operator.token) })
    ).json().batches;
  }

  beforeAll(async () => {
    db = createPool({ databaseUrl: TEST_DATABASE_URL!, databaseSsl: false });
    await resetDatabase(db);
    const deps = testDeps(db);
    sms = deps.sms;
    app = await buildApp(deps);
    operator = await withRole('catalog_operator');
    retailer = await login();
    await withTransaction(db, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "INSERT INTO retailer_accounts (owner_user_id, status) VALUES ($1, 'approved') RETURNING id",
        [retailer.userId],
      );
      await c.query("INSERT INTO user_roles (user_id, role, scope_retailer_account_id) VALUES ($1, 'retailer', $2)", [
        retailer.userId,
        rows[0]!.id,
      ]);
    });
    await app.inject({
      method: 'POST',
      url: '/admin/catalog/imports?source=manual_entry&dryRun=false',
      headers: { ...bearer(operator.token), 'content-type': 'text/csv' },
      payload: CATALOG,
    });
    const { rows } = await db.query<{ sku: string; id: string }>('SELECT sku, id FROM products');
    for (const r of rows) ids[r.sku] = r.id;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it('shows never-synced products as out of stock and stale', async () => {
    expect(await product(retailer.token, 'P1')).toMatchObject({
      availability: 'out_of_stock',
      stockSyncedAt: null,
      stockStale: true,
    });
  });

  it('dry-runs a snapshot, reporting unknown SKUs without writing', async () => {
    const csv = `sku,batch,expiry,qty\nP1,B1,${inDays(400)},50\nZZZ,X1,${inDays(400)},5`;
    const res = await stockImport(csv, `source=marg_export&asOf=${new Date().toISOString()}`);
    expect(res.json()).toMatchObject({ status: 'validated', unknownSkus: ['ZZZ'], appliedRows: 0 });
    expect(await batches('P1')).toEqual([]);
  });

  it('applies a snapshot and updates availability, hiding quantities from retailers', async () => {
    const asOf = new Date(Date.now() - 60_000).toISOString();
    const csv = [
      'sku,batch,expiry,qty,mrp,rate,location',
      `P1,B-LATE,${inDays(500)},40,33.60,26.88,R1`,
      `P1,B-EARLY,${inDays(200)},30,33.60,26.88,R1`,
      `P1,B-SHORT,${inDays(10)},100,33.60,26.88,R1`,
      `P2,A1,${inDays(300)},4,15.00,12.00,`,
      // No selling rate yet: counted as stock but not offered for sale.
      `P3,U1,${inDays(300)},50,,,`,
    ].join('\n');
    const res = await stockImport(csv, `source=marg_export&dryRun=false&asOf=${asOf}`);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'applied', appliedRows: 5, oversold: [] });

    const dolo = await product(retailer.token, 'P1');
    // The batch expiring in 10 days is inside the 30-day minimum shelf life, so only 70 units are sellable.
    expect(dolo).toMatchObject({ availability: 'in_stock', stockStale: false });
    expect(dolo.sellableUnits).toBeUndefined();
    expect((await product(operator.token, 'P1')).sellableUnits).toBe(70);
    expect((await product(retailer.token, 'P2')).availability).toBe('low_stock');
    expect((await product(retailer.token, 'P3')).availability).toBe('out_of_stock');

    const search = await app.inject({ method: 'GET', url: '/catalog/search?q=dolo', headers: bearer(retailer.token) });
    expect(search.json().items[0]).toMatchObject({ availability: 'in_stock', stockStale: false });
  });

  it('rejects a file with errors and an export older than the last applied one', async () => {
    const bad = await stockImport('sku,batch,expiry,qty\nP1,B1,someday,5', `source=marg_export&dryRun=false&asOf=${new Date().toISOString()}`);
    expect(bad.json()).toMatchObject({ status: 'rejected', errorCount: 1 });

    const old = await stockImport(
      `sku,batch,expiry,qty\nP1,B-LATE,${inDays(500)},1`,
      `source=marg_export&dryRun=false&asOf=${new Date(Date.now() - 86_400_000).toISOString()}`,
    );
    expect(old.json().status).toBe('rejected');
    expect(old.json().errors[0].field).toBe('asOf');
    expect((await batches('P1')).find((b: { batchNumber: string }) => b.batchNumber === 'B-LATE').onHand).toBe(40);
  });

  it('reserves earliest-expiring sellable stock first and releases it', async () => {
    const lines = await withTransaction(db, (c) =>
      reserveStock(c, ids.P1!, 35, { reference: 'test-order-1', actorUserId: null, minShelfLifeDays: 30 }),
    );
    expect(lines.map((l) => [l.batchNumber, l.quantity])).toEqual([
      ['B-EARLY', 30],
      ['B-LATE', 5],
    ]);
    expect((await product(operator.token, 'P1')).sellableUnits).toBe(35);

    await withTransaction(db, (c) => releaseStock(c, lines, { reference: 'test-order-1:cancel', actorUserId: null }));
    expect((await product(operator.token, 'P1')).sellableUnits).toBe(70);

    const movements = await db.query(
      "SELECT kind, sum(quantity)::int AS qty FROM inventory_movements WHERE reference LIKE 'test-order-1%' GROUP BY kind ORDER BY kind",
    );
    expect(movements.rows).toEqual([
      { kind: 'release', qty: -35 },
      { kind: 'reserve', qty: 35 },
    ]);
  });

  it('refuses to reserve more than is sellable', async () => {
    await expect(
      withTransaction(db, (c) => reserveStock(c, ids.P2!, 5, { reference: 'x', actorUserId: null, minShelfLifeDays: 30 })),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { requested: 5, available: 4 } });
  });

  it('never lets two concurrent orders take the last unit', async () => {
    // P2 has 4 units. Two orders for 3 each race; exactly one must win.
    const attempt = (ref: string) =>
      withTransaction(db, (c) => reserveStock(c, ids.P2!, 3, { reference: ref, actorUserId: null, minShelfLifeDays: 30 }));
    const results = await Promise.allSettled([attempt('race-a'), attempt('race-b')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const batch = (await batches('P2'))[0];
    expect(batch.reserved).toBe(3);
  });

  it('keeps reservations through a new snapshot and reports oversold batches', async () => {
    // P2 batch A1 has 3 reserved. A new count of 2 means one reserved unit no longer exists.
    const res = await stockImport(
      `sku,batch,expiry,qty\nP2,A1,${inDays(300)},2`,
      `source=marg_export&dryRun=false&asOf=${new Date().toISOString()}`,
    );
    expect(res.json().oversold).toEqual([{ sku: 'P2', batch: 'A1', onHand: 2, reserved: 3 }]);
    expect((await product(retailer.token, 'P2')).availability).toBe('out_of_stock');
  });

  it('zeroes batches that disappear from a product in the next snapshot', async () => {
    await stockImport(
      `sku,batch,expiry,qty\nP1,B-LATE,${inDays(500)},40`,
      `source=marg_export&dryRun=false&asOf=${new Date().toISOString()}`,
    );
    const p1 = await batches('P1');
    expect(p1.map((b: { batchNumber: string; onHand: number }) => [b.batchNumber, b.onHand])).toEqual([
      ['B-SHORT', 0],
      ['B-EARLY', 0],
      ['B-LATE', 40],
    ]);
  });

  it('restricts stock imports and batch views to staff', async () => {
    expect(
      (await stockImport('sku,batch,expiry,qty', `source=marg_export&asOf=${new Date().toISOString()}`, retailer.token))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: `/admin/inventory/products/${ids.P1}`, headers: bearer(retailer.token) }))
        .statusCode,
    ).toBe(403);
  });
});
