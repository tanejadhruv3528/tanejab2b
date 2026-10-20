import { DEFAULT_CHECKOUT_POLICY, formatINR, paise } from '@taneja/domain';
import { api, type Cart } from '../api';
import { useI18n } from '../i18n';

const inr = (value: number) => formatINR(paise(value));

export function CartView({
  cart,
  onSetQuantity,
  onCleared,
}: {
  cart: Cart | null;
  onSetQuantity: (productId: string, quantity: number) => Promise<void>;
  onCleared: () => void;
}) {
  const { t } = useI18n();
  if (!cart) return null;
  if (cart.lines.length === 0) return <p className="muted">{t('emptyCart')}</p>;
  const c = cart.checkout;
  const hasLineIssues = cart.lines.some((l) => l.issues.length > 0);

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
        {c.canOrder && (c.codEligible ? <p>{t('codAvailable')}</p> : <p>{t('prepaidOnly')}</p>)}
        {c.canOrder &&
          !c.codEligible &&
          c.codBlockers.map((b) => (
            <p key={b} className="muted small">
              {t(b)}
            </p>
          ))}
        {/* Order placement arrives with the orders/payments phase; nothing here pretends to take payment. */}
        <button type="button" disabled>
          {cart.canCheckout ? t('checkoutSoon') : t('checkout')}
        </button>
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
