import type { PaymentMethod } from '@taneja/domain';
import type { PoolClient } from 'pg';
import { priceCart, type CartPricing } from './cart.js';
import { withTransaction, type Db } from './db.js';
import { AppError } from './errors.js';
import { loadAvailabilityPolicy, releaseStock, reserveStock } from './inventory.js';
import type { PaymentProvider } from './payments.js';
import { settingNumber } from './settings.js';

type Queryable = Pick<Db, 'query'> | PoolClient;

export type OrderStatus =
  | 'placed'
  | 'accepted'
  | 'picking'
  | 'short_pick_review'
  | 'packed'
  | 'ready_for_dispatch'
  | 'assigned_to_rider'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancel_requested'
  | 'cancelled'
  | 'delivery_failed'
  | 'returned'
  | 'closed';

export type PaymentStatus =
  | 'awaiting_payment'
  | 'paid'
  | 'payment_failed'
  | 'cod_due'
  | 'cod_collected'
  | 'refund_pending'
  | 'not_charged';

/** Before these, the retailer can cancel outright; after, only staff can. */
const RETAILER_CANCELLABLE: OrderStatus[] = ['placed'];
const RETAILER_CAN_REQUEST_CANCEL: OrderStatus[] = ['accepted', 'picking', 'short_pick_review', 'packed'];
const STAFF_CANCELLABLE: OrderStatus[] = [
  'placed',
  'accepted',
  'picking',
  'short_pick_review',
  'packed',
  'ready_for_dispatch',
  'cancel_requested',
];

interface OrderRow {
  id: string;
  order_number: string;
  retailer_account_id: string;
  status: OrderStatus;
  payment_method: PaymentMethod;
  payment_status: PaymentStatus;
}

async function addEvent(
  client: PoolClient,
  orderId: string,
  kind: 'status' | 'payment',
  from: string | null,
  to: string,
  actorUserId: string | null,
  note: string | null = null,
): Promise<void> {
  await client.query(
    `INSERT INTO order_events (order_id, kind, from_value, to_value, actor_user_id, note) VALUES ($1, $2, $3, $4, $5, $6)`,
    [orderId, kind, from, to, actorUserId, note],
  );
}

function sameCart(quote: CartPricing, now: CartPricing): boolean {
  if (quote.checkout.payablePaise !== now.checkout.payablePaise || quote.lines.length !== now.lines.length) return false;
  return quote.lines.every((q, i) => {
    const n = now.lines[i]!;
    return n.productId === q.productId && n.quantity === q.quantity && n.pricing?.totalPaise === q.pricing?.totalPaise;
  });
}

export interface PlaceOrderInput {
  accountId: string;
  userId: string;
  quoteId: string;
  paymentMethod: PaymentMethod;
  idempotencyKey: string;
}

/**
 * Turns a quote into an order in one transaction: re-checks prices, stock and payment eligibility,
 * reserves stock earliest-expiry-first, freezes the delivery address and empties the cart.
 * Repeating a request with the same idempotency key returns the original order instead of a second one.
 */
export async function placeOrder(
  db: Db,
  payments: PaymentProvider,
  input: PlaceOrderInput,
): Promise<{ orderId: string; replayed: boolean }> {
  try {
    return await withTransaction(db, (client) => placeOrderTx(client, payments, input));
  } catch (error) {
    // A concurrent request with the same key won the race; return its order.
    if ((error as { code?: string }).code === '23505' && String((error as Error).message).includes('idempotency')) {
      const existing = await findByIdempotencyKey(db, input);
      if (existing) return { orderId: existing, replayed: true };
    }
    throw error;
  }
}

async function findByIdempotencyKey(db: Queryable, input: PlaceOrderInput): Promise<string | null> {
  const { rows } = await db.query<{ id: string; quote_id: string }>(
    'SELECT id, quote_id FROM orders WHERE retailer_account_id = $1 AND idempotency_key = $2',
    [input.accountId, input.idempotencyKey],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.quote_id !== input.quoteId) {
    throw new AppError('CONFLICT', 'This idempotency key was already used for a different order');
  }
  return row.id;
}

async function placeOrderTx(
  client: PoolClient,
  payments: PaymentProvider,
  input: PlaceOrderInput,
): Promise<{ orderId: string; replayed: boolean }> {
  const existing = await findByIdempotencyKey(client, input);
  if (existing) return { orderId: existing, replayed: true };

  // Serialise checkouts per retailer so two different quotes cannot both empty the same cart.
  await client.query('SELECT id FROM retailer_accounts WHERE id = $1 FOR UPDATE', [input.accountId]);

  const { rows: quotes } = await client.query<{
    snapshot: CartPricing;
    used_at: Date | null;
    expired: boolean;
    can_checkout: boolean;
  }>(
    `SELECT snapshot, used_at, expires_at < now() AS expired, can_checkout
     FROM price_quotes WHERE id = $1 AND retailer_account_id = $2 FOR UPDATE`,
    [input.quoteId, input.accountId],
  );
  const quote = quotes[0];
  if (!quote) throw new AppError('NOT_FOUND', 'Quote not found');
  if (quote.used_at) throw new AppError('CONFLICT', 'This quote has already been used for an order');
  if (quote.expired) throw new AppError('QUOTE_EXPIRED', 'Prices have expired. Please review your cart again.');
  if (!quote.can_checkout) throw new AppError('CONFLICT', 'This cart cannot be ordered yet');

  const current = await priceCart(client, input.accountId);
  if (!current.canCheckout || !sameCart(quote.snapshot, current)) {
    throw new AppError('QUOTE_CHANGED', 'Your cart, prices or stock changed. Please review your cart again.');
  }
  if (!current.checkout.paymentMethods.includes(input.paymentMethod)) {
    throw new AppError('PAYMENT_METHOD_NOT_ALLOWED', `${input.paymentMethod} is not available for this order`, {
      allowed: current.checkout.paymentMethods,
      codBlockers: current.checkout.codBlockers,
    });
  }
  if (input.paymentMethod === 'prepaid' && !payments.enabled) {
    throw new AppError('PAYMENT_UNAVAILABLE', 'Online payment is not available yet');
  }

  const { rows: stores } = await client.query(
    `SELECT a.business_name AS "businessName", s.address_line1 AS "addressLine1", s.address_line2 AS "addressLine2",
            s.landmark, s.city, s.district, s.state, s.postal_code AS "postalCode",
            s.latitude::float AS latitude, s.longitude::float AS longitude, s.service_zone AS "serviceZone"
     FROM retailer_accounts a JOIN store_locations s ON s.retailer_account_id = a.id
     WHERE a.id = $1 AND s.verified`,
    [input.accountId],
  );
  if (!stores[0]) throw new AppError('CONFLICT', 'Store address is not verified');

  const prepaid = input.paymentMethod === 'prepaid';
  const window = await settingNumber(client, 'payments.prepaid_window_minutes', 30);
  const paymentStatus: PaymentStatus = prepaid ? 'awaiting_payment' : 'cod_due';
  const c = current.checkout;
  const { rows: created } = await client.query<{ id: string; order_number: string }>(
    `INSERT INTO orders (retailer_account_id, placed_by, quote_id, idempotency_key, payment_method, payment_status,
                         subtotal_paise, discount_paise, tax_paise, delivery_fee_paise, payable_paise,
                         delivery_address, payment_due_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             CASE WHEN $13::boolean THEN now() + make_interval(mins => $14) END)
     RETURNING id, order_number`,
    [
      input.accountId,
      input.userId,
      input.quoteId,
      input.idempotencyKey,
      input.paymentMethod,
      paymentStatus,
      current.subtotalPaise,
      current.discountPaise,
      current.taxPaise,
      c.deliveryFeePaise,
      c.payablePaise,
      JSON.stringify(stores[0]),
      prepaid,
      window,
    ],
  );
  const order = created[0]!;

  const policy = await loadAvailabilityPolicy(client);
  for (const line of current.lines) {
    const p = line.pricing!;
    await client.query(
      `INSERT INTO order_items (order_id, product_id, sku, name, pack_size, quantity, value_paise, discount_paise,
                                taxable_paise, gst_rate_bps, tax_paise, total_paise)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [order.id, line.productId, line.sku, line.name, line.packSize, line.quantity, p.valuePaise, p.discountPaise,
       p.taxablePaise, p.gstRateBps, p.taxPaise, p.totalPaise],
    );
    let reserved;
    try {
      reserved = await reserveStock(client, line.productId, line.quantity, {
        reference: order.order_number,
        actorUserId: input.userId,
        minShelfLifeDays: policy.minShelfLifeDays,
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'CONFLICT') {
        throw new AppError('INSUFFICIENT_STOCK', `${line.name} just went out of stock. Please review your cart.`, error.details);
      }
      throw error;
    }
    for (const r of reserved) {
      await client.query(
        'INSERT INTO order_allocations (order_id, product_id, batch_id, quantity) VALUES ($1, $2, $3, $4)',
        [order.id, line.productId, r.batchId, r.quantity],
      );
    }
  }

  await addEvent(client, order.id, 'status', null, 'placed', input.userId);
  await addEvent(client, order.id, 'payment', null, paymentStatus, input.userId);
  await client.query('UPDATE price_quotes SET used_at = now() WHERE id = $1', [input.quoteId]);
  await client.query('DELETE FROM cart_items WHERE cart_id = (SELECT id FROM carts WHERE retailer_account_id = $1)', [
    input.accountId,
  ]);
  return { orderId: order.id, replayed: false };
}

const ORDER_COLUMNS = `
  o.id, o.order_number AS "orderNumber", o.retailer_account_id AS "retailerAccountId", o.status,
  o.payment_method AS "paymentMethod", o.payment_status AS "paymentStatus",
  o.subtotal_paise::int AS "subtotalPaise", o.discount_paise::int AS "discountPaise", o.tax_paise::int AS "taxPaise",
  o.delivery_fee_paise::int AS "deliveryFeePaise", o.payable_paise::int AS "payablePaise",
  o.payment_due_by AS "paymentDueBy", o.placed_at AS "placedAt", o.updated_at AS "updatedAt"`;

export async function listOrders(
  db: Queryable,
  filter: { accountId?: string; status?: string; limit: number; offset: number },
) {
  const { rows } = await db.query(
    `SELECT ${ORDER_COLUMNS}, a.business_name AS "businessName",
            (SELECT count(*)::int FROM order_items i WHERE i.order_id = o.id) AS "itemCount"
     FROM orders o JOIN retailer_accounts a ON a.id = o.retailer_account_id
     WHERE ($1::uuid IS NULL OR o.retailer_account_id = $1) AND ($2::text IS NULL OR o.status = $2)
     ORDER BY o.placed_at DESC, o.order_number DESC
     LIMIT $3 OFFSET $4`,
    [filter.accountId ?? null, filter.status ?? null, filter.limit, filter.offset],
  );
  return rows;
}

/** One order with lines and history. `accountId` limits retailers to their own orders (others look missing). */
export async function getOrder(db: Queryable, orderId: string, opts: { accountId?: string; staff: boolean }) {
  const { rows } = await db.query(
    `SELECT ${ORDER_COLUMNS}, o.delivery_address AS "deliveryAddress", a.business_name AS "businessName"
     FROM orders o JOIN retailer_accounts a ON a.id = o.retailer_account_id
     WHERE o.id = $1 AND ($2::uuid IS NULL OR o.retailer_account_id = $2)`,
    [orderId, opts.accountId ?? null],
  );
  const order = rows[0];
  if (!order) throw new AppError('NOT_FOUND', 'Order not found');
  const [items, events, payments] = await Promise.all([
    db.query(
      `SELECT product_id AS "productId", sku, name, pack_size AS "packSize", quantity, value_paise::int AS "valuePaise",
              discount_paise::int AS "discountPaise", taxable_paise::int AS "taxablePaise", gst_rate_bps AS "gstRateBps",
              tax_paise::int AS "taxPaise", total_paise::int AS "totalPaise"
       FROM order_items WHERE order_id = $1 ORDER BY name`,
      [orderId],
    ),
    db.query(
      `SELECT kind, from_value AS "from", to_value AS "to", note, created_at AS "at"
              ${opts.staff ? ', actor_user_id AS "actorUserId"' : ''}
       FROM order_events WHERE order_id = $1 ORDER BY id`,
      [orderId],
    ),
    db.query(
      `SELECT id, provider, status, amount_paise::int AS "amountPaise", created_at AS "createdAt"
       FROM payments WHERE order_id = $1 ORDER BY created_at`,
      [orderId],
    ),
  ]);
  const view: Record<string, unknown> = { ...order, items: items.rows, events: events.rows, payments: payments.rows };
  if (opts.staff) {
    const allocations = await db.query(
      `SELECT a.product_id AS "productId", b.batch_number AS "batchNumber", to_char(b.expiry_date, 'YYYY-MM-DD') AS "expiryDate",
              b.location, a.quantity, a.released_at AS "releasedAt"
       FROM order_allocations a JOIN inventory_batches b ON b.id = a.batch_id
       WHERE a.order_id = $1 ORDER BY b.expiry_date`,
      [orderId],
    );
    view.allocations = allocations.rows;
  }
  return view;
}

async function lockOrder(client: PoolClient, orderId: string, accountId?: string): Promise<OrderRow> {
  const { rows } = await client.query<OrderRow>(
    `SELECT id, order_number, retailer_account_id, status, payment_method, payment_status
     FROM orders WHERE id = $1 AND ($2::uuid IS NULL OR retailer_account_id = $2) FOR UPDATE`,
    [orderId, accountId ?? null],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND', 'Order not found');
  return rows[0];
}

async function setStatus(client: PoolClient, order: OrderRow, to: OrderStatus, actor: string | null, note: string | null) {
  await client.query('UPDATE orders SET status = $2, updated_at = now() WHERE id = $1', [order.id, to]);
  await addEvent(client, order.id, 'status', order.status, to, actor, note);
}

async function setPaymentStatus(client: PoolClient, order: OrderRow, to: PaymentStatus, actor: string | null, note: string | null) {
  if (order.payment_status === to) return;
  await client.query('UPDATE orders SET payment_status = $2, updated_at = now() WHERE id = $1', [order.id, to]);
  await addEvent(client, order.id, 'payment', order.payment_status, to, actor, note);
}

async function cancelLocked(client: PoolClient, order: OrderRow, actor: string | null, reason: string): Promise<void> {
  const { rows: allocations } = await client.query<{ batch_id: string; quantity: number }>(
    'SELECT batch_id, quantity FROM order_allocations WHERE order_id = $1 AND released_at IS NULL',
    [order.id],
  );
  await releaseStock(
    client,
    allocations.map((a) => ({ batchId: a.batch_id, quantity: a.quantity })),
    { reference: order.order_number, actorUserId: actor },
  );
  await client.query('UPDATE order_allocations SET released_at = now() WHERE order_id = $1 AND released_at IS NULL', [
    order.id,
  ]);
  await setStatus(client, order, 'cancelled', actor, reason);
  // No money moves here. A paid order is flagged for finance to refund through the provider.
  const nextPayment: PaymentStatus | null =
    order.payment_status === 'paid' ? 'refund_pending' : order.payment_status === 'cod_collected' ? null : 'not_charged';
  if (nextPayment) await setPaymentStatus(client, order, nextPayment, actor, reason);
}

/** Retailer cancellation: immediate before the warehouse accepts the order, otherwise a request for staff. */
export async function retailerCancel(db: Db, orderId: string, accountId: string, userId: string, reason: string | null) {
  return withTransaction(db, async (client) => {
    const order = await lockOrder(client, orderId, accountId);
    const note = reason ?? 'Cancelled by retailer';
    if (RETAILER_CANCELLABLE.includes(order.status)) {
      await cancelLocked(client, order, userId, note);
      return 'cancelled' as const;
    }
    if (RETAILER_CAN_REQUEST_CANCEL.includes(order.status)) {
      await setStatus(client, order, 'cancel_requested', userId, note);
      return 'cancel_requested' as const;
    }
    throw new AppError('CONFLICT', `An order that is ${order.status.replaceAll('_', ' ')} cannot be cancelled here`);
  });
}

export async function staffCancel(client: PoolClient, orderId: string, actor: string, reason: string) {
  const order = await lockOrder(client, orderId);
  if (!STAFF_CANCELLABLE.includes(order.status)) {
    throw new AppError('CONFLICT', `An order that is ${order.status.replaceAll('_', ' ')} cannot be cancelled`);
  }
  await cancelLocked(client, order, actor, reason);
  return order;
}

/** Warehouse takes the order on. Prepaid orders must be paid first. */
export async function acceptOrder(client: PoolClient, orderId: string, actor: string) {
  const order = await lockOrder(client, orderId);
  if (order.status !== 'placed') throw new AppError('CONFLICT', `Order is ${order.status}, not placed`);
  if (order.payment_status !== 'paid' && order.payment_status !== 'cod_due') {
    throw new AppError('CONFLICT', 'Order is not paid yet');
  }
  await setStatus(client, order, 'accepted', actor, null);
  return order;
}

/** Cancels prepaid orders left unpaid past their window so their stock goes back on sale. */
export async function expireUnpaidOrders(db: Db): Promise<string[]> {
  return withTransaction(db, async (client) => {
    const { rows } = await client.query<OrderRow>(
      `SELECT id, order_number, retailer_account_id, status, payment_method, payment_status FROM orders
       WHERE payment_status = 'awaiting_payment' AND status = 'placed' AND payment_due_by < now()
       ORDER BY payment_due_by LIMIT 100 FOR UPDATE SKIP LOCKED`,
    );
    for (const order of rows) await cancelLocked(client, order, null, 'Payment not received in time');
    return rows.map((r) => r.order_number);
  });
}

/** Starts (or restarts) online payment for an unpaid prepaid order. */
export async function startPayment(db: Db, payments: PaymentProvider, orderId: string, accountId: string) {
  return withTransaction(db, async (client) => {
    const order = await lockOrder(client, orderId, accountId);
    if (order.payment_method !== 'prepaid' || order.payment_status !== 'awaiting_payment' || order.status !== 'placed') {
      throw new AppError('CONFLICT', 'This order is not waiting for online payment');
    }
    const { rows } = await client.query<{ payable_paise: string }>('SELECT payable_paise FROM orders WHERE id = $1', [
      order.id,
    ]);
    const amountPaise = Number(rows[0]!.payable_paise);
    const paymentId = (await client.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
    const session = await payments.createSession({ paymentId, orderNumber: order.order_number, amountPaise });
    await client.query(
      `INSERT INTO payments (id, order_id, provider, provider_ref, amount_paise) VALUES ($1, $2, $3, $4, $5)`,
      [paymentId, order.id, payments.name, session.providerRef, amountPaise],
    );
    return { paymentId, provider: payments.name, amountPaise, redirectUrl: session.redirectUrl };
  });
}

export type WebhookOutcome = 'applied' | 'duplicate' | 'unknown_payment' | 'amount_mismatch' | 'paid_after_cancel' | 'failed';

/** Applies a verified provider event exactly once. Only this path can mark an order paid. */
export async function applyPaymentEvent(
  db: Db,
  provider: string,
  event: { eventId: string; providerRef: string; status: 'succeeded' | 'failed'; amountPaise: number },
): Promise<WebhookOutcome> {
  return withTransaction(db, async (client) => {
    // Claiming the event id first means a concurrent replay waits here, then sees the claim and stops.
    const claimed = await client.query(
      `INSERT INTO payment_webhook_events (provider, event_id, outcome) VALUES ($1, $2, 'processing')
       ON CONFLICT DO NOTHING`,
      [provider, event.eventId],
    );
    if (claimed.rowCount === 0) return 'duplicate';

    const { rows } = await client.query<{ id: string; order_id: string; amount_paise: string; status: string }>(
      'SELECT id, order_id, amount_paise, status FROM payments WHERE provider = $1 AND provider_ref = $2 FOR UPDATE',
      [provider, event.providerRef],
    );
    const payment = rows[0];
    let outcome: WebhookOutcome;
    if (!payment) outcome = 'unknown_payment';
    else if (Number(payment.amount_paise) !== event.amountPaise) outcome = 'amount_mismatch';
    else if (event.status === 'failed') {
      outcome = 'failed';
      if (payment.status === 'created') {
        await client.query("UPDATE payments SET status = 'failed', updated_at = now() WHERE id = $1", [payment.id]);
      }
    } else {
      await client.query("UPDATE payments SET status = 'succeeded', updated_at = now() WHERE id = $1", [payment.id]);
      const order = await lockOrder(client, payment.order_id);
      if (order.status === 'cancelled') {
        outcome = 'paid_after_cancel';
        await setPaymentStatus(client, order, 'refund_pending', null, `Payment ${event.providerRef} arrived after cancellation`);
      } else {
        outcome = 'applied';
        if (order.payment_status === 'awaiting_payment' || order.payment_status === 'payment_failed') {
          await client.query('UPDATE orders SET payment_due_by = NULL WHERE id = $1', [order.id]);
          await setPaymentStatus(client, order, 'paid', null, `Provider reference ${event.providerRef}`);
        }
      }
    }
    await client.query(
      'UPDATE payment_webhook_events SET payment_id = $3, outcome = $4 WHERE provider = $1 AND event_id = $2',
      [provider, event.eventId, payment?.id ?? null, outcome],
    );
    return outcome;
  });
}
