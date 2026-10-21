import { rupeesToPaise } from '@taneja/domain';
import { useState } from 'react';
import { api } from '../api';
import { Messages, Section, inr, label, useAction, useLoad, when } from '../ui';

interface Collection {
  id: string;
  orderNumber: string;
  riderName: string | null;
  method: 'cash' | 'upi';
  expectedPaise: number;
  collectedPaise: number;
  upiReference: string | null;
  collectedAt: string;
  status: 'collected' | 'reconciled' | 'discrepancy';
  handedOverPaise: number | null;
  reconcileNote: string | null;
}

export function Finance() {
  const [status, setStatus] = useState('collected');
  const list = useLoad(() => api<{ items: Collection[] }>('GET', `/finance/cod-collections?status=${status}`), [status]);
  return (
    <Section title="COD reconciliation">
      <p className="muted">Record what each rider actually handed over. UPI references are as typed by the rider and are not checked with any bank.</p>
      <label>
        Show
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="collected">To reconcile</option>
          <option value="discrepancy">Discrepancies</option>
          <option value="reconciled">Reconciled</option>
        </select>
      </label>
      <Messages error={list.error} />
      {list.data?.items.length === 0 && <p className="muted">Nothing here.</p>}
      <table className="table">
        <thead><tr><th>Order</th><th>Rider</th><th>Expected</th><th>Collected</th><th>Handed over</th></tr></thead>
        <tbody>
          {list.data?.items.map((c) => <Row key={c.id} c={c} onDone={() => void list.reload()} />)}
        </tbody>
      </table>
    </Section>
  );
}

function Row({ c, onDone }: { c: Collection; onDone: () => void }) {
  const { busy, error, run } = useAction();
  const [amount, setAmount] = useState((c.collectedPaise / 100).toFixed(2));
  const [note, setNote] = useState('');
  let handedOverPaise: number | null = null;
  try {
    handedOverPaise = amount.trim() ? rupeesToPaise(amount.trim()) : null;
  } catch {
    handedOverPaise = null;
  }
  const short = handedOverPaise !== null && handedOverPaise !== c.expectedPaise;
  const open = c.status !== 'reconciled';
  return (
    <tr>
      <td><strong>{c.orderNumber}</strong><div className="muted">{when(c.collectedAt)}</div></td>
      <td>{c.riderName}<div className="muted">{c.method.toUpperCase()}{c.upiReference ? ` ${c.upiReference}` : ''}</div></td>
      <td>{inr(c.expectedPaise)}</td>
      <td className={c.collectedPaise !== c.expectedPaise ? 'error' : undefined}>{inr(c.collectedPaise)}</td>
      <td>
        {open ? (
          <form className="row" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('POST', `/finance/cod-collections/${c.id}/reconcile`, { handedOverPaise, ...(note.trim() ? { note: note.trim() } : {}) }); onDone(); }); }}>
            <input aria-label={`Handed over for ${c.orderNumber}`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 110 }} />
            {short && <input aria-label="Note" placeholder="Note on the difference" value={note} onChange={(e) => setNote(e.target.value)} minLength={3} maxLength={500} required />}
            <button type="submit" disabled={busy || handedOverPaise === null || (short && note.trim().length < 3)}>Save</button>
            {c.status === 'discrepancy' && c.reconcileNote && <span className="muted">{c.reconcileNote}</span>}
            {error && <span className="error" role="alert">{error}</span>}
          </form>
        ) : (
          <>{inr(c.handedOverPaise ?? 0)} <span className="badge">{label(c.status)}</span></>
        )}
      </td>
    </tr>
  );
}
