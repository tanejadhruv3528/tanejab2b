import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

type Handler = (body: unknown) => { status?: number; json?: unknown };

/** Routes fetch calls to handlers keyed by "METHOD /path" (query string dropped) and records what was sent. */
function mockApi(routes: Record<string, Handler>) {
  const calls: { key: string; body: unknown; auth: string | null }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = url.replace(/^\/api/, '').split('?')[0];
      const key = `${init.method ?? 'GET'} ${path}`;
      const headers = (init.headers ?? {}) as Record<string, string>;
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
      calls.push({ key, body, auth: headers.authorization ?? null });
      const handler = routes[key];
      const res = handler ? handler(body) : { status: 404, json: { error: { code: 'NOT_FOUND', message: key } } };
      return new Response(JSON.stringify(res.json ?? {}), { status: res.status ?? 200 });
    }),
  );
  return calls;
}

const me = (...roles: string[]) => () => ({
  json: { user: { id: 'u1', phone: '+919800000009', name: 'Asha' }, roles: roles.map((role) => ({ role })) },
});

const signedIn = () => localStorage.setItem('taneja.staff.token', 'tok');

afterEach(() => vi.unstubAllGlobals());

describe('staff console', () => {
  it('signs in with OTP and shows only the screens the role allows', async () => {
    let loggedIn = false;
    const calls = mockApi({
      'POST /auth/otp/request': () => ({ json: { sent: true } }),
      'POST /auth/otp/verify': () => {
        loggedIn = true;
        return { json: { token: 'tok' } };
      },
      'GET /me': () => (loggedIn ? me('picker_packer')() : { status: 401, json: {} }),
      'GET /warehouse/tasks': () => ({ json: { items: [] } }),
    });
    render(<App />);
    await userEvent.type(screen.getByLabelText('Mobile number'), '9800000009');
    await userEvent.click(screen.getByRole('button', { name: 'Send OTP' }));
    await userEvent.type(await screen.findByLabelText('OTP'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByRole('heading', { name: 'Pick & pack' })).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByText('KYC review')).toBeNull();
    expect(calls.find((c) => c.key === 'GET /warehouse/tasks')?.auth).toBe('Bearer tok');
    expect(localStorage.getItem('taneja.staff.token')).toBe('tok');
  });

  it('tells a user without a staff role to ask the admin', async () => {
    signedIn();
    mockApi({ 'GET /me': me('retailer') });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'No staff access' })).toBeTruthy();
  });

  it('gives a super admin a menu across sections', async () => {
    signedIn();
    mockApi({
      'GET /me': me('super_admin'),
      'GET /admin/kyc/queue': () => ({ json: { items: [] } }),
      'GET /finance/cod-collections': () => ({ json: { items: [] } }),
    });
    render(<App />);
    const nav = await screen.findByRole('navigation');
    expect((nav).textContent).toContain('KYC review');
    expect(nav.textContent).not.toContain('My stops');
    await userEvent.click(screen.getByRole('button', { name: 'COD reconciliation' }));
    expect(await screen.findByRole('heading', { name: 'COD reconciliation' })).toBeTruthy();
  });

  it('makes the picker give a reason for a short line', async () => {
    signedIn();
    const task = {
      id: 't1', status: 'picking', orderId: 'o1', orderNumber: 'TDA-1001', orderStatus: 'picking', businessName: 'Shiv Medicals',
      lines: [
        { id: 'l1', sku: 'S1', name: 'Paracetamol 500', packSize: '10 tab', batchNumber: 'B1', expiryDate: '2027-05-31', location: 'A1', expectedQty: 4, pickedQty: null, shortReason: null, shortResolvedAt: null, confirmedAt: null },
      ],
    };
    const calls = mockApi({
      'GET /me': me('picker_packer'),
      'GET /warehouse/tasks': () => ({ json: { items: [{ ...task, lineCount: 1 }] } }),
      'GET /warehouse/tasks/t1': () => ({ json: { task } }),
      'POST /warehouse/tasks/t1/pick-confirmation': () => ({ json: { status: 'short_pick' } }),
    });
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open' }));
    const qty = await screen.findByLabelText('Picked Paracetamol 500');
    await userEvent.clear(qty);
    await userEvent.type(qty, '3');
    const confirm = screen.getByRole('button', { name: 'Confirm pick' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.selectOptions(screen.getByLabelText('Short reason Paracetamol 500'), 'damaged');
    await userEvent.click(confirm);
    await waitFor(() => expect(calls.some((c) => c.key === 'POST /warehouse/tasks/t1/pick-confirmation')).toBe(true));
    expect(calls.find((c) => c.key === 'POST /warehouse/tasks/t1/pick-confirmation')?.body).toEqual({
      lines: [{ lineId: 'l1', pickedQty: 3, shortReason: 'damaged' }],
    });
  });

  it('records a Marg invoice in paise and asks why a different total differs', async () => {
    signedIn();
    const order = {
      id: 'o1', orderNumber: 'TDA-1001', businessName: 'Shiv Medicals', status: 'packed', paymentMethod: 'cod', paymentStatus: 'cod_due',
      payablePaise: 325050, subtotalPaise: 300000, taxPaise: 20050, deliveryFeePaise: 5000, placedAt: '2026-10-20T05:00:00Z', itemCount: 1,
      deliveryAddress: { addressLine1: 'Main Road', city: 'Ludhiana' }, items: [{ productId: 'p1', sku: 'S1', name: 'Paracetamol 500', packSize: null, quantity: 10, totalPaise: 320050 }],
      events: [], allocations: [], invoice: null,
    };
    const calls = mockApi({
      'GET /me': me('billing_operator'),
      'GET /admin/orders': () => ({ json: { items: [order] } }),
      'GET /admin/orders/o1': () => ({ json: { order } }),
      'POST /billing/orders/o1/invoice': () => ({ json: {} }),
    });
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await userEvent.type(await screen.findByLabelText('Marg invoice number'), 'GST/1234');
    await userEvent.type(screen.getByLabelText('Invoice total (₹)'), '3250.00');
    const why = await screen.findByLabelText('Why does it differ?');
    expect((screen.getByRole('button', { name: 'Record invoice' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(why, 'Rounded off in Marg');
    await userEvent.click(screen.getByRole('button', { name: 'Record invoice' }));
    await waitFor(() => expect(calls.some((c) => c.key === 'POST /billing/orders/o1/invoice')).toBe(true));
    expect(calls.find((c) => c.key === 'POST /billing/orders/o1/invoice')?.body).toEqual({
      invoiceNumber: 'GST/1234',
      amountPaise: 325000,
      mismatchReason: 'Rounded off in Marg',
    });
  });

  it('lets a rider confirm a COD delivery with the code and the cash taken', async () => {
    signedIn();
    const stop = {
      id: 'd1', status: 'out_for_delivery', orderNumber: 'TDA-1001', businessName: 'Shiv Medicals',
      deliveryAddress: { addressLine1: 'Main Road', city: 'Ludhiana', latitude: 30.9, longitude: 75.85 }, retailerPhone: '+919800000001',
      paymentMethod: 'cod', collectPaise: 325050, packageCount: 2, otpAttemptsLeft: 5, items: [{ name: 'Paracetamol 500', packSize: null, quantity: 10 }],
    };
    const calls = mockApi({
      'GET /me': me('rider'),
      'GET /delivery/assignments': () => ({ json: { items: [stop] } }),
      'POST /delivery/assignments/d1/confirm': () => ({ json: { delivered: true } }),
    });
    render(<App />);
    expect(await screen.findByText('Collect ₹3,250.50 (COD)')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Call retailer' }).getAttribute('href')).toBe('tel:+919800000001');
    await userEvent.type(screen.getByLabelText('Delivery code from the retailer'), '654321');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm delivered' }));
    await waitFor(() => expect(calls.some((c) => c.key === 'POST /delivery/assignments/d1/confirm')).toBe(true));
    expect(calls.find((c) => c.key === 'POST /delivery/assignments/d1/confirm')?.body).toEqual({
      otp: '654321',
      cod: { method: 'cash', amountPaise: 325050 },
    });
  });

  it('shows the API error when a delivery code is wrong', async () => {
    signedIn();
    const stop = {
      id: 'd1', status: 'out_for_delivery', orderNumber: 'TDA-1001', businessName: 'Shiv Medicals', deliveryAddress: {}, retailerPhone: '+919800000001',
      paymentMethod: 'prepaid', collectPaise: 0, packageCount: 1, otpAttemptsLeft: 5, items: [],
    };
    mockApi({
      'GET /me': me('rider'),
      'GET /delivery/assignments': () => ({ json: { items: [stop] } }),
      'POST /delivery/assignments/d1/confirm': () => ({ status: 400, json: { error: { code: 'OTP_INVALID', message: 'That code is not right' } } }),
    });
    render(<App />);
    expect(await screen.findByText('Prepaid: collect nothing')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Delivery code from the retailer'), '111111');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm delivered' }));
    expect((await screen.findByRole('alert')).textContent).toContain('That code is not right');
  });

  it('needs a note before finance saves a short hand-over', async () => {
    signedIn();
    const calls = mockApi({
      'GET /me': me('finance_admin'),
      'GET /finance/cod-collections': () => ({
        json: { items: [{ id: 'c1', orderNumber: 'TDA-1001', riderName: 'Ravi', method: 'cash', expectedPaise: 325050, collectedPaise: 325050, upiReference: null, collectedAt: '2026-10-20T10:00:00Z', status: 'collected', handedOverPaise: null, reconcileNote: null }] },
      }),
      'POST /finance/cod-collections/c1/reconcile': () => ({ json: { status: 'discrepancy' } }),
    });
    render(<App />);
    const amount = await screen.findByLabelText('Handed over for TDA-1001');
    await userEvent.clear(amount);
    await userEvent.type(amount, '3000');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Note'), 'Rider to pay balance tomorrow');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.key === 'POST /finance/cod-collections/c1/reconcile')).toBe(true));
    expect(calls.find((c) => c.key === 'POST /finance/cod-collections/c1/reconcile')?.body).toEqual({
      handedOverPaise: 300000,
      note: 'Rider to pay balance tomorrow',
    });
  });
});
