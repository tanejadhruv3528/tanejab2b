import { useEffect, useState } from 'react';
import { api, fetchFileUrl } from '../api';
import { Messages, Section, label, useAction, useLoad, when } from '../ui';

interface QueueItem {
  id: string;
  businessName: string | null;
  ownerName: string | null;
  ownerPhone: string;
  status: string;
  submittedAt: string | null;
  district: string | null;
  postalCode: string | null;
}

interface Detail {
  account: { id: string; businessName: string | null; ownerName: string | null; ownerPhone: string; gstin: string | null; status: string; codAllowed: boolean };
  store: Record<string, string | number | boolean | null> | null;
  license: { type: string; number: string; validUntil: string } | null;
  documents: { id: string; kind: string; contentType: string; sizeBytes: number }[];
  gaps: string[];
  history: { fromStatus: string; toStatus: string; reason: string | null; decidedAt: string; reviewerName: string | null }[];
}

export function Kyc() {
  const [selected, setSelected] = useState<string | null>(null);
  const queue = useLoad(() => api<{ items: QueueItem[] }>('GET', '/admin/kyc/queue'));
  if (selected) return <KycDetail accountId={selected} onBack={() => { setSelected(null); void queue.reload(); }} />;
  return (
    <Section title="KYC review" actions={<button type="button" className="secondary" onClick={() => void queue.reload()}>Refresh</button>}>
      <p className="muted">Oldest submissions first. Approve only after checking the licence and the store premises.</p>
      <Messages error={queue.error} />
      {queue.data?.items.length === 0 && <p>No applications waiting.</p>}
      <table className="table">
        <tbody>
          {queue.data?.items.map((a) => (
            <tr key={a.id}>
              <td>
                <strong>{a.businessName ?? 'Unnamed store'}</strong>
                <div className="muted">{a.ownerName} · {a.ownerPhone}</div>
              </td>
              <td>{[a.district, a.postalCode].filter(Boolean).join(' ')}</td>
              <td><span className="badge">{label(a.status)}</span></td>
              <td>{when(a.submittedAt)}</td>
              <td><button type="button" onClick={() => setSelected(a.id)}>Review</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function KycDetail({ accountId, onBack }: { accountId: string; onBack: () => void }) {
  const detail = useLoad(() => api<Detail>('GET', `/admin/kyc/${accountId}`), [accountId]);
  const { busy, error, notice, run } = useAction();
  const [preview, setPreview] = useState<{ url: string; type: string } | null>(null);
  const [reason, setReason] = useState('');
  const [storeVerified, setStoreVerified] = useState(false);
  const [codAllowed, setCodAllowed] = useState(false);
  const [serviceZone, setServiceZone] = useState('');

  const d = detail.data;
  useEffect(() => {
    if (!d) return;
    setStoreVerified(Boolean(d.store?.verified));
    setCodAllowed(d.account.codAllowed);
    setServiceZone(String(d.store?.serviceZone ?? ''));
  }, [d]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  const open = (doc: Detail['documents'][number]) =>
    void run(async () => {
      const url = await fetchFileUrl(`/admin/kyc/${accountId}/documents/${doc.id}`);
      setPreview({ url, type: doc.contentType });
    });

  const decide = (status: string) =>
    void run(async () => {
      await api('POST', `/admin/kyc/${accountId}/decision`, {
        status,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        storeVerified,
        serviceZone: serviceZone.trim() || null,
        codAllowed,
      });
      await detail.reload();
      return `Marked ${label(status)}.`;
    });

  return (
    <Section title={d?.account.businessName ?? 'Application'} actions={<button type="button" className="secondary" onClick={onBack}>Back to queue</button>}>
      <Messages error={detail.error ?? error} notice={notice} />
      {d && (
        <>
          <div className="card">
            <div><span className="badge">{label(d.account.status)}</span></div>
            <div>Owner: {d.account.ownerName} · {d.account.ownerPhone}</div>
            <div>GSTIN: {d.account.gstin ?? 'not given'}</div>
            {d.license && <div>Drug licence: {d.license.type} {d.license.number}, valid until {d.license.validUntil}</div>}
            {d.store && (
              <div>
                Store: {[d.store.addressLine1, d.store.addressLine2, d.store.landmark, d.store.city, d.store.district, d.store.postalCode].filter(Boolean).join(', ')}
                {d.store.latitude != null && (
                  <> · <a href={`https://maps.google.com/?q=${d.store.latitude},${d.store.longitude}`} target="_blank" rel="noreferrer">Map pin</a></>
                )}
              </div>
            )}
            {d.gaps.length > 0 && <p className="error">Missing: {d.gaps.map(label).join(', ')}</p>}
          </div>
          <h2>Documents</h2>
          <div className="row">
            {d.documents.map((doc) => (
              <button key={doc.id} type="button" className="secondary" onClick={() => open(doc)} disabled={busy}>
                {label(doc.kind)}
              </button>
            ))}
            {d.documents.length === 0 && <span className="muted">No documents uploaded.</span>}
          </div>
          {preview &&
            (preview.type === 'application/pdf' ? (
              <iframe title="Document" src={preview.url} className="doc-preview" style={{ width: '100%', height: 480 }} />
            ) : (
              <img alt="KYC document" src={preview.url} className="doc-preview" />
            ))}
          <h2>Decision</h2>
          <div className="card">
            <label className="check"><input type="checkbox" checked={storeVerified} onChange={(e) => setStoreVerified(e.target.checked)} /> Store premises verified</label>
            <label className="check"><input type="checkbox" checked={codAllowed} onChange={(e) => setCodAllowed(e.target.checked)} /> Allow cash on delivery</label>
            <label>Service zone<input value={serviceZone} onChange={(e) => setServiceZone(e.target.value)} maxLength={100} /></label>
            <label>Reason or note (shown to the retailer when rejecting or asking for changes)<textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} /></label>
            <div className="row">
              <button type="button" disabled={busy} onClick={() => decide('approved')}>Approve</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => decide('under_review')}>Mark under review</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => decide('needs_resubmission')}>Ask for changes</button>
              <button type="button" className="secondary danger" disabled={busy} onClick={() => decide('rejected')}>Reject</button>
            </div>
          </div>
          {d.history.length > 0 && (
            <>
              <h2>History</h2>
              <ul>
                {d.history.map((h, i) => (
                  <li key={i}>{when(h.decidedAt)}: {label(h.fromStatus)} → {label(h.toStatus)} by {h.reviewerName ?? 'staff'}{h.reason ? `. ${h.reason}` : ''}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Section>
  );
}
