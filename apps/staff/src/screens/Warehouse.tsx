import { useState } from 'react';
import { api, type PickLine, type Task } from '../api';
import { Messages, Section, label, useAction, useLoad } from '../ui';

const SHORT_REASONS = ['not_found', 'damaged', 'expiry_mismatch', 'other'] as const;

export function Warehouse() {
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useLoad(() => api<{ items: Task[] }>('GET', '/warehouse/tasks'));
  if (openId) return <TaskView id={openId} onBack={() => { setOpenId(null); void list.reload(); }} />;
  return (
    <Section title="Pick & pack" actions={<button type="button" className="secondary" onClick={() => void list.reload()}>Refresh</button>}>
      <Messages error={list.error} />
      {list.data?.items.length === 0 && <p className="muted">No open pick tasks.</p>}
      <table className="table">
        <tbody>
          {list.data?.items.map((t) => (
            <tr key={t.id}>
              <td><strong>{t.orderNumber}</strong></td>
              <td>{t.businessName}</td>
              <td>{t.lineCount} lines</td>
              <td><span className="badge">{label(t.status)}</span></td>
              <td><button type="button" onClick={() => setOpenId(t.id)}>Open</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

type Entry = { pickedQty: string; shortReason: string; shortNote: string };

function TaskView({ id, onBack }: { id: string; onBack: () => void }) {
  const detail = useLoad(() => api<{ task: Task }>('GET', `/warehouse/tasks/${id}`), [id]);
  const { busy, error, notice, run } = useAction();
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [packages, setPackages] = useState('1');
  const [checks, setChecks] = useState({ quantitiesMatch: false, batchAndExpiryChecked: false, sealedAndLabelled: false });
  const task = detail.data?.task;
  const openLines = task?.lines?.filter((l) => !l.confirmedAt) ?? [];

  const entry = (l: PickLine): Entry => entries[l.id] ?? { pickedQty: String(l.expectedQty), shortReason: '', shortNote: '' };
  const update = (l: PickLine, patch: Partial<Entry>) => setEntries((e) => ({ ...e, [l.id]: { ...entry(l), ...patch } }));

  const post = (path: string, body: unknown, done: string) =>
    void run(async () => {
      await api('POST', `/warehouse/tasks/${id}/${path}`, body);
      await detail.reload();
      return done;
    });

  const confirmPick = () =>
    post(
      'pick-confirmation',
      {
        lines: openLines.map((l) => {
          const e = entry(l);
          const pickedQty = Number(e.pickedQty);
          return {
            lineId: l.id,
            pickedQty,
            ...(pickedQty < l.expectedQty ? { shortReason: e.shortReason || 'other', ...(e.shortNote.trim() ? { shortNote: e.shortNote.trim() } : {}) } : {}),
          };
        }),
      },
      'Pick confirmed.',
    );

  const invalid = openLines.some((l) => {
    const q = Number(entry(l).pickedQty);
    return !Number.isInteger(q) || q < 0 || q > l.expectedQty || (q < l.expectedQty && !entry(l).shortReason);
  });

  return (
    <Section title={task ? `${task.orderNumber} · ${task.businessName}` : 'Pick task'} actions={<button type="button" className="secondary" onClick={onBack}>Back</button>}>
      <Messages error={detail.error ?? error} notice={notice} />
      {task && (
        <>
          <p><span className="badge">{label(task.status)}</span></p>
          {task.status === 'open' && <button type="button" disabled={busy} onClick={() => post('start', undefined, 'Picking started.')}>Start picking</button>}
          <table className="table">
            <thead><tr><th>Item</th><th>Batch</th><th>Rack</th><th>Take</th><th>Picked</th></tr></thead>
            <tbody>
              {task.lines?.map((l) => {
                const editable = task.status === 'picking' && !l.confirmedAt;
                const e = entry(l);
                const short = Number(e.pickedQty) < l.expectedQty;
                return (
                  <tr key={l.id}>
                    <td>{l.name} {l.packSize && <span className="muted">{l.packSize}</span>}<div className="muted">{l.sku}</div></td>
                    <td>{l.batchNumber}<div className="muted">exp {l.expiryDate}</div></td>
                    <td>{l.location ?? '—'}</td>
                    <td>{l.expectedQty}</td>
                    <td>
                      {editable ? (
                        <>
                          <input type="number" min={0} max={l.expectedQty} aria-label={`Picked ${l.name}`} value={e.pickedQty} onChange={(ev) => update(l, { pickedQty: ev.target.value })} />
                          {short && (
                            <>
                              <select aria-label={`Short reason ${l.name}`} value={e.shortReason} onChange={(ev) => update(l, { shortReason: ev.target.value })}>
                                <option value="">Why short?</option>
                                {SHORT_REASONS.map((r) => <option key={r} value={r}>{label(r)}</option>)}
                              </select>
                              <input placeholder="Note" value={e.shortNote} maxLength={300} onChange={(ev) => update(l, { shortNote: ev.target.value })} />
                            </>
                          )}
                        </>
                      ) : l.confirmedAt ? (
                        <>{l.pickedQty}{l.shortReason && <span className="error"> short: {label(l.shortReason)}</span>}</>
                      ) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {task.status === 'picking' && openLines.length > 0 && (
            <button type="button" disabled={busy || invalid} onClick={confirmPick}>Confirm pick</button>
          )}
          {task.status === 'short_pick' && <p className="error">Short pick reported. Support will cover it from other batches or cancel the order.</p>}
          {task.status === 'picked' && (
            <div className="card">
              <h2>Pack</h2>
              <label>Number of packages<input type="number" min={1} max={50} value={packages} onChange={(e) => setPackages(e.target.value)} /></label>
              <label className="check"><input type="checkbox" checked={checks.quantitiesMatch} onChange={(e) => setChecks({ ...checks, quantitiesMatch: e.target.checked })} /> Quantities match the pick list</label>
              <label className="check"><input type="checkbox" checked={checks.batchAndExpiryChecked} onChange={(e) => setChecks({ ...checks, batchAndExpiryChecked: e.target.checked })} /> Batch and expiry checked</label>
              <label className="check"><input type="checkbox" checked={checks.sealedAndLabelled} onChange={(e) => setChecks({ ...checks, sealedAndLabelled: e.target.checked })} /> Sealed and labelled</label>
              <button
                type="button"
                disabled={busy || !Object.values(checks).every(Boolean) || !(Number(packages) >= 1)}
                onClick={() => post('pack-confirmation', { packageCount: Number(packages), checklist: checks }, 'Packed. Billing can now enter the Marg invoice.')}
              >
                Confirm packed
              </button>
            </div>
          )}
          {task.status === 'packed' && <p className="ok">Packed in {task.packageCount} package(s).</p>}
        </>
      )}
    </Section>
  );
}
