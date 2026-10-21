import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, getToken, setToken, type Cart, type Me } from './api';
import { useI18n } from './i18n';
import { CartView } from './screens/CartView';
import { Catalog } from './screens/Catalog';
import { Login } from './screens/Login';
import { Onboarding } from './screens/Onboarding';
import { Orders } from './screens/Orders';

type Tab = 'search' | 'cart' | 'orders';

export function App() {
  const { t, lang, setLang } = useI18n();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(Boolean(getToken()));

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
  };

  const isRetailer = me?.roles.some((r) => r.role === 'retailer' && r.retailerAccountId) ?? false;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">{t('appName')}</span>
        <div className="topbar-actions">
          <button type="button" className="link" onClick={() => setLang(lang === 'en' ? 'hi' : 'en')}>
            {lang === 'en' ? 'हिन्दी' : 'English'}
          </button>
          {me && (
            <button type="button" className="link" onClick={() => void logout()}>
              {t('logout')}
            </button>
          )}
        </div>
      </header>
      {import.meta.env.VITE_DEMO === 'true' && (
        <p className="demo-banner">
          {t('demoBanner')}
        </p>
      )}
      {loading ? null : !me ? (
        <Login onLoggedIn={() => void loadMe()} />
      ) : isRetailer ? (
        <Shop />
      ) : (
        <Onboarding onApproved={() => void loadMe()} />
      )}
    </div>
  );
}

function Shop() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('search');
  const [cart, setCart] = useState<Cart | null>(null);
  const [onlinePayment, setOnlinePayment] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openOrderId, setOpenOrderId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await api<{ cart: Cart; onlinePaymentAvailable?: boolean }>('GET', '/cart');
    setCart(res.cart);
    setOnlinePayment(res.onlinePaymentAvailable === true);
  }, []);

  useEffect(() => {
    void refresh().catch(() => setError(t('genericError')));
  }, [refresh, t]);

  const setQuantity = async (productId: string, quantity: number) => {
    setError(null);
    try {
      const res = await api<{ cart: Cart }>('PUT', `/cart/items/${productId}`, { quantity });
      setCart(res.cart);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('genericError'));
    }
  };

  const inCart = new Map(cart?.lines.map((l) => [l.productId, l.quantity]) ?? []);
  const count = cart?.lines.length ?? 0;

  return (
    <main className="screen">
      <nav className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'search'} onClick={() => setTab('search')}>
          {t('search')}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'cart'} onClick={() => setTab('cart')}>
          {t('cart')}
          {count > 0 && ` (${count})`}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'orders'}
          onClick={() => {
            setOpenOrderId(null);
            setTab('orders');
          }}
        >
          {t('orders')}
        </button>
      </nav>
      {error && <p role="alert" className="error">{error}</p>}
      {tab === 'search' && <Catalog onAdd={setQuantity} inCart={inCart} />}
      {tab === 'cart' && (
        <CartView
          cart={cart}
          onlinePayment={onlinePayment}
          onSetQuantity={setQuantity}
          onCleared={() => void refresh()}
          onOrdered={(order) => {
            void refresh();
            setOpenOrderId(order.id);
            setTab('orders');
          }}
        />
      )}
      {tab === 'orders' && <Orders openOrderId={openOrderId} onOpen={setOpenOrderId} />}
    </main>
  );
}
