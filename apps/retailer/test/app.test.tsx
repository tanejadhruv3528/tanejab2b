import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Cart } from '../src/api';
import { App } from '../src/App';
import { I18nProvider, translate } from '../src/i18n';

type Handler = (body: unknown) => { status?: number; json?: unknown };

/** Routes fetch calls to handlers keyed by "METHOD /path" and records what was sent. */
function mockApi(routes: Record<string, Handler>) {
  const calls: { key: string; body: unknown; auth: string | null; idem: string | null }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace(/^\/api/, '').split('?')[0];
      const key = `${init.method} ${path}`;
      const headers = init.headers as Record<string, string>;
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
      calls.push({ key, body, auth: headers.authorization ?? null, idem: headers['idempotency-key'] ?? null });
      const handler = routes[key];
      const res = handler ? handler(body) : { status: 404, json: { error: { code: 'NOT_FOUND', message: key } } };
      const status = res.status ?? 200;
      return new Response(status === 204 ? null : JSON.stringify(res.json ?? {}), { status });
    }),
  );
  return calls;
}

const renderApp = () =>
  render(
    <I18nProvider>
      <App />
    </I18nProvider>,
  );

const retailerMe = {
  user: { id: 'u1', phone: '+919800000001', name: null, language: 'en' },
  roles: [{ role: 'retailer', retailerAccountId: 'a1' }],
};

function cart(overrides: Partial<Cart> = {}, checkout: Partial<Cart['checkout']> = {}): Cart {
  return {
    lines: [],
    subtotalPaise: 0,
    discountPaise: 0,
    taxPaise: 0,
    canCheckout: false,
    ...overrides,
    checkout: {
      deliveryFeePaise: 5000,
      payablePaise: 5000,
      canOrder: false,
      orderBlockers: ['EMPTY_CART'],
      codEligible: false,
      codBlockers: [],
      paymentMethods: [],
      ...checkout,
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('retailer app', () => {
  it('logs in with phone OTP and stores the session token', async () => {
    const calls = mockApi({
      'POST /auth/otp/request': () => ({ status: 202, json: { sent: true } }),
      'POST /auth/otp/verify': () => ({ json: { token: 'tok-1' } }),
      'GET /me': () => ({ json: { ...retailerMe, roles: [] } }),
      'GET /retailer/onboarding': () => ({ json: { account: null } }),
    });
    const user = userEvent.setup();
    renderApp();
    await user.type(screen.getByLabelText('Mobile number'), '9800000001');
    await user.click(screen.getByRole('button', { name: 'Send OTP' }));
    await user.type(await screen.findByLabelText('OTP'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify and log in' }));

    expect(await screen.findByText('Register your pharmacy')).toBeTruthy();
    expect(calls.find((c) => c.key === 'POST /auth/otp/verify')?.body).toEqual({ phone: '9800000001', code: '123456' });
    expect(localStorage.getItem('taneja.token')).toBe('tok-1');
    expect(calls.find((c) => c.key === 'GET /me')?.auth).toBe('Bearer tok-1');
  });

  it('shows what is still needed before onboarding can be submitted', async () => {
    localStorage.setItem('taneja.token', 'tok');
    mockApi({
      'GET /me': () => ({ json: { ...retailerMe, roles: [] } }),
      'GET /retailer/onboarding': () => ({
        json: {
          account: { businessName: 'Shiv Medical', ownerName: 'Ram', email: null, gstin: null, status: 'draft' },
          store: null,
          license: null,
          documents: [],
          gaps: ['STORE_ADDRESS_MISSING', 'LICENSE_DOCUMENT_MISSING'],
        },
      }),
    });
    renderApp();
    expect(await screen.findByDisplayValue('Shiv Medical')).toBeTruthy();
    expect(screen.getByText('Drug licence upload')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Submit for verification' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('searches the catalogue and adds to the cart', async () => {
    localStorage.setItem('taneja.token', 'tok');
    const calls = mockApi({
      'GET /me': () => ({ json: retailerMe }),
      'GET /cart': () => ({ json: { cart: cart() } }),
      'GET /catalog/search': () => ({
        json: {
          items: [
            { id: 'p1', sku: 'P1', name: 'Dolo 650', genericName: 'Paracetamol', manufacturer: 'Micro Labs', strength: '650mg', packSize: '15 tabs', mrpPaise: 3360, coldChain: false, schedule: null, availability: 'in_stock', stockStale: false },
            { id: 'p2', sku: 'P2', name: 'Dolo Syrup', genericName: 'Paracetamol', manufacturer: 'Micro Labs', strength: null, packSize: null, mrpPaise: null, coldChain: false, schedule: null, availability: 'out_of_stock', stockStale: true },
          ],
        },
      }),
      'PUT /cart/items/p1': () => ({
        json: { cart: cart({ lines: [{ productId: 'p1', sku: 'P1', name: 'Dolo 650', manufacturer: 'Micro Labs', packSize: null, quantity: 1, issues: [], stockStale: false, pricing: null }] }) },
      }),
    });
    const user = userEvent.setup();
    renderApp();
    await user.type(await screen.findByLabelText('Search'), 'dolo');
    expect(await screen.findByText('Dolo 650')).toBeTruthy();
    expect(screen.getByText('Out of stock')).toBeTruthy();
    expect(screen.getByText('Stock may be outdated')).toBeTruthy();
    // Only the in-stock product can be added.
    expect(screen.getAllByRole('button', { name: 'Add' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(calls.some((c) => c.key === 'PUT /cart/items/p1')).toBe(true));
    expect(calls.find((c) => c.key === 'PUT /cart/items/p1')?.body).toEqual({ quantity: 1 });
    expect(await screen.findByRole('tab', { name: 'Cart (1)' })).toBeTruthy();
  });

  it('shows totals, line problems and checkout blockers without offering fake checkout', async () => {
    localStorage.setItem('taneja.token', 'tok');
    mockApi({
      'GET /me': () => ({ json: retailerMe }),
      'GET /cart': () => ({
        json: {
          cart: cart(
            {
              lines: [
                { productId: 'p1', sku: 'P1', name: 'Dolo 650', manufacturer: 'Micro Labs', packSize: null, quantity: 20, issues: [], stockStale: false, pricing: { valuePaise: 190000, discountPaise: 0, taxPaise: 22800, totalPaise: 212800, gstRateBps: 1200 } },
                { productId: 'p2', sku: 'P2', name: 'Augmentin', manufacturer: 'GSK', packSize: null, quantity: 8, issues: ['INSUFFICIENT_STOCK'], availableQuantity: 5, stockStale: false, pricing: null },
              ],
              subtotalPaise: 190000,
              taxPaise: 22800,
            },
            { payablePaise: 217800, orderBlockers: ['BELOW_MINIMUM_ORDER'] },
          ),
        },
      }),
    });
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole('tab', { name: 'Cart (2)' }));
    expect(screen.getByText('Only 5 available. Reduce quantity.')).toBeTruthy();
    expect(screen.getByText('Fix the highlighted items to continue.')).toBeTruthy();
    expect(screen.getByText(/Minimum order is ₹3,000/)).toBeTruthy();
    expect(screen.getByText('₹2,178.00')).toBeTruthy();
    const checkout = screen.getByRole('button', { name: 'Checkout' }) as HTMLButtonElement;
    expect(checkout.disabled).toBe(true);
  });

  it('places a COD order with an idempotency key and opens it', async () => {
    localStorage.setItem('taneja.token', 'tok');
    const line = { productId: 'p1', sku: 'P1', name: 'Dolo 650', manufacturer: 'Micro Labs', packSize: null, quantity: 100, issues: [], stockStale: false, pricing: { valuePaise: 300000, discountPaise: 0, taxPaise: 36000, totalPaise: 336000, gstRateBps: 1200 } };
    const ready = cart(
      { lines: [line], subtotalPaise: 300000, taxPaise: 36000, canCheckout: true },
      { payablePaise: 341000, canOrder: true, orderBlockers: [], codEligible: true, paymentMethods: ['prepaid', 'cod'] },
    );
    const order = {
      id: 'o1', orderNumber: 'TDA-1001', status: 'placed', paymentMethod: 'cod', paymentStatus: 'cod_due',
      subtotalPaise: 300000, discountPaise: 0, taxPaise: 36000, deliveryFeePaise: 5000, payablePaise: 341000,
      paymentDueBy: null, placedAt: '2026-10-20T10:00:00Z', items: [{ ...line, totalPaise: 336000 }],
      events: [{ kind: 'status', from: null, to: 'placed', note: null, at: '2026-10-20T10:00:00Z' }],
    };
    let failOnce = true;
    const calls = mockApi({
      'GET /me': () => ({ json: retailerMe }),
      'GET /cart': () => ({ json: { cart: ready } }),
      'POST /cart/quote': () => ({ status: 201, json: { quote: { id: 'q1' } } }),
      'POST /orders': () => {
        if (failOnce) {
          failOnce = false;
          throw new TypeError('network down');
        }
        return { status: 201, json: { order } };
      },
      'GET /orders/o1': () => ({ json: { order } }),
    });
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole('tab', { name: 'Cart (1)' }));
    expect((screen.getByLabelText('Cash on delivery') as HTMLInputElement).checked).toBe(true);
    // No payment provider is live, so online payment is not offered.
    expect(screen.queryByLabelText('Pay online')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    expect(await screen.findByText('Something went wrong. Please try again.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    expect(await screen.findByText('TDA-1001')).toBeTruthy();
    expect(screen.getByText('Pay cash on delivery')).toBeTruthy();
    const attempts = calls.filter((c) => c.key === 'POST /orders');
    expect(attempts).toHaveLength(2);
    // The retry after a network failure reuses the same quote and key.
    expect(calls.filter((c) => c.key === 'POST /cart/quote')).toHaveLength(1);
    expect(attempts[0]!.idem).toBeTruthy();
    expect(attempts[1]!.idem).toBe(attempts[0]!.idem);
    expect(attempts[1]!.body).toEqual({ quoteId: 'q1', paymentMethod: 'cod' });
  });

  it('switches to Hindi and remembers the choice', async () => {
    mockApi({});
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('button', { name: 'हिन्दी' }));
    expect(screen.getByRole('button', { name: 'OTP भेजें' })).toBeTruthy();
    expect(localStorage.getItem('taneja.lang')).toBe('hi');
  });

  it('fills in variables and falls back to the key', () => {
    expect(translate('hi', 'INSUFFICIENT_STOCK', { n: 5 })).toBe('केवल 5 उपलब्ध। मात्रा घटाएँ।');
    expect(translate('en', 'UNKNOWN_KEY')).toBe('UNKNOWN_KEY');
  });
});
