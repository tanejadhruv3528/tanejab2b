/**
 * Demo mode: answers the app's API calls in the browser with sample data so the app can be
 * shown without a server. Prices use the real pricing and checkout rules from @taneja/domain.
 * Nothing here is live stock, a real order or a real payment.
 */
import {
  allocateFefo,
  availabilityFor,
  DEFAULT_CHECKOUT_POLICY,
  evaluateCheckout,
  paise,
  priceLines,
} from '@taneja/domain';

export const DEMO_OTP = '123456';

interface DemoProduct {
  id: string;
  sku: string;
  name: string;
  genericName: string;
  manufacturer: string;
  strength: string | null;
  packSize: string;
  mrpPaise: number;
  ratePaise: number;
  gstRateBps: number;
  stock: number;
  coldChain: boolean;
  status: 'active' | 'restricted' | 'discontinued';
}

const P = (
  sku: string, name: string, genericName: string, manufacturer: string, strength: string | null, packSize: string,
  mrp: number, rate: number, gst: number, stock: number, extra: Partial<DemoProduct> = {},
): DemoProduct => ({
  id: `demo-${sku.toLowerCase()}`, sku, name, genericName, manufacturer, strength, packSize,
  mrpPaise: Math.round(mrp * 100), ratePaise: Math.round(rate * 100), gstRateBps: gst * 100, stock,
  coldChain: false, status: 'active', ...extra,
});

const PRODUCTS: DemoProduct[] = [
  P('DOLO650', 'Dolo 650', 'Paracetamol', 'Micro Labs', '650 mg', '15 tablets', 33.6, 24.5, 12, 500),
  P('CALPOL500', 'Calpol 500', 'Paracetamol', 'GSK', '500 mg', '15 tablets', 16, 11.2, 12, 200),
  P('AUG625', 'Augmentin 625 Duo', 'Amoxicillin + Clavulanic Acid', 'GSK', '625 mg', '10 tablets', 223.42, 168, 12, 6),
  P('AZEE500', 'Azee 500', 'Azithromycin', 'Cipla', '500 mg', '5 tablets', 119.5, 86, 12, 120),
  P('PAN40', 'Pan 40', 'Pantoprazole', 'Alkem', '40 mg', '15 tablets', 155, 98, 12, 300),
  P('PAND', 'Pan-D', 'Pantoprazole + Domperidone', 'Alkem', '40/30 mg', '15 capsules', 199, 132, 12, 150),
  P('TELMA40', 'Telma 40', 'Telmisartan', 'Glenmark', '40 mg', '30 tablets', 245, 172, 12, 80),
  P('GLYC1', 'Glycomet 500', 'Metformin', 'USV', '500 mg', '20 tablets', 22.4, 15.5, 12, 400),
  P('SHELCAL', 'Shelcal 500', 'Calcium + Vitamin D3', 'Torrent', '500 mg', '15 tablets', 128, 89, 12, 0),
  P('HUMINS', 'Huminsulin R', 'Insulin', 'Lilly', '40 IU/ml', '10 ml vial', 180, 150, 5, 20, { coldChain: true }),
  P('CODSYR', 'Cough syrup (restricted)', 'Codeine combination', 'Example Labs', null, '100 ml', 95, 70, 12, 40, { status: 'restricted' }),
];

const EXPIRY = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);

interface State {
  loggedIn: boolean;
  applicant: boolean;
  cart: Map<string, number>;
  orders: Record<string, unknown>[];
  quotes: Map<string, { payable: number; used: boolean }>;
  onboarding: Record<string, unknown>;
  seq: number;
}

const state: State = {
  loggedIn: false,
  applicant: false,
  cart: new Map([['demo-dolo650', 80], ['demo-pan40', 12]]),
  orders: [],
  quotes: new Map(),
  onboarding: {},
  seq: 1000,
};

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fail = (status: number, code: string, message: string, details?: unknown) =>
  json({ error: { code, message, requestId: 'demo', details } }, status);

const view = (p: DemoProduct) => ({
  id: p.id, sku: p.sku, name: p.name, genericName: p.genericName, manufacturer: p.manufacturer, strength: p.strength,
  packSize: p.packSize, mrpPaise: p.mrpPaise, coldChain: p.coldChain, schedule: null,
  availability: availabilityFor(p.status, p.stock), stockStale: false,
});

function priceCart() {
  const lines = [...state.cart.entries()].map(([id, quantity]) => {
    const p = PRODUCTS.find((x) => x.id === id)!;
    const issues: string[] = [];
    if (p.status === 'restricted') issues.push('RESTRICTED');
    if (p.status === 'discontinued') issues.push('DISCONTINUED');
    if (p.coldChain) issues.push('COLD_CHAIN_NOT_ENABLED');
    const batches = p.stock > 0 ? [{ batchId: `${p.id}-b1`, expiryDate: EXPIRY, free: p.stock, ratePaise: paise(p.ratePaise) }] : [];
    const { allocations, shortBy } = allocateFefo(batches, quantity);
    let availableQuantity: number | undefined;
    if (p.stock === 0) issues.push('OUT_OF_STOCK');
    else if (shortBy > 0) {
      issues.push('INSUFFICIENT_STOCK');
      availableQuantity = p.stock;
    }
    return { p, quantity, issues, availableQuantity, allocations };
  });
  const ok = lines.filter((l) => l.issues.length === 0);
  const priced = priceLines(
    ok.map((l) => ({ productId: l.p.id, quantity: l.quantity, allocations: l.allocations, gstRateBps: l.p.gstRateBps })),
    { enabled: false, slabs: [] },
  );
  const checkout = evaluateCheckout(
    { subtotalPaise: priced.subtotalPaise, discountPaise: priced.discountPaise, taxPaise: priced.taxPaise },
    { status: 'approved', storeVerified: true, inCodServiceZone: true, codAllowedByAdmin: true },
    DEFAULT_CHECKOUT_POLICY,
  );
  return {
    lines: lines.map((l) => {
      const pr = priced.lines.find((x) => x.productId === l.p.id);
      return {
        productId: l.p.id, sku: l.p.sku, name: l.p.name, manufacturer: l.p.manufacturer, packSize: l.p.packSize,
        quantity: l.quantity, issues: l.issues,
        ...(l.availableQuantity !== undefined ? { availableQuantity: l.availableQuantity } : {}),
        stockStale: false,
        pricing: pr
          ? { valuePaise: pr.valuePaise, discountPaise: pr.discountPaise, taxablePaise: pr.taxablePaise, gstRateBps: pr.gstRateBps, taxPaise: pr.taxPaise, totalPaise: pr.totalPaise }
          : null,
      };
    }),
    subtotalPaise: priced.subtotalPaise,
    discountBps: 0,
    discountPaise: priced.discountPaise,
    taxPaise: priced.taxPaise,
    checkout,
    canCheckout: checkout.canOrder && lines.length > 0 && lines.every((l) => l.issues.length === 0),
  };
}

const ME = () => ({
  user: { id: 'demo-user', phone: '+919800000000', name: 'Demo Pharmacy', language: 'en' },
  roles: state.applicant ? [] : [{ role: 'retailer', retailerAccountId: 'demo-account' }],
});

function onboardingView() {
  const o = state.onboarding as { account?: Record<string, unknown>; store?: unknown; license?: unknown; documents?: { id: string; kind: string }[] };
  if (!o.account) return { account: null };
  const docs = o.documents ?? [];
  const gaps: string[] = [];
  if (!o.store) gaps.push('STORE_ADDRESS_MISSING', 'STORE_LOCATION_MISSING');
  if (!o.license) gaps.push('LICENSE_MISSING');
  if (!docs.some((d) => d.kind === 'drug_license')) gaps.push('LICENSE_DOCUMENT_MISSING');
  if (!docs.some((d) => d.kind === 'store_photo')) gaps.push('STORE_PHOTO_MISSING');
  return { ...o, documents: docs, latestDecision: null, gaps };
}

function event(kind: string, to: string, from: string | null = null, note: string | null = null) {
  return { kind, from, to, note, at: new Date().toISOString() };
}

async function handle(method: string, path: string, body: unknown): Promise<Response> {
  const [route, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  const b = (body ?? {}) as Record<string, unknown>;

  if (method === 'POST' && route === '/auth/otp/request') {
    state.applicant = String(b.phone ?? '').replace(/\D/g, '').endsWith('0000');
    return json({ status: 'sent', expiresInSeconds: 300, resendAfterSeconds: 30 }, 202);
  }
  if (method === 'POST' && route === '/auth/otp/verify') {
    if (b.code !== DEMO_OTP) return fail(400, 'OTP_INVALID', `That code is not right. In the demo the code is ${DEMO_OTP}.`);
    state.loggedIn = true;
    return json({ token: 'demo-token', ...ME() });
  }
  if (!state.loggedIn && route !== '/me') {
    // A reload keeps the stored token; treat it as still logged in.
    state.loggedIn = true;
  }
  if (method === 'GET' && route === '/me') return json(ME());
  if (method === 'POST' && route === '/auth/logout') {
    state.loggedIn = false;
    return json(null, 204);
  }

  if (method === 'GET' && route === '/retailer/onboarding') return json(onboardingView());
  if (method === 'PUT' && route === '/retailer/onboarding') {
    const o = state.onboarding as Record<string, unknown>;
    o.account = { ...(o.account as object), businessName: b.businessName, ownerName: b.ownerName, email: b.email ?? null, gstin: b.gstin ?? null, status: 'draft' };
    if (b.store) o.store = b.store;
    if (b.license) o.license = b.license;
    return json(onboardingView());
  }
  const docMatch = route!.match(/^\/retailer\/kyc\/documents\/(\w+)$/);
  if (method === 'POST' && docMatch) {
    const o = state.onboarding as { documents?: { id: string; kind: string }[] };
    o.documents = [...(o.documents ?? []).filter((d) => d.kind !== docMatch[1]), { id: `doc-${Date.now()}`, kind: docMatch[1]! }];
    return json({ id: 'doc', kind: docMatch[1] }, 201);
  }
  if (method === 'POST' && route === '/retailer/kyc/submit') {
    const v = onboardingView() as { gaps?: string[] };
    if (v.gaps?.length) return fail(409, 'CONFLICT', 'Some details are still missing');
    (state.onboarding as { account: Record<string, unknown> }).account.status = 'submitted';
    return json(onboardingView());
  }

  if (method === 'GET' && route === '/catalog/search') {
    const q = (params.get('q') ?? '').toLowerCase().trim();
    const items = PRODUCTS.filter((p) =>
      [p.name, p.genericName, p.manufacturer, p.sku, p.strength ?? ''].join(' ').toLowerCase().includes(q),
    ).map(view);
    return json({ items, limit: 30, offset: 0 });
  }

  if (method === 'GET' && route === '/cart') return json({ cart: priceCart(), onlinePaymentAvailable: false });
  if (method === 'DELETE' && route === '/cart') {
    state.cart.clear();
    return json(null, 204);
  }
  const itemMatch = route!.match(/^\/cart\/items\/([\w-]+)$/);
  if (method === 'PUT' && itemMatch) {
    const qty = Number(b.quantity);
    if (!Number.isInteger(qty) || qty < 0 || qty > 10000) return fail(400, 'VALIDATION_FAILED', 'Quantity must be 0 to 10000');
    if (qty === 0) state.cart.delete(itemMatch[1]!);
    else state.cart.set(itemMatch[1]!, qty);
    return json({ cart: priceCart(), onlinePaymentAvailable: false });
  }
  if (method === 'POST' && route === '/cart/quote') {
    const c = priceCart();
    const id = `quote-${Date.now()}`;
    state.quotes.set(id, { payable: c.checkout.payablePaise, used: false });
    return json({ quote: { id, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), ...c } }, 201);
  }

  if (method === 'POST' && route === '/orders') {
    const quote = state.quotes.get(String(b.quoteId));
    const existing = state.orders.find((o) => o.quoteId === b.quoteId);
    if (existing) return json({ order: existing, replayed: true });
    if (!quote || quote.used) return fail(409, 'CONFLICT', 'This quote has already been used');
    const c = priceCart();
    if (!c.canCheckout || c.checkout.payablePaise !== quote.payable) return fail(409, 'QUOTE_CHANGED', 'Cart changed');
    if (b.paymentMethod !== 'cod' || !c.checkout.codEligible) {
      return fail(422, 'PAYMENT_METHOD_NOT_ALLOWED', 'Not available', { allowed: c.checkout.paymentMethods });
    }
    quote.used = true;
    for (const l of c.lines) PRODUCTS.find((p) => p.id === l.productId)!.stock -= l.quantity;
    state.seq += 1;
    const order = {
      id: `order-${state.seq}`, quoteId: b.quoteId, orderNumber: `TDA-${state.seq}`, status: 'placed', paymentMethod: 'cod',
      paymentStatus: 'cod_due', subtotalPaise: c.subtotalPaise, discountPaise: c.discountPaise, taxPaise: c.taxPaise,
      deliveryFeePaise: c.checkout.deliveryFeePaise, payablePaise: c.checkout.payablePaise, paymentDueBy: null,
      placedAt: new Date().toISOString(), itemCount: c.lines.length,
      items: c.lines.map((l) => ({ productId: l.productId, sku: l.sku, name: l.name, packSize: l.packSize, quantity: l.quantity, totalPaise: l.pricing!.totalPaise })),
      events: [event('status', 'placed'), event('payment', 'cod_due')],
    };
    state.orders.unshift(order);
    state.cart.clear();
    return json({ order, replayed: false }, 201);
  }
  if (method === 'GET' && route === '/orders') return json({ items: state.orders, limit: 50, offset: 0 });
  const orderMatch = route!.match(/^\/orders\/([\w-]+)(\/cancel-request)?$/);
  if (orderMatch) {
    const order = state.orders.find((o) => o.id === orderMatch[1]) as Record<string, unknown> & { events: unknown[] };
    if (!order) return fail(404, 'NOT_FOUND', 'Order not found');
    if (method === 'GET' && !orderMatch[2]) return json({ order });
    if (method === 'POST' && orderMatch[2]) {
      if (order.status !== 'placed') return fail(409, 'CONFLICT', 'This order cannot be cancelled here');
      for (const i of order.items as { productId: string; quantity: number }[]) PRODUCTS.find((p) => p.id === i.productId)!.stock += i.quantity;
      order.events.push(event('status', 'cancelled', 'placed', 'Cancelled by retailer'), event('payment', 'not_charged', 'cod_due'));
      order.status = 'cancelled';
      order.paymentStatus = 'not_charged';
      return json({ result: 'cancelled', order });
    }
  }
  return fail(404, 'NOT_FOUND', `${method} ${route} is not part of the demo`);
}

/** Routes the app's `/api` calls to the in-browser demo instead of the network. */
export function installDemoApi(): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('/api/')) return realFetch(input, init);
    let body: unknown;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    await new Promise((r) => setTimeout(r, 120));
    return handle((init?.method ?? 'GET').toUpperCase(), url.slice(4), body);
  };
}
