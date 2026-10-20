import { formatINR, paise } from '@taneja/domain';
import { useEffect, useState } from 'react';
import { api, type Product } from '../api';
import { useI18n } from '../i18n';

export function Catalog({ onAdd, inCart }: { onAdd: (productId: string, quantity: number) => Promise<void>; inCart: Map<string, number> }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Product[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setItems(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api<{ items: Product[] }>('GET', `/catalog/search?q=${encodeURIComponent(term)}&limit=30`)
        .then((res) => !cancelled && (setItems(res.items), setError(false)))
        .catch(() => !cancelled && setError(true));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  return (
    <section>
      <input
        type="search"
        className="search"
        aria-label={t('search')}
        placeholder={t('searchPlaceholder')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
      />
      {error && <p role="alert" className="error">{t('genericError')}</p>}
      {items && items.length === 0 && <p className="muted">{t('noResults')}</p>}
      <ul className="list">
        {items?.map((p) => (
          <ProductRow key={p.id} product={p} quantityInCart={inCart.get(p.id) ?? 0} onAdd={onAdd} />
        ))}
      </ul>
    </section>
  );
}

function ProductRow({
  product: p,
  quantityInCart,
  onAdd,
}: {
  product: Product;
  quantityInCart: number;
  onAdd: (productId: string, quantity: number) => Promise<void>;
}) {
  const { t } = useI18n();
  const [qty, setQty] = useState(1);
  const orderable = p.availability === 'in_stock' || p.availability === 'low_stock';
  return (
    <li className="card product">
      <div>
        <strong>{p.name}</strong>
        <div className="muted small">
          {[p.genericName, p.strength, p.packSize].filter(Boolean).join(' · ')}
        </div>
        <div className="muted small">{p.manufacturer}</div>
        <div className="small">
          <span className={`badge ${p.availability}`}>{t(p.availability)}</span>
          {p.coldChain && <span className="badge">{t('coldChain')}</span>}
          {p.mrpPaise != null && (
            <span className="muted">
              {' '}
              {t('mrp')} {formatINR(paise(p.mrpPaise))}
            </span>
          )}
        </div>
        {p.stockStale && <div className="muted small">{t('stale')}</div>}
      </div>
      {orderable && (
        <div className="add">
          <input
            type="number"
            min={1}
            max={10000}
            aria-label={`${t('qty')} ${p.name}`}
            value={qty}
            onChange={(e) => setQty(Math.max(1, Math.min(10000, Number(e.target.value) || 1)))}
          />
          <button type="button" onClick={() => void onAdd(p.id, quantityInCart + qty)}>
            {t('add')}
            {quantityInCart > 0 && ` (${quantityInCart})`}
          </button>
        </div>
      )}
    </li>
  );
}
