import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, getToken, setToken, type Me } from './api';
import { Billing } from './screens/Billing';
import { Dispatch } from './screens/Dispatch';
import { Finance } from './screens/Finance';
import { Kyc } from './screens/Kyc';
import { Login } from './screens/Login';
import { Orders } from './screens/Orders';
import { Rider } from './screens/Rider';
import { Warehouse } from './screens/Warehouse';

/** Each screen and the roles that may open it. The API enforces the same roles; this only hides menu items. */
const SCREENS = [
  { key: 'kyc', title: 'KYC review', roles: ['kyc_reviewer', 'super_admin'], view: Kyc },
  { key: 'orders', title: 'Orders', roles: ['support_operator', 'super_admin'], view: Orders },
  { key: 'warehouse', title: 'Pick & pack', roles: ['picker_packer', 'super_admin'], view: Warehouse },
  { key: 'billing', title: 'Billing', roles: ['billing_operator', 'super_admin'], view: Billing },
  { key: 'dispatch', title: 'Dispatch', roles: ['dispatcher', 'super_admin'], view: Dispatch },
  { key: 'rider', title: 'My stops', roles: ['rider'], view: Rider },
  { key: 'finance', title: 'COD reconciliation', roles: ['finance_admin', 'super_admin'], view: Finance },
] as const;

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(Boolean(getToken()));
  const [active, setActive] = useState<string | null>(null);

  const loadMe = useCallback(async () => {
    if (!getToken()) {
      setMe(null);
      setLoading(false);
      return;
    }
    try {
      setMe(await api<Me>('GET', '/me'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  const logout = async () => {
    await api('POST', '/auth/logout').catch(() => undefined);
    setToken(null);
    setMe(null);
    setActive(null);
  };

  const roles = new Set(me?.roles.map((r) => r.role) ?? []);
  const allowed = SCREENS.filter((s) => s.roles.some((r) => roles.has(r)));
  const current = allowed.find((s) => s.key === active) ?? allowed[0];
  const View = current?.view;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Taneja Staff</span>
        {me && (
          <div className="topbar-actions">
            <span className="muted">{me.user.name ?? me.user.phone}</span>
            <button type="button" className="link" onClick={() => void logout()}>
              Log out
            </button>
          </div>
        )}
      </header>
      {loading ? null : !me ? (
        <Login onLoggedIn={() => void loadMe()} />
      ) : !View ? (
        <main className="screen narrow">
          <h1>No staff access</h1>
          <p className="muted">
            This number has no staff role yet. Ask the Taneja admin to grant one. Retailers should use the ordering app instead.
          </p>
        </main>
      ) : (
        <>
          {allowed.length > 1 && (
            <nav className="menu" aria-label="Sections">
              {allowed.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  aria-current={s.key === current!.key ? 'page' : undefined}
                  onClick={() => setActive(s.key)}
                >
                  {s.title}
                </button>
              ))}
            </nav>
          )}
          <View key={current!.key} />
        </>
      )}
    </div>
  );
}
