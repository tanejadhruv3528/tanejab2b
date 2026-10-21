import { formatINR, paise } from '@taneja/domain';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ApiError } from './api';

export const inr = (amount: number): string => formatINR(paise(amount));
export const label = (value: string): string => value.replaceAll('_', ' ');
export const when = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '';

export function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Something went wrong. Please try again.';
}

/** Loads data once and on demand; keeps the last error for display. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(async () => {
    try {
      setData(await load());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload };
}

/** Runs one action at a time and turns failures into a message. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const message = await fn();
      if (message) setNotice(message);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, notice, run };
}

export function Messages({ error, notice }: { error?: string | null; notice?: string | null }) {
  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="ok" role="status">
          {notice}
        </p>
      )}
    </>
  );
}

/** A button that opens a reason box before an action that must be explained (and is audited). */
export function ReasonAction({
  title,
  confirm,
  busy,
  onSubmit,
  danger,
}: {
  title: string;
  confirm?: string;
  busy: boolean;
  onSubmit: (reason: string) => void;
  danger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) {
    return (
      <button type="button" className={danger ? 'secondary danger' : 'secondary'} onClick={() => setOpen(true)}>
        {title}
      </button>
    );
  }
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(reason.trim());
        setOpen(false);
        setReason('');
      }}
    >
      <label>
        Reason for “{title}”
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={500} />
      </label>
      <div className="row">
        <button type="submit" disabled={busy || reason.trim().length < 3}>
          {confirm ?? title}
        </button>
        <button type="button" className="secondary" onClick={() => setOpen(false)}>
          Back
        </button>
      </div>
    </form>
  );
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <main className="screen">
      <div className="spread">
        <h1>{title}</h1>
        {actions}
      </div>
      {children}
    </main>
  );
}

export function Address({ value }: { value: Record<string, string | number | null> }) {
  const parts = ['addressLine1', 'addressLine2', 'landmark', 'city', 'district', 'postalCode']
    .map((k) => value[k])
    .filter((v) => v !== null && v !== undefined && v !== '');
  return <span>{parts.join(', ')}</span>;
}
