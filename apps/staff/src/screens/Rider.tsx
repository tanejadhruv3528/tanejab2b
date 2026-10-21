import { rupeesToPaise } from '@taneja/domain';
import { useState } from 'react';
import { api, type Stop } from '../api';
import { Address, Messages, Section, inr, label, useAction, useLoad } from '../ui';

const FAIL_REASONS = ['store_closed', 'retailer_refused', 'address_issue', 'payment_not_ready', 'otp_unavailable', 'other'] as const;

export function Rider() {
  const stops = useLoad(() => api<{ items: Stop[]; deliveryWindow?: { start: string; end: string } }>('GET', '/delivery/assignments'));
  return (
    <Section title="My stops" actions={<button type="button" className="secondary" onClick={() => void stops.reload()}>Refresh</button>}>
      <Messages error={stops.error} />
      {stops.data?.items.length === 0 && <p className="muted">No stops assigned to you.</p>}
      {stops.data?.items.map((s) => <StopCard key={s.id} stop={s} onChange={() => void stops.reload()} />)}
    </Section>
  );
}

function StopCard({ stop, onChange }: { stop: Stop; onChange: () => void }) {
  const { busy, error, notice, run } = useAction();
  const [otp, setOtp] = useState('');
  const [method, setMethod] = useState<'cash' | 'upi'>('cash');
  const [amount, setAmount] = useState(stop.collectPaise ? (stop.collectPaise / 100).toFixed(2) : '');
  const [upiRef, setUpiRef] = useState('');
  const [failing, setFailing] = useState(false);
  const [failReason, setFailReason] = useState('');
  const [failNote, setFailNote] = useState('');
  const cod = stop.collectPaise > 0;
  let amountPaise: number | null = null;
  try {
    amountPaise = amount.trim() ? rupeesToPaise(amount.trim()) : null;
  } catch {
    amountPaise = null;
  }
  const address = stop.deliveryAddress;
  const mapQuery = address.latitude != null ? `${address.latitude},${address.longitude}` : encodeURIComponent(Object.values(address).filter(Boolean).join(', '));

  const act = (fn: () => Promise<unknown>, done: string) =>
    void run(async () => {
      await fn();
      onChange();
      return done;
    });

  const confirm = () =>
    act(
      () =>
        api('POST', `/delivery/assignments/${stop.id}/confirm`, {
          otp,
          ...(cod ? { cod: { method, amountPaise, ...(method === 'upi' && upiRef.trim() ? { upiReference: upiRef.trim() } : {}) } } : {}),
        }),
      'Delivered.',
    );

  return (
    <div className="card">
      <div className="spread">
        <strong>{stop.orderNumber} · {stop.businessName}</strong>
        <span className="badge">{label(stop.status)}</span>
      </div>
      <Address value={address} />
      <div className="row">
        <a href={`tel:${stop.retailerPhone}`}>Call retailer</a>
        <a href={`https://maps.google.com/?q=${mapQuery}`} target="_blank" rel="noreferrer">Open map</a>
      </div>
      <div>{stop.packageCount ?? '?'} package(s) · {stop.items.map((i) => `${i.name} × ${i.quantity}`).join(', ')}</div>
      <div><strong>{cod ? `Collect ${inr(stop.collectPaise)} (COD)` : 'Prepaid: collect nothing'}</strong></div>
      <Messages error={error} notice={notice} />
      {stop.status === 'assigned' && (
        <button type="button" disabled={busy} onClick={() => act(() => api('POST', `/delivery/assignments/${stop.id}/start`), 'On the way. The retailer was sent a delivery code.')}>
          Start delivery
        </button>
      )}
      {stop.status === 'out_for_delivery' && !failing && (
        <form className="card" onSubmit={(e) => { e.preventDefault(); confirm(); }}>
          <label>
            Delivery code from the retailer
            <input inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} required />
          </label>
          <span className="muted">{stop.otpAttemptsLeft} attempts left</span>
          {cod && (
            <>
              <label>
                Paid by
                <select value={method} onChange={(e) => setMethod(e.target.value as 'cash' | 'upi')}>
                  <option value="cash">Cash</option>
                  <option value="upi">UPI</option>
                </select>
              </label>
              <label>Amount received (₹)<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
              {amountPaise !== null && amountPaise !== stop.collectPaise && <p className="error">This differs from {inr(stop.collectPaise)}. Finance will follow up.</p>}
              {method === 'upi' && <label>UPI reference (from the retailer's screen)<input value={upiRef} onChange={(e) => setUpiRef(e.target.value.replace(/[^A-Za-z0-9]/g, ''))} maxLength={35} /></label>}
            </>
          )}
          <div className="row">
            <button type="submit" disabled={busy || otp.length !== 6 || (cod && amountPaise === null)}>Confirm delivered</button>
            <button type="button" className="secondary danger" onClick={() => setFailing(true)}>Could not deliver</button>
          </div>
        </form>
      )}
      {failing && (
        <form className="card" onSubmit={(e) => { e.preventDefault(); act(() => api('POST', `/delivery/assignments/${stop.id}/fail`, { reason: failReason, ...(failNote.trim() ? { note: failNote.trim() } : {}) }), 'Marked as not delivered. Bring the goods back to the warehouse.'); }}>
          <label>
            What happened?
            <select value={failReason} onChange={(e) => setFailReason(e.target.value)} required>
              <option value="">Choose</option>
              {FAIL_REASONS.map((r) => <option key={r} value={r}>{label(r)}</option>)}
            </select>
          </label>
          <label>Note<input value={failNote} onChange={(e) => setFailNote(e.target.value)} maxLength={300} /></label>
          <div className="row">
            <button type="submit" disabled={busy || !failReason}>Report failed attempt</button>
            <button type="button" className="secondary" onClick={() => setFailing(false)}>Back</button>
          </div>
        </form>
      )}
    </div>
  );
}
