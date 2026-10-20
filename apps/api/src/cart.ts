import {
  allocateFefo,
  evaluateCheckout,
  isStale,
  paise,
  priceLines,
  type CheckoutEvaluation,
  type DiscountSlab,
  type Paise,
  type PricedLine,
  type SellableBatch,
} from '@taneja/domain';
import type { PoolClient } from 'pg';
import type { Db } from './db.js';
import { loadAvailabilityPolicy } from './inventory.js';
import { loadRetailerContext } from './retailer-context.js';
import { discountsEnabled, loadCheckoutPolicy, settingBool, settingNumber } from './settings.js';

type Queryable = Pick<Db, 'query'> | PoolClient;

export type LineIssue =
  | 'DISCONTINUED'
  | 'RESTRICTED'
  | 'COLD_CHAIN_NOT_ENABLED'
  | 'OUT_OF_STOCK'
  | 'INSUFFICIENT_STOCK'
  | 'PRICE_MISSING'
  | 'TAX_RATE_MISSING';

export interface QuoteLine {
  productId: string;
  sku: string;
  name: string;
  manufacturer: string;
  packSize: string | null;
  quantity: number;
  issues: LineIssue[];
  /** Units that could be supplied now, when stock is short. Only shown when the line is short. */
  availableQuantity?: number;
  stockStale: boolean;
  pricing: Omit<PricedLine, 'productId' | 'quantity'> | null;
  /** Per-batch allocation used for pricing; the order reserves the same batches if still free. */
  allocations: { batchId: string; quantity: number; ratePaise: number }[];
}

export interface CartPricing {
  lines: QuoteLine[];
  subtotalPaise: Paise;
  discountBps: number;
  discountPaise: Paise;
  taxPaise: Paise;
  checkout: CheckoutEvaluation;
  /** True only when every line is orderable and the checkout rules pass. */
  canCheckout: boolean;
}

export interface Quote extends CartPricing {
  id: string;
  expiresAt: string;
}

async function getOrCreateCart(db: Queryable, accountId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO carts (retailer_account_id) VALUES ($1)
     ON CONFLICT (retailer_account_id) DO UPDATE SET retailer_account_id = EXCLUDED.retailer_account_id
     RETURNING id`,
    [accountId],
  );
  return rows[0]!.id;
}

export async function setCartItem(db: Queryable, accountId: string, productId: string, quantity: number): Promise<void> {
  const cartId = await getOrCreateCart(db, accountId);
  if (quantity === 0) {
    await db.query('DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2', [cartId, productId]);
  } else {
    await db.query(
      `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, $3)
       ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
      [cartId, productId, quantity],
    );
  }
  await db.query('UPDATE carts SET updated_at = now() WHERE id = $1', [cartId]);
}

export async function clearCart(db: Queryable, accountId: string): Promise<void> {
  await db.query('DELETE FROM cart_items WHERE cart_id = (SELECT id FROM carts WHERE retailer_account_id = $1)', [
    accountId,
  ]);
}

async function loadDiscountSlabs(db: Queryable): Promise<DiscountSlab[]> {
  const { rows } = await db.query<{ min: string; bps: number }>(
    `SELECT min_subtotal_paise AS min, discount_bps AS bps FROM pricing_rules
     WHERE kind = 'order_value_slab' AND status = 'active'`,
  );
  return rows.map((r) => ({ minSubtotalPaise: paise(Number(r.min)), discountBps: r.bps }));
}

/**
 * Prices the retailer's cart from current stock and settings.
 * Problem lines are shown with reasons, never silently dropped, and block checkout until fixed.
 */
export async function priceCart(db: Queryable, accountId: string): Promise<CartPricing> {
  // Sequential on purpose: this may run on a single transaction client, which cannot run queries in parallel.
  const policy = await loadAvailabilityPolicy(db);
  const checkoutPolicy = await loadCheckoutPolicy(db);
  const retailer = await loadRetailerContext(db, accountId);
  const discountsOn = await discountsEnabled(db);
  const slabs = await loadDiscountSlabs(db);
  const coldChainOn = await settingBool(db, 'catalog.cold_chain_enabled');
  const ratesIncludeGst = await settingBool(db, 'pricing.rates_include_gst');
  if (ratesIncludeGst) {
    // Inclusive-rate pricing has not been built; refuse rather than charge GST twice.
    throw new Error('pricing.rates_include_gst=true is not supported yet');
  }

  const { rows: items } = await db.query<{
    product_id: string;
    sku: string;
    name: string;
    manufacturer: string;
    pack_size: string | null;
    quantity: number;
    status: string;
    cold_chain: boolean;
    gst_rate_bps: number | null;
    synced_at: Date | null;
  }>(
    `SELECT ci.product_id, p.sku, p.name, m.name AS manufacturer, p.pack_size, ci.quantity, p.status, p.cold_chain,
            p.gst_rate_bps, (SELECT max(b.synced_at) FROM inventory_batches b WHERE b.product_id = p.id) AS synced_at
     FROM carts c
     JOIN cart_items ci ON ci.cart_id = c.id
     JOIN products p ON p.id = ci.product_id
     JOIN manufacturers m ON m.id = p.manufacturer_id
     WHERE c.retailer_account_id = $1
     ORDER BY ci.added_at, p.name`,
    [accountId],
  );

  const { rows: batchRows } = await db.query<{
    product_id: string;
    id: string;
    expiry_date: string;
    free: number;
    rate_paise: string | null;
  }>(
    `SELECT product_id, id, to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date,
            greatest(on_hand_qty - reserved_qty - quarantined_qty, 0) AS free, rate_paise
     FROM inventory_batches
     WHERE product_id = ANY($1::uuid[])
       AND expiry_date > (now() AT TIME ZONE 'Asia/Kolkata')::date + $2::int`,
    [items.map((i) => i.product_id), policy.minShelfLifeDays],
  );
  const batchesByProduct = new Map<string, SellableBatch[]>();
  for (const b of batchRows) {
    const list = batchesByProduct.get(b.product_id) ?? [];
    list.push({
      batchId: b.id,
      expiryDate: b.expiry_date,
      free: b.free,
      ratePaise: b.rate_paise === null ? null : paise(Number(b.rate_paise)),
    });
    batchesByProduct.set(b.product_id, list);
  }

  const now = new Date();
  const lines: QuoteLine[] = items.map((item) => {
    const issues: LineIssue[] = [];
    if (item.status === 'discontinued') issues.push('DISCONTINUED');
    if (item.status === 'restricted') issues.push('RESTRICTED');
    if (item.cold_chain && !coldChainOn) issues.push('COLD_CHAIN_NOT_ENABLED');
    if (item.gst_rate_bps === null) issues.push('TAX_RATE_MISSING');
    const batches = batchesByProduct.get(item.product_id) ?? [];
    const free = batches.reduce((s, b) => s + b.free, 0);
    const pricedFree = batches.filter((b) => b.ratePaise !== null).reduce((s, b) => s + b.free, 0);
    const { allocations, shortBy } = allocateFefo(batches, item.quantity);
    let availableQuantity: number | undefined;
    if (free === 0) issues.push('OUT_OF_STOCK');
    else if (pricedFree === 0) issues.push('PRICE_MISSING');
    else if (shortBy > 0) {
      issues.push('INSUFFICIENT_STOCK');
      availableQuantity = pricedFree;
    }
    return {
      productId: item.product_id,
      sku: item.sku,
      name: item.name,
      manufacturer: item.manufacturer,
      packSize: item.pack_size,
      quantity: item.quantity,
      issues,
      ...(availableQuantity !== undefined ? { availableQuantity } : {}),
      stockStale: isStale(item.synced_at, now, policy),
      pricing: null,
      allocations: issues.length === 0 ? allocations : [],
    };
  });

  const orderable = lines.filter((l) => l.issues.length === 0);
  const priced = priceLines(
    orderable.map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      allocations: l.allocations.map((a) => ({ ...a, ratePaise: paise(a.ratePaise) })),
      gstRateBps: items.find((i) => i.product_id === l.productId)!.gst_rate_bps!,
    })),
    { enabled: discountsOn, slabs },
  );
  priced.lines.forEach((p, i) => {
    const { productId: _productId, quantity: _quantity, ...pricing } = p;
    orderable[i]!.pricing = pricing;
  });

  const checkout = evaluateCheckout(
    { subtotalPaise: priced.subtotalPaise, discountPaise: priced.discountPaise, taxPaise: priced.taxPaise },
    retailer,
    checkoutPolicy,
  );
  const canCheckout = checkout.canOrder && lines.length > 0 && lines.every((l) => l.issues.length === 0);

  return {
    lines,
    subtotalPaise: priced.subtotalPaise,
    discountBps: priced.discountBps,
    discountPaise: priced.discountPaise,
    taxPaise: priced.taxPaise,
    checkout,
    canCheckout,
  };
}

/** Prices the cart and stores the result as an immutable quote that checkout will honour until it expires. */
export async function createQuote(db: Queryable, accountId: string): Promise<Quote> {
  const body = await priceCart(db, accountId);
  const ttl = await settingNumber(db, 'pricing.quote_ttl_minutes', 15);
  const { rows } = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO price_quotes (retailer_account_id, snapshot, payable_paise, can_checkout, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5)) RETURNING id, expires_at`,
    [accountId, JSON.stringify(body), body.checkout.payablePaise, body.canCheckout, ttl],
  );
  return { id: rows[0]!.id, expiresAt: rows[0]!.expires_at.toISOString(), ...body };
}
