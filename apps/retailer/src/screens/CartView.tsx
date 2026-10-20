import { DEFAULT_CHECKOUT_POLICY, formatINR, paise } from '@taneja/domain';
import { useState } from 'react';
import { api, ApiError, newIdempotencyKey, type Cart, type Order } from '../api';
import { useI18n } from '../i18n';

const inr = (value: number) => formatINR(paise(value));

export function CartView({
  cart,
  onlinePayment,
  onSetQuantity,
  onCleared,
  onOrdered,
}: {
  cart: Cart | null;
  onlinePayment: boolean;
  onSetQuantity: (productId: string, quantity: number) => Promise<void>;
  onCleared: () => void;
  onOrdered: (order: Order) => void;
}) {
  const { t } = useI18n();
  if (!cart) return null;
  if (cart.lines.length === 0) return <p className="muted">{t('emptyCart')}</p>;
  const c = cart.checkout;
  const hasLineIssues = cart.lines.some((l) => l.issues.length > 0);
  const methods = c.paymentMethods.filter((m) => m !== 'prepaid' || onlinePayment);

  return (
    <section>
      <ul className="list">
        {cart.lines.map((line) => (
          <li key={line.productId} className={`card line ${line.issues.length ? 'problem' : ''}`}>
            <div>
              <strong>{line.name}</strong>
              <div className="muted small">
                {[line.packSize, line.manufacturer].filter(Boolean).join(' · ')}
              </div>
              {line.issues.map((issue) => (
                <div key={issue} className="error small">
                  {t(issue, { n: line.availableQuantity ?? 0 })}
                </div>
              ))}
              {line.stockStale && <div className="muted small">{t('stale')}</div>}
            </div>
            <div className="line-right">
              <input
                type="number"
                min={0}
                max={10000}
                aria-label={`${t('qty')} ${line.name}`}
                key={line.quantity}
                defaultValue={line.quantity}
                onBlur={(e) => {
                  const n = Math.max(0, Math.min(10000, Math.floor(Number(e.target.value) || 0)));
                  if (n !== line.quantity) void onSetQuantity(line.productId, n);
                }}
              />
              {line.pricing && <div className="amount">{inr(line.pricing.totalPaise)}</div>}
              <button type="button" className="link" onClick={() => void onSetQuantity(line.productId, 0)}>
                {t('remove')}
              </button>
            </div>
          </li>
        ))}
      </ul>

      <dl className="card totals">
        <dt>{t('subtotal')}</dt>
        <dd>{inr(cart.subtotalPaise)}</dd>
        {cart.discountPaise > 0 && (
          <>
            <dt>{t('discount')}</dt>
            <dd>−{inr(cart.discountPaise)}</dd>
          </>
        )}
        <dt>{t('gst')}</dt>
        <dd>{inr(cart.taxPaise)}</dd>
        <dt>{t('delivery')}</dt>
        <dd>{inr(c.deliveryFeePaise)}</dd>
        <dt className="strong">{t('payable')}</dt>
        <dd className="strong">{inr(c.payablePaise)}</dd>
      </dl>

      <div className="card notes">
        {hasLineIssues && <p className="error">{t('fixLines')}</p>}
        {c.orderBlockers.map((b) => (
          <p key={b} className="error">
            {t(b, { min: formatINR(DEFAULT_CHECKOUT_POLICY.minimumOrderPaise) })}
          </p>
        ))}
        {c.canOrder && c.codEligible && <p>{t('codAvailable')}</p>}
        {c.canOrder && !c.codEligible && <p>{onlinePayment ? t('prepaidOnly') : t('noPaymentMethod')}</p>}
        {c.canOrder &&
          !c.codEligible &&
          c.codBlockers.map((b) => (
            <p key={b} className="muted small">
              {t(b)}
            </p>
          ))}
        {cart.canCheckout && methods.length > 0 ? (
          <Checkout methods={methods} onOrdered={onOrdered} onStale={onCleared} />
        ) : (
          <button type="button" disabled>
            {t('checkout')}
          </button>
        )}
        <button
          type="button"
          className="link"
          onClick={() => void api('DELETE', '/cart').then(onCleared)}
        >
          {t('clearCart')}
        </button>
      </div>
    </section>
  );
}

function Checkout({
  methods,
  onOrdered,
  onStale,
}: {
  methods: ('prepaid' | 'cod')[];
  onOrdered: (order: Order) => void;
  onStale: () => void;
}) {
  const { t } = useI18n();
  const [method, setMethod] = useState<'prepaid' | 'cod'>(methods.includes('cod') ? 'cod' : 'prepaid');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Kept across retries of the same attempt so a lost response cannot create a second order.
  const [attempt, setAttempt] = useState<{ key: string; quoteId: string } | null>(null);

  const placeOrder = async () => {
    setBusy(true);
    setError(null);
    try {
      let current = attempt;
      if (!current) {
        const { quote } = await api<{ quote: { id: string } }>('POST', '/cart/quote');
        current = { key: newIdempotencyKey(), quoteId: quote.id };
        setAttempt(current);
      }
      const { order } = await api<{ order: Order }>(
        'POST',
        '/orders',
        { quoteId: current.quoteId, paymentMethod: method },
        { headers: { 'idempotency-key': current.key } },
      );
      if (method === 'prepaid') {
        const session = await api<{ redirectUrl: string | null }>('POST', '/payments/session', { orderId: order.id });
        if (session.redirectUrl) window.location.assign(session.redirectUrl);
      }
      onOrdered(order);
    } catch (e) {
      if (e instanceof ApiError) {
        // Any definite refusal ends this attempt; the next tap takes a fresh quote.
        setAttempt(null);
        const known = ['QUOTE_EXPIRED', 'QUOTE_CHANGED', 'INSUFFICIENT_STOCK', 'PAYMENT_UNAVAILABLE', 'PAYMENT_METHOD_NOT_ALLOWED'];
        const key = e.code === 'INSUFFICIENT_STOCK' ? 'ORDER_INSUFFICIENT_STOCK' : e.code;
        setError(known.includes(e.code) ? t(key) : e.message);
        if (e.code === 'QUOTE_CHANGED' || e.code === 'INSUFFICIENT_STOCK' || e.code === 'QUOTE_EXPIRED') onStale();
      } else {
        // Network failure: keep the same key so retrying is safe.
        setError(t('genericError'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="checkout">
      <legend>{t('paymentMethod')}</legend>
      {methods.map((m) => (
        <label key={m} className="radio">
          <input
            type="radio"
            name="payment"
            value={m}
            checked={method === m}
            disabled={busy}
            onChange={() => setMethod(m)}
          />
          {t(m)}
        </label>
      ))}
      <button type="button" disabled={busy} onClick={() => void placeOrder()}>
        {busy ? t('placing') : t('placeOrder')}
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </fieldset>
  );
}
