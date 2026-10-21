import { useState } from 'react';
import { api, type OrderSummary } from '../api';
import { Address, Messages, ReasonAction, Section, inr, label, useAction, useLoad, when } from '../ui';

interface Rider { id: string; name: string | null; phone: string; liveStops: number }
interface Assignment {
  id: string;
  status: string;
  orderNumber: string;
  businessName: string;
  deliveryAddress: Record<string, string | number | null>;
  riderName: string | null;
  collectPaise: number;
  packageCount: number | null;
  assignedAt: string;
}

export function Dispatch() {
  const ready = useLoad(() => api<{ items: OrderSummary[] }>('GET', '/admin/orders?status=ready_for_dispatch'));
  const failed = useLoad(() => api<{ items: OrderSummary[] }>('GET', '/admin/orders?status=delivery_failed'));
  const riders = useLoad(() => api<{ items: Rider[] }>('GET', '/dispatch/riders'));
  const live = useLoad(async () => {
    const [a, b] = await Promise.all([
      api<{ items: Assignment[] }>('GET', '/dispatch/assignments?status=assigned'),
      api<{ items: Assignment[] }>('GET', '/dispatch/assignments?status=out_for_delivery'),
    ]);
    return [...a.items, ...b.items];
  });
  const { busy, error, notice, run } = useAction();
  const [choice, setChoice] = useState<Record<string, string>>({});

  const reloadAll = () => Promise.all([ready.reload(), failed.reload(), riders.reload(), live.reload()]);
  const act = (fn: () => Promise<unknown>, done: string) =>
    void run(async () => {
      await fn();
      await reloadAll();
      return done;
    });

  return (
    <Section title="Dispatch" actions={<button type="button" className="secondary" onClick={() => void reloadAll()}>Refresh</button>}>
      <Messages error={ready.error ?? riders.error ?? live.error ?? failed.error ?? error} notice={notice} />
      <h2>Ready to send</h2>
      {ready.data?.items.length === 0 && <p className="muted">Nothing waiting.</p>}
      <table className="table">
        <tbody>
          {ready.data?.items.map((o) => (
            <tr key={o.id}>
              <td><strong>{o.orderNumber}</strong></td>
              <td>{o.businessName}</td>
              <td>{o.paymentMethod === 'cod' && o.paymentStatus === 'cod_due' ? `Collect ${inr(o.payablePaise)}` : 'Prepaid'}</td>
              <td>
                <select aria-label={`Rider for ${o.orderNumber}`} value={choice[o.id] ?? ''} onChange={(e) => setChoice({ ...choice, [o.id]: e.target.value })}>
                  <option value="">Choose rider</option>
                  {riders.data?.items.map((r) => <option key={r.id} value={r.id}>{r.name ?? r.phone} ({r.liveStops} stops)</option>)}
                </select>
              </td>
              <td>
                <button
                  type="button"
                  disabled={busy || !choice[o.id]}
                  onClick={() => act(() => api('POST', '/dispatch/assignments', { orderId: o.id, riderUserId: choice[o.id] }), `${o.orderNumber} assigned.`)}
                >
                  Assign
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {riders.data?.items.length === 0 && <p className="error">No active riders. Ask the admin to grant the rider role.</p>}

      <h2>With riders</h2>
      {live.data?.length === 0 && <p className="muted">No live deliveries.</p>}
      <table className="table">
        <tbody>
          {live.data?.map((a) => (
            <tr key={a.id}>
              <td><strong>{a.orderNumber}</strong><div className="muted">{when(a.assignedAt)}</div></td>
              <td>{a.businessName}<div className="muted"><Address value={a.deliveryAddress} /></div></td>
              <td>{a.riderName}</td>
              <td><span className="badge">{label(a.status)}</span></td>
              <td>
                {a.status === 'assigned' && (
                  <ReasonAction title="Unassign" busy={busy} onSubmit={(reason) => act(() => api('POST', `/dispatch/assignments/${a.id}/cancel`, { reason }), `${a.orderNumber} unassigned.`)} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Failed attempts</h2>
      {failed.data?.items.length === 0 && <p className="muted">None.</p>}
      <table className="table">
        <tbody>
          {failed.data?.items.map((o) => (
            <tr key={o.id}>
              <td><strong>{o.orderNumber}</strong></td>
              <td>{o.businessName}</td>
              <td>
                <ReasonAction title="Send again" busy={busy} onSubmit={(reason) => act(() => api('POST', `/dispatch/orders/${o.id}/redispatch`, { reason }), `${o.orderNumber} is back in the queue.`)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
