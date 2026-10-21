import { rupeesToPaise } from '@taneja/domain';
import { useState } from 'react';
import { api, type OrderDetail } from '../api';
import { Messages, Section, inr, useAction, useLoad } from '../ui';
import { OrderList, OrderSummaryCard } from './Orders';

export function Billing() {
  const [openId, setOpenId] = useState<string | null>(null);
  if (openId) return <InvoiceEntry id={openId} onBack={() => setOpenId(null)} />;
  return (
    <Section title="Billing">
      <p className="muted">Packed orders waiting for their Marg invoice. Create the invoice in Marg first, then record it here.</p>
      <OrderList status="packed" onOpen={setOpenId} />
    </Section>
  );
}

function InvoiceEntry({ id, onBack }: { id: string; onBack: () => void }) {
  const detail = useLoad(() => api<{ order: OrderDetail }>('GET', `/admin/orders/${id}`), [id]);
  const { busy, error, notice, run } = useAction();
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [mismatchReason, setMismatchReason] = useState('');
  const order = detail.data?.order;

  let amountPaise: number | null = null;
  try {
    amountPaise = amount.trim() ? rupeesToPaise(amount.trim()) : null;
  } catch {
    amountPaise = null;
  }
  const mismatch = order && amountPaise !== null && amountPaise !== order.payablePaise;

  const submit = () =>
    void run(async () => {
      await api('POST', `/billing/orders/${id}/invoice`, {
        invoiceNumber: invoiceNumber.trim(),
        amountPaise,
        ...(mismatch ? { mismatchReason: mismatchReason.trim() } : {}),
      });
      await detail.reload();
      return 'Invoice recorded. The order is ready for dispatch.';
    });

  return (
    <Section title={order?.orderNumber ?? 'Invoice'} actions={<button type="button" className="secondary" onClick={onBack}>Back</button>}>
      <Messages error={detail.error ?? error} notice={notice} />
      {order && (
        <>
          <OrderSummaryCard order={order} />
          {order.status === 'packed' && !order.invoice && (
            <form className="card" onSubmit={(e) => { e.preventDefault(); submit(); }}>
              <label>Marg invoice number<input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} pattern="[A-Za-z0-9/_\-]{1,40}" required /></label>
              <label>Invoice total (₹)<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
              {amount && amountPaise === null && <p className="error">Enter an amount like 3250.50</p>}
              {mismatch && (
                <>
                  <p className="error">The invoice total differs from the order's payable {inr(order.payablePaise)}.</p>
                  <label>Why does it differ?<textarea value={mismatchReason} onChange={(e) => setMismatchReason(e.target.value)} minLength={3} maxLength={300} required /></label>
                </>
              )}
              <button type="submit" disabled={busy || !invoiceNumber.trim() || amountPaise === null || amountPaise <= 0 || Boolean(mismatch && mismatchReason.trim().length < 3)}>
                Record invoice
              </button>
            </form>
          )}
        </>
      )}
    </Section>
  );
}
