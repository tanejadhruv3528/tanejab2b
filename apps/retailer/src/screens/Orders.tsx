import { formatINR, paise } from '@taneja/domain';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Order, type OrderSummary } from '../api';
import { useI18n } from '../i18n';

const inr = (value: number) => formatINR(paise(value));
const RETAILER_CANCEL = new Set(['placed']);
const RETAILER_REQUEST_CANCEL = new Set(['accepted', 'picking', 'short_pick_review', 'packed']);

export function Orders({ openOrderId, onOpen }: { openOrderId: string | null; onOpen: (id: string | null) => void }) {
  const { t, lang } = useI18n();
  const [items, setItems] = useState<OrderSummary[] | null>(null);

  useEffect(() => {
    if (openOrderId) return;
    void api<{ items: OrderSummary[] }>('GET', '/orders?limit=50').then((r) => setItems(r.items));
  }, [openOrderId]);

  if (openOrderId) return <OrderDetail id={openOrderId} onBack={() => onOpen(null)} />;
  if (!items) return null;
  if (items.length === 0) return <p className="muted">{t('noOrders')}</p>;
  return (
    <ul className="list">
      {items.map((o) => (
        <li key={o.id}>
          <button type="button" className="card order-row" onClick={() => onOpen(o.id)}>
            <span>
              <strong>{o.orderNumber}</strong>
              <span className="muted small"> · {new Date(o.placedAt).toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-IN', { timeZone: 'Asia/Kolkata' })}</span>
              <br />
              <span className={`badge st-${o.status}`}>{t(`st_${o.status}`)}</span>
              <span className="badge">{t(`pay_${o.paymentStatus}`)}</span>
            </span>
            <span className="amount">{inr(o.payablePaise)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function OrderDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { t, lang } = useI18n();
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<{ order: Order }>('GET', `/orders/${id}`).then((r) => setOrder(r.order)), [id]);
  useEffect(() => {
    void load().catch(() => setError(t('genericError')));
  }, [load, t]);

  const cancel = async () => {
    if (!window.confirm(t('confirmCancel'))) return;
    try {
      const res = await api<{ order: Order }>('POST', `/orders/${id}/cancel-request`, {});
      setOrder(res.order);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('genericError'));
    }
  };

  if (!order) return error ? <p className="error">{error}</p> : null;
  const when = (iso: string) =>
    new Date(iso).toLocaleString(lang === 'hi' ? 'hi-IN' : 'en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

  return (
    <section>
      <button type="button" className="link" onClick={onBack}>
        ← {t('back')}
      </button>
      <h2>{order.orderNumber}</h2>
      <p>
        <span className={`badge st-${order.status}`}>{t(`st_${order.status}`)}</span>
        <span className="badge">{t(`pay_${order.paymentStatus}`)}</span>
      </p>
      {order.paymentStatus === 'awaiting_payment' && <p className="muted small">{t('awaitingPaymentNote')}</p>}
      <ul className="list">
        {order.items.map((i) => (
          <li key={i.productId} className="card line">
            <div>
              <strong>{i.name}</strong>
              <div className="muted small">
                {t('qty')} {i.quantity}
                {i.packSize ? ` · ${i.packSize}` : ''}
              </div>
            </div>
            <div className="amount">{inr(i.totalPaise)}</div>
          </li>
        ))}
      </ul>
      <dl className="card totals">
        <dt>{t('subtotal')}</dt>
        <dd>{inr(order.subtotalPaise)}</dd>
        {order.discountPaise > 0 && (
          <>
            <dt>{t('discount')}</dt>
            <dd>−{inr(order.discountPaise)}</dd>
          </>
        )}
        <dt>{t('gst')}</dt>
        <dd>{inr(order.taxPaise)}</dd>
        <dt>{t('delivery')}</dt>
        <dd>{inr(order.deliveryFeePaise)}</dd>
        <dt className="strong">{t('payable')}</dt>
        <dd className="strong">{inr(order.payablePaise)}</dd>
      </dl>
      <div className="card">
        <h3>{t('history')}</h3>
        <ul className="history">
          {order.events.map((e, i) => (
            <li key={i} className="small">
              <span className="muted">{when(e.at)}</span> · {t(e.kind === 'status' ? `st_${e.to}` : `pay_${e.to}`)}
              {e.note ? ` · ${e.note}` : ''}
            </li>
          ))}
        </ul>
      </div>
      {(RETAILER_CANCEL.has(order.status) || RETAILER_REQUEST_CANCEL.has(order.status)) && (
        <button type="button" className="secondary" onClick={() => void cancel()}>
          {RETAILER_CANCEL.has(order.status) ? t('cancelOrder') : t('requestCancel')}
        </button>
      )}
      {error && <p role="alert" className="error">{error}</p>}
    </section>
  );
}
