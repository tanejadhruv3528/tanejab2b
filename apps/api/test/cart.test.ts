import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Role } from '../src/auth/sessions.js';
import type { RecordingSmsSender } from '../src/auth/sms.js';
import { createPool, withTransaction, type Db } from '../src/db.js';
import { grantRole } from '../src/users.js';
import { resetDatabase, TEST_DATABASE_URL, testDeps } from './helpers.js';

const CATALOG = [
  'sku,name,generic_name,manufacturer,gst_rate,cold_chain,status',
  'P1,Dolo 650,Paracetamol,Micro Labs,12,no,active',
  'P2,Augmentin 625 Duo,Amoxicillin,GSK,12,no,active',
  'P3,Insulin Pen,Insulin,Novo,5,yes,active',
  'P4,Old Syrup,Codeine,Acme,12,no,restricted',
  'P5,No Tax,Something,Acme,,no,active',
  'P6,No Rate,Something,Acme,12,no,active',
].join('\n');

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

describe.skipIf(!TEST_DATABASE_URL)('cart and pricing (integration)', () => {
  let db: Db;
  let app: FastifyInstance;
  let sms: RecordingSmsSender;
  let counter = 0;
  let operator: { token: string; userId: string };
  let admin: { token: string; userId: string };
  let retailer: { token: string; userId: string };
  let accountId: string;
  const ids: Record<string, string> = {};

  async function login(): Promise<{ token: string; userId: string }> {
    counter += 1;
    const phone = `+9194000${String(counter).padStart(5, '0')}`;
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

  const setItem = (sku: string, quantity: number, token = retailer.token) =>
    app.inject({ method: 'PUT', url: `/cart/items/${ids[sku]}`, headers: bearer(token), payload: { quantity } });

  const cart = async () => (await app.inject({ method: 'GET', url: '/cart', headers: bearer(retailer.token) })).json().cart;
  const clear = () => app.inject({ method: 'DELETE', url: '/cart', headers: bearer(retailer.token) });

  beforeAll(async () => {
    db = createPool({ databaseUrl: TEST_DATABASE_URL!, databaseSsl: false });
    await resetDatabase(db);
    const deps = testDeps(db);
    sms = deps.sms;
    app = await buildApp(deps);
    operator = await withRole('catalog_operator');
    admin = await withRole('super_admin');
    retailer = await login();
    accountId = await withTransaction(db, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "INSERT INTO retailer_accounts (owner_user_id, status, cod_allowed) VALUES ($1, 'approved', true) RETURNING id",
        [retailer.userId],
      );
      await c.query(
        `INSERT INTO store_locations (retailer_account_id, address_line1, city, district, postal_code, service_zone, verified)
         VALUES ($1, 'Main Road', 'Samastipur', 'Samastipur', '848101', 'SMP-1', true)`,
        [rows[0]!.id],
      );
      await c.query("INSERT INTO user_roles (user_id, role, scope_retailer_account_id) VALUES ($1, 'retailer', $2)", [
        retailer.userId,
        rows[0]!.id,
      ]);
      return rows[0]!.id;
    });
    const imported = await app.inject({
      method: 'POST',
      url: '/admin/catalog/imports?source=manual_entry&dryRun=false',
      headers: { ...bearer(operator.token), 'content-type': 'text/csv' },
      payload: CATALOG,
    });
    expect(imported.statusCode).toBe(201);
    const { rows } = await db.query<{ sku: string; id: string }>('SELECT sku, id FROM products');
    for (const r of rows) ids[r.sku] = r.id;

    const stock = [
      'sku,batch,expiry,qty,mrp,rate',
      // Earliest-expiry batch is priced differently so FEFO allocation is visible in the totals.
      `P1,B-EARLY,${inDays(100)},10,120.00,90.00`,
      `P1,B-LATE,${inDays(400)},500,120.00,100.00`,
      `P1,B-SHORT,${inDays(5)},50,120.00,10.00`,
      `P2,A1,${inDays(300)},5,250.00,200.00`,
      `P3,I1,${inDays(300)},20,500.00,400.00`,
      `P4,R1,${inDays(300)},20,50.00,40.00`,
      `P5,T1,${inDays(300)},20,50.00,40.00`,
      `P6,N1,${inDays(300)},20,,`,
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

  it('is only available to approved retailers', async () => {
    const outsider = await login();
    expect((await app.inject({ method: 'GET', url: '/cart', headers: bearer(outsider.token) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/cart', headers: bearer(operator.token) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/cart' })).statusCode).toBe(401);
  });

  it('starts empty and cannot be checked out', async () => {
    const c = await cart();
    expect(c).toMatchObject({ lines: [], subtotalPaise: 0, canCheckout: false });
    expect(c.checkout.orderBlockers).toContain('EMPTY_CART');
  });

  it('validates items', async () => {
    const missing = await app.inject({
      method: 'PUT',
      url: '/cart/items/00000000-0000-4000-8000-000000000000',
      headers: bearer(retailer.token),
      payload: { quantity: 1 },
    });
    expect(missing.statusCode).toBe(404);
    expect((await setItem('P1', -1)).statusCode).toBe(400);
    expect((await setItem('P1', 1.5)).statusCode).toBe(400);
    expect((await setItem('P1', 10001)).statusCode).toBe(400);
    const extra = await app.inject({
      method: 'PUT',
      url: `/cart/items/${ids.P1}`,
      headers: bearer(retailer.token),
      payload: { quantity: 1, pricePaise: 1 },
    });
    expect(extra.statusCode).toBe(400);
  });

  it('prices lines earliest-expiry first with GST per line and blocks below the minimum order', async () => {
    // 10 @ ₹90 (B-EARLY) + 10 @ ₹100 (B-LATE); B-SHORT is inside the minimum shelf life and never used.
    const res = await setItem('P1', 20);
    expect(res.statusCode).toBe(200);
    const c = res.json().cart;
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).toMatchObject({
      sku: 'P1',
      quantity: 20,
      issues: [],
      pricing: { valuePaise: 1_900_00, discountPaise: 0, taxablePaise: 1_900_00, gstRateBps: 1200, taxPaise: 228_00 },
    });
    expect(c.lines[0].allocations.map((a: { quantity: number }) => a.quantity)).toEqual([10, 10]);
    expect(c).toMatchObject({ subtotalPaise: 1_900_00, taxPaise: 228_00, canCheckout: false });
    expect(c.checkout).toMatchObject({ deliveryFeePaise: 50_00, payablePaise: 2_178_00, orderBlockers: ['BELOW_MINIMUM_ORDER'] });
    expect(JSON.stringify(c)).not.toMatch(/supplier|cost/i);
  });

  it('allows checkout at exactly the minimum order with COD', async () => {
    // 10 @ ₹90 + 21 @ ₹100 = ₹3,000.
    const c = (await setItem('P1', 31)).json().cart;
    expect(c).toMatchObject({ subtotalPaise: 3_000_00, taxPaise: 360_00, canCheckout: true });
    expect(c.checkout).toMatchObject({ payablePaise: 3_410_00, canOrder: true, codEligible: true, paymentMethods: ['prepaid', 'cod'] });
  });

  it('blocks COD above ₹10,000 but still allows prepaid', async () => {
    // 10 @ ₹90 + 90 @ ₹100 = ₹9,900 + 12% GST + ₹50 delivery = ₹11,138.
    const c = (await setItem('P1', 100)).json().cart;
    expect(c.checkout).toMatchObject({ payablePaise: 11_138_00, codEligible: false, paymentMethods: ['prepaid'] });
    expect(c.checkout.codBlockers).toEqual(['COD_ABOVE_LIMIT']);
    expect(c.canCheckout).toBe(true);
  });

  it('flags problem lines with reasons, excludes them from totals and blocks checkout', async () => {
    await setItem('P1', 31);
    await setItem('P2', 8);
    await setItem('P3', 1);
    await setItem('P4', 1);
    await setItem('P5', 1);
    await setItem('P6', 1);
    const c = await cart();
    const bySku = Object.fromEntries(c.lines.map((l: { sku: string }) => [l.sku, l]));
    expect(bySku.P2).toMatchObject({ issues: ['INSUFFICIENT_STOCK'], availableQuantity: 5, pricing: null });
    expect(bySku.P3.issues).toEqual(['COLD_CHAIN_NOT_ENABLED']);
    expect(bySku.P4.issues).toEqual(['RESTRICTED']);
    expect(bySku.P5.issues).toEqual(['TAX_RATE_MISSING']);
    expect(bySku.P6.issues).toEqual(['PRICE_MISSING']);
    expect(c.lines).toHaveLength(6);
    expect(c.subtotalPaise).toBe(3_000_00);
    expect(c.checkout.canOrder).toBe(true);
    expect(c.canCheckout).toBe(false);

    for (const sku of ['P2', 'P3', 'P4', 'P5', 'P6']) await setItem(sku, 0);
    expect((await cart()).canCheckout).toBe(true);
  });

  it('stores a quote that expires', async () => {
    const res = await app.inject({ method: 'POST', url: '/cart/quote', headers: bearer(retailer.token) });
    expect(res.statusCode).toBe(201);
    const quote = res.json().quote;
    expect(quote).toMatchObject({ subtotalPaise: 3_000_00, canCheckout: true });
    const minutes = (new Date(quote.expiresAt).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
    const { rows } = await db.query('SELECT payable_paise, can_checkout, retailer_account_id FROM price_quotes WHERE id = $1', [
      quote.id,
    ]);
    expect(rows[0]).toMatchObject({ payable_paise: '341000', can_checkout: true, retailer_account_id: accountId });
  });

  it('blocks checkout when the store is not verified', async () => {
    await db.query('UPDATE store_locations SET verified = false WHERE retailer_account_id = $1', [accountId]);
    const c = await cart();
    expect(c.canCheckout).toBe(false);
    expect(c.checkout.orderBlockers).toContain('STORE_NOT_VERIFIED');
    await db.query('UPDATE store_locations SET verified = true WHERE retailer_account_id = $1', [accountId]);
  });

  it('keeps discounts off until both a rule is activated and the global switch is on', async () => {
    const draft = await app.inject({
      method: 'POST',
      url: '/admin/pricing/rules',
      headers: bearer(operator.token),
      payload: { minSubtotalPaise: 3_000_00, discountBps: 300, note: 'placeholder, rates unconfirmed' },
    });
    expect(draft.statusCode).toBe(201);
    const ruleId = draft.json().rule.id;
    expect(draft.json().rule.status).toBe('draft');

    // Catalogue operators cannot activate; retailers cannot see rules at all.
    const denied = await app.inject({
      method: 'POST',
      url: `/admin/pricing/rules/${ruleId}/status`,
      headers: bearer(operator.token),
      payload: { status: 'active', reason: 'test' },
    });
    expect(denied.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/admin/pricing/rules', headers: bearer(retailer.token) })).statusCode).toBe(403);

    const activated = await app.inject({
      method: 'POST',
      url: `/admin/pricing/rules/${ruleId}/status`,
      headers: bearer(admin.token),
      payload: { status: 'active', reason: 'testing slab maths' },
    });
    expect(activated.statusCode).toBe(200);
    expect((await cart()).discountPaise).toBe(0);

    await db.query("UPDATE app_settings SET value = 'true' WHERE key = 'pricing.discounts_enabled'");
    const c = await cart();
    expect(c).toMatchObject({ discountBps: 300, discountPaise: 90_00, subtotalPaise: 3_000_00 });
    // GST is charged on the discounted value: 12% of ₹2,910.
    expect(c.taxPaise).toBe(349_20);
    await db.query("UPDATE app_settings SET value = 'false' WHERE key = 'pricing.discounts_enabled'");

    const audit = await db.query("SELECT action FROM audit_logs WHERE entity_type = 'pricing_rule' ORDER BY occurred_at, id");
    expect(audit.rows.map((r) => r.action)).toEqual(['pricing_rule.create', 'pricing_rule.activate']);
  });

  it('removes items and clears the cart', async () => {
    await setItem('P2', 1);
    expect((await cart()).lines).toHaveLength(2);
    await setItem('P2', 0);
    expect((await cart()).lines).toHaveLength(1);
    expect((await clear()).statusCode).toBe(204);
    expect((await cart()).lines).toEqual([]);
  });
});
