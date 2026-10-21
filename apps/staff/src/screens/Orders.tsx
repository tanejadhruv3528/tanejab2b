import { useState } from 'react';
import { api, type OrderDetail, type OrderSummary } from '../api';
import { Address, Messages, ReasonAction, Section, inr, label, useAction, useLoad, when } from '../ui';

const FILTERS = ['placed', 'short_pick_review', 'cancel_requested', 'accepted', 'picking', 'packed', 'ready_for_dispatch', 'delivery_failed', 'delivered', 'cancelled'];
const CANCELLABLE = ['placed', 'accepted', 'picking', 'short_pick_review', 'packed', 'ready_for_dispatch', 'cancel_requested'];

export function OrderList({ status, onOpen }: { status: string; onOpen: (id: string) => void }) {
  const list = useLoad(() => api<{ items: OrderSummary[] }>('GET', `/admin/orders?status=${status}`), [status]);
  return (
    <>
      <Messages error={list.error} />
      {list.data?.items.length === 0 && <p className="muted">No orders are {label(status)}.</p>}
      <table className="table">
        <tbody>
          {list.data?.items.map((o) => (
            <tr key={o.id}>
              <td><strong>{o.orderNumber}</strong><div className="muted">{when(o.placedAt)}</div></td>
              <td>{o.businessName}</td>
              <td>{o.itemCount} items · {inr(o.payablePaise)}</td>
              <td><span className="badge">{o.paymentMethod === 'cod' ? 'COD' : 'Prepaid'}</span><span className="badge">{label(o.paymentStatus)}</span></td>
              <td><button type="button" onClick={() => onOpen(o.id)}>Open</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function Orders() {
  const [status, setStatus] = useState('placed');
  const [openId, setOpenId] = useState<string | null>(null);
  if (openId) return <SupportOrder id={openId} onBack={() => setOpenId(null)} />;
  return (
    <Section title="Orders">
      <label>
        Show
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {FILTERS.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
      </label>
      <OrderList status={status} onOpen={setOpenId} />
    </Section>
  );
}

export function OrderSummaryCard({ order }: { order: OrderDetail }) {
  return (
    <div className="card">
      <div><span className="badge">{label(order.status)}</span><span className="badge">{order.paymentMethod === 'cod' ? 'COD' : 'Prepaid'}: {label(order.paymentStatus)}</span></div>
      <div>{order.businessName} · <Address value={order.deliveryAddress} /></div>
      <table className="table">
        <tbody>
          {order.items.map((i) => (
            <tr key={i.productId}><td>{i.name} {i.packSize && <span className="muted">{i.packSize}</span>}</td><td>× {i.quantity}</td><td>{inr(i.totalPaise)}</td></tr>
          ))}
          <tr><td>Delivery</td><td /><td>{inr(order.deliveryFeePaise)}</td></tr>
          <tr><td><strong>Payable</strong></td><td /><td><strong>{inr(order.payablePaise)}</strong></td></tr>
        </tbody>
      </table>
      {order.invoice && <div>Marg invoice {order.invoice.invoiceNumber}: {inr(order.invoice.amountPaise)}</div>}
    </div>
  );
}

function SupportOrder({ id, onBack }: { id: string; onBack: () => void }) {
  const detail = useLoad(() => api<{ order: OrderDetail }>('GET', `/admin/orders/${id}`), [id]);
  const { busy, error, notice, run } = useAction();
  const order = detail.data?.order;
  const act = (path: string, body: unknown, done: string) =>
    void run(async () => {
      await api('POST', `/admin/orders/${id}/${path}`, body);
      await detail.reload();
      return done;
    });

  return (
    <Section title={order?.orderNumber ?? 'Order'} actions={<button type="button" className="secondary" onClick={onBack}>Back</button>}>
      <Messages error={detail.error ?? error} notice={notice} />
      {order && (
        <>
          <OrderSummaryCard order={order} />
          <div className="row">
            {order.status === 'placed' && (
              <button type="button" disabled={busy} onClick={() => act('accept', undefined, 'Accepted. A pick task was created.')}>Accept order</button>
            )}
            {order.status === 'short_pick_review' && (
              <ReasonAction title="Cover shortfall from other batches" busy={busy} onSubmit={(reason) => act('short-pick/reallocate', { reason }, 'Re-allocated. The picker has new lines.')} />
            )}
            {order.status === 'cancel_requested' && (
              <ReasonAction title="Decline cancellation" busy={busy} onSubmit={(reason) => act('cancel-request/decline', { reason }, 'Cancellation request declined.')} />
            )}
            {CANCELLABLE.includes(order.status) && (
              <ReasonAction title="Cancel order" danger busy={busy} onSubmit={(reason) => act('cancel', { reason }, 'Order cancelled and stock released.')} />
            )}
          </div>
          {order.allocations.length > 0 && (
            <>
              <h2>Stock held</h2>
              <table className="table">
                <tbody>
                  {order.allocations.map((a, i) => (
                    <tr key={i}><td>{order.items.find((x) => x.productId === a.productId)?.name}</td><td>Batch {a.batchNumber}, exp {a.expiryDate}</td><td>{a.location}</td><td>{a.quantity}</td><td>{a.releasedAt ? 'released' : 'held'}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <h2>History</h2>
          <ul>
            {order.events.map((e, i) => (
              <li key={i}>{when(e.at)}: {e.from ? `${label(e.from)} → ` : ''}{label(e.to)}{e.note ? `. ${e.note}` : ''}</li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}
