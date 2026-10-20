import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Role } from '../src/auth/sessions.js';
import type { RecordingSmsSender } from '../src/auth/sms.js';
import { createPool, withTransaction, type Db } from '../src/db.js';
import { grantRole } from '../src/users.js';
import { resetDatabase, TEST_DATABASE_URL, testDeps } from './helpers.js';

const CSV = [
  'sku,name,generic_name,manufacturer,strength,dosage_form,pack_size,hsn_code,gst_rate,mrp,schedule,cold_chain,status,aliases',
  'TDA-0001,Dolo 650,Paracetamol,Micro Labs,650 mg,Tablet,15 tablets,30049099,12,33.60,,no,,dolo|पैरासिटामोल',
  'TDA-0002,Crocin Advance,Paracetamol,GSK,500 mg,Tablet,20 tablets,30049099,12,30.00,,no,,crocin',
  'TDA-0003,Augmentin 625 Duo,Amoxicillin + Clavulanic Acid,GSK,625 mg,Tablet,10 tablets,30042019,12,223.50,H,no,,augmentin',
  'TDA-0004,Lantus Solostar,Insulin Glargine,Sanofi,100 IU/ml,Injection,3 ml pen,30043110,5,1100,H,yes,restricted,lantus',
  'TDA-0005,Old Syrup,Dextromethorphan,Old Pharma,,Syrup,100 ml,,,,,no,discontinued,',
].join('\n');

describe.skipIf(!TEST_DATABASE_URL)('catalogue (integration)', () => {
  let db: Db;
  let app: FastifyInstance;
  let sms: RecordingSmsSender;
  let counter = 0;

  async function login(): Promise<{ token: string; userId: string }> {
    counter += 1;
    const phone = `+9196000${String(counter).padStart(5, '0')}`;
    await app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone } });
    const res = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: sms.sent.get(phone) } });
    return { token: res.json().token, userId: res.json().user.id };
  }

  async function withRole(role: Role) {
    const user = await login();
    await withTransaction(db, (c) => grantRole(c, { userId: null, role: 'cli' }, user.userId, role));
    return user;
  }

  /** An approved retailer, created directly so this suite does not depend on the KYC flow. */
  async function approvedRetailer() {
    const user = await login();
    await withTransaction(db, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "INSERT INTO retailer_accounts (owner_user_id, business_name, status) VALUES ($1, 'Test Pharmacy', 'approved') RETURNING id",
        [user.userId],
      );
      await c.query("INSERT INTO user_roles (user_id, role, scope_retailer_account_id) VALUES ($1, 'retailer', $2)", [
        user.userId,
        rows[0]!.id,
      ]);
    });
    return user;
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  function importCsv(token: string, csv: string, query: string) {
    return app.inject({
      method: 'POST',
      url: `/admin/catalog/imports?${query}`,
      headers: { ...bearer(token), 'content-type': 'text/csv' },
      payload: csv,
    });
  }

  function search(token: string, q: string) {
    return app.inject({ method: 'GET', url: `/catalog/search?q=${encodeURIComponent(q)}`, headers: bearer(token) });
  }

  let operator: { token: string; userId: string };
  let retailer: { token: string; userId: string };

  beforeAll(async () => {
    db = createPool({ databaseUrl: TEST_DATABASE_URL!, databaseSsl: false });
    await resetDatabase(db);
    const deps = testDeps(db);
    sms = deps.sms;
    app = await buildApp(deps);
    operator = await withRole('catalog_operator');
    retailer = await approvedRetailer();
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  describe('imports', () => {
    it('only lets catalogue staff import', async () => {
      expect((await importCsv(retailer.token, CSV, 'source=manual_entry')).statusCode).toBe(403);
      const picker = await withRole('picker_packer');
      expect((await importCsv(picker.token, CSV, 'source=manual_entry')).statusCode).toBe(403);
    });

    it('only accepts authorised sources', async () => {
      const res = await importCsv(operator.token, CSV, 'source=1mg_scrape');
      expect(res.statusCode).toBe(400);
    });

    it('validates without writing by default (dry run)', async () => {
      const res = await importCsv(operator.token, CSV, 'source=marg_export&filename=items.csv');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'validated', dryRun: true, totalRows: 5, validRows: 5, errorCount: 0 });
      const { rows } = await db.query('SELECT count(*)::int AS n FROM products');
      expect(rows[0].n).toBe(0);
    });

    it('rejects the whole file when any row is invalid', async () => {
      const bad = `${CSV}\nTDA-0006,,,,,,,,99,,,,,`;
      const res = await importCsv(operator.token, bad, 'source=marg_export&dryRun=false');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'rejected', totalRows: 6, validRows: 5 });
      expect(res.json().errors.map((e: { field: string }) => e.field)).toEqual(['name', 'manufacturer', 'gst_rate']);
      const { rows } = await db.query('SELECT count(*)::int AS n FROM products');
      expect(rows[0].n).toBe(0);
    });

    it('applies a clean file, then updates by SKU on re-import, with an audit record', async () => {
      const first = await importCsv(operator.token, CSV, 'source=marg_export&dryRun=false&filename=items.csv');
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({ status: 'applied', created: 5, updated: 0 });

      const changed = CSV.replace('Crocin Advance', 'Crocin Advance Fast');
      const second = await importCsv(operator.token, changed, 'source=marg_export&dryRun=false');
      expect(second.json()).toMatchObject({ created: 0, updated: 5 });

      const { rows } = await db.query("SELECT name FROM products WHERE sku = 'TDA-0002'");
      expect(rows[0].name).toBe('Crocin Advance Fast');
      const audit = await db.query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'catalog.import.apply'");
      expect(audit.rows[0].n).toBe(2);

      const runs = await app.inject({ method: 'GET', url: '/admin/catalog/imports', headers: bearer(operator.token) });
      expect(runs.json().items[0]).toMatchObject({ status: 'applied', updated: 5 });
    });

    it('rejects non-CSV bodies and malformed CSV', async () => {
      expect((await importCsv(operator.token, '', 'source=manual_entry')).statusCode).toBe(400);
      expect((await importCsv(operator.token, 'sku,name,manufacturer\n"A1,Bad', 'source=manual_entry')).statusCode).toBe(400);
    });
  });

  describe('search', () => {
    it('requires an approved retailer or staff', async () => {
      const applicant = await login();
      expect((await search(applicant.token, 'dolo')).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/catalog/search?q=dolo' })).statusCode).toBe(401);
    });

    it('finds by brand, generic, manufacturer, strength, SKU and alias', async () => {
      const names = async (q: string) =>
        (await search(retailer.token, q)).json().items.map((p: { name: string }) => p.name) as string[];
      expect((await names('dolo'))[0]).toBe('Dolo 650');
      expect(await names('paracetamol')).toEqual(expect.arrayContaining(['Dolo 650', 'Crocin Advance Fast']));
      expect(await names('clavulanic')).toEqual(['Augmentin 625 Duo']);
      expect(await names('sanofi')).toEqual(['Lantus Solostar']);
      expect((await names('tda-0003'))[0]).toBe('Augmentin 625 Duo');
      expect((await names('पैरासिटामोल'))[0]).toBe('Dolo 650');
      expect((await names('650 mg'))[0]).toBe('Dolo 650');
    });

    it('tolerates typos', async () => {
      const res = await search(retailer.token, 'augmentn');
      expect(res.json().items[0].name).toBe('Augmentin 625 Duo');
    });

    it('treats LIKE wildcards in queries literally', async () => {
      expect((await search(retailer.token, '%%')).json().items).toEqual([]);
    });

    it('hides discontinued products from retailers but not from staff', async () => {
      expect((await search(retailer.token, 'old syrup')).json().items).toEqual([]);
      expect((await search(operator.token, 'old syrup')).json().items[0].status).toBe('discontinued');
    });

    it('flags restricted and cold-chain products and never claims stock', async () => {
      const lantus = (await search(retailer.token, 'lantus')).json().items[0];
      expect(lantus).toMatchObject({ status: 'restricted', coldChain: true, schedule: 'H', mrpPaise: 110000 });
      expect(lantus.availability).toBeNull();
      expect(lantus.stockSyncedAt).toBeNull();
      const detail = await app.inject({ method: 'GET', url: `/catalog/products/${lantus.id}`, headers: bearer(retailer.token) });
      expect(detail.json().aliases).toEqual(['lantus']);
    });
  });

  describe('product status', () => {
    it('lets catalogue staff restrict a product with an audited reason', async () => {
      const dolo = (await search(operator.token, 'dolo')).json().items[0];
      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/catalog/products/${dolo.id}`,
        headers: bearer(operator.token),
        payload: { status: 'discontinued', reason: 'Manufacturer stopped this pack' },
      });
      expect(res.json().status).toBe('discontinued');
      expect(
        (await app.inject({ method: 'GET', url: `/catalog/products/${dolo.id}`, headers: bearer(retailer.token) }))
          .statusCode,
      ).toBe(404);
      const audit = await db.query("SELECT reason FROM audit_logs WHERE action = 'catalog.product.status' AND entity_id = $1", [
        dolo.id,
      ]);
      expect(audit.rows).toEqual([{ reason: 'Manufacturer stopped this pack' }]);
    });
  });
});
