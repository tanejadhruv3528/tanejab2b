import { useState, type FormEvent } from 'react';
import { api, setToken } from '../api';
import { Messages, useAction } from '../ui';

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const { busy, error, run } = useAction();

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
      <h1>Taneja Staff</h1>
      <p className="muted">For Taneja Drug Agency staff and riders. Sign in with your registered mobile number.</p>
      {step === 'phone' ? (
        <form onSubmit={requestOtp} className="card">
          <label>
            Mobile number
            <input type="tel" inputMode="numeric" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required />
          </label>
          <button type="submit" disabled={busy || phone.replace(/\D/g, '').length < 10}>
            Send OTP
          </button>
        </form>
      ) : (
        <form onSubmit={verify} className="card">
          <p>OTP sent to {phone}</p>
          <label>
            OTP
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
            Verify and sign in
          </button>
          <button type="button" className="link" onClick={() => setStep('phone')}>
            Change number
          </button>
        </form>
      )}
      <Messages error={error} />
    </main>
  );
}
