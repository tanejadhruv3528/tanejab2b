import { useState, type FormEvent } from 'react';
import { api, ApiError, setToken } from '../api';
import { useI18n } from '../i18n';

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const { t } = useI18n();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('genericError'));
    } finally {
      setBusy(false);
    }
  }

  const requestOtp = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('POST', '/auth/otp/request', { phone });
      setStep('code');
    });
  };

  const verify = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await api<{ token: string }>('POST', '/auth/otp/verify', { phone, code });
      setToken(res.token);
      onLoggedIn();
    });
  };

  return (
    <main className="screen narrow">
      <h1>{t('appName')}</h1>
      <p className="muted">{t('tagline')}</p>
      {step === 'phone' ? (
        <form onSubmit={requestOtp} className="card">
          <label>
            {t('phone')}
            <input
              type="tel"
              inputMode="numeric"
              autoComplete="tel"
              placeholder="98XXXXXXXX"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
            />
          </label>
          <button type="submit" disabled={busy || phone.replace(/\D/g, '').length < 10}>
            {t('sendOtp')}
          </button>
        </form>
      ) : (
        <form onSubmit={verify} className="card">
          <p>
            {t('otpSentTo')} {phone}
          </p>
          <label>
            {t('otp')}
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              required
            />
          </label>
          <button type="submit" disabled={busy || code.length !== 6}>
            {t('verify')}
          </button>
          <button type="button" className="link" onClick={() => setStep('phone')}>
            {t('changeNumber')}
          </button>
        </form>
      )}
      {error && <p role="alert" className="error">{error}</p>}
    </main>
  );
}
