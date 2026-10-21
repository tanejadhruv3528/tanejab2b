import type { PoolClient } from 'pg';
import type { Db } from './db.js';
import { AppError } from './errors.js';
import { settingNumber } from './settings.js';

type Queryable = Pick<Db, 'query'> | PoolClient;

export type ReturnStatus = 'requested' | 'approved' | 'rejected' | 'cancelled' | 'pickup_scheduled' | 'received' | 'closed';
export type ReturnReason = 'damaged' | 'expired' | 'near_expiry' | 'wrong_item' | 'excess_supply' | 'other';
export type Disposition = 'restock' | 'return_to_supplier' | 'destroy';

export const MAX_EVIDENCE_FILES = 5;

interface ReturnRow {
  id: string;
  return_number: string;
  order_id: string;
  retailer_account_id: string;
  status: ReturnStatus;
}

export interface ReturnRequestInput {
  orderId: string;
  note?: string;
  items: { productId: string; quantity: number; reason: ReturnReason; batchNumber?: string }[];
}

/**
 * A retailer asks to return delivered goods. Only lines of their own delivered order, within the
 * return window and up to what was delivered less what is already being returned.
 */
export async function createReturn(client: PoolClient, accountId: string, userId: string, input: ReturnRequestInput) {
  const { rows } = await client.query<{ id: string; status: string; delivered_at: Date | null }>(
    `SELECT o.id, o.status,
            (SELECT max(d.delivered_at) FROM delivery_assignments d WHERE d.order_id = o.id AND d.status = 'delivered') AS delivered_at
     FROM orders o WHERE o.id = $1 AND o.retailer_account_id = $2 FOR UPDATE OF o`,
    [input.orderId, accountId],
  );
  const order = rows[0];
  if (!order) throw new AppError('NOT_FOUND', 'Order not found');
  if (order.status !== 'delivered' || !order.delivered_at) throw new AppError('CONFLICT', 'Only delivered orders can be returned');
  const windowDays = await settingNumber(client, 'returns.window_days', 7);
  if (Date.now() - order.delivered_at.getTime() > windowDays * 86_400_000) {
    throw new AppError('CONFLICT', `Returns must be requested within ${windowDays} days of delivery`, { windowDays });
  }
  const productIds = input.items.map((i) => i.productId);
  if (new Set(productIds).size !== productIds.length) throw new AppError('BAD_REQUEST', 'List each product once');

  const { rows: lines } = await client.query<{ product_id: string; name: string; delivered: number; returning: number }>(
    `SELECT i.product_id, i.name, i.quantity AS delivered,
            coalesce((SELECT sum(ri.quantity) FROM return_items ri JOIN return_requests r ON r.id = ri.return_id
                      WHERE r.order_id = i.order_id AND ri.product_id = i.product_id
                        AND r.status NOT IN ('rejected', 'cancelled')), 0)::int AS returning
     FROM order_items i WHERE i.order_id = $1 AND i.product_id = ANY($2::uuid[])`,
    [order.id, productIds],
  );
  for (const item of input.items) {
    const line = lines.find((l) => l.product_id === item.productId);
    if (!line) throw new AppError('BAD_REQUEST', 'That product is not on this order', { productId: item.productId });
    const left = line.delivered - line.returning;
    if (item.quantity > left) {
      throw new AppError('CONFLICT', `Only ${left} of ${line.name} can still be returned from this order`, {
        productId: item.productId,
        returnable: left,
      });
    }
  }

  const { rows: created } = await client.query<{ id: string }>(
    'INSERT INTO return_requests (order_id, retailer_account_id, requested_by, note) VALUES ($1, $2, $3, $4) RETURNING id',
    [order.id, accountId, userId, input.note ?? null],
  );
  const returnId = created[0]!.id;
  for (const item of input.items) {
    await client.query(
      'INSERT INTO return_items (return_id, product_id, quantity, reason, batch_number) VALUES ($1, $2, $3, $4, $5)',
      [returnId, item.productId, item.quantity, item.reason, item.batchNumber ?? null],
    );
  }
  return returnId;
}

async function lockReturn(client: PoolClient, id: string, accountId?: string): Promise<ReturnRow> {
  const { rows } = await client.query<ReturnRow>(
    `SELECT id, return_number, order_id, retailer_account_id, status FROM return_requests
     WHERE id = $1 AND ($2::uuid IS NULL OR retailer_account_id = $2) FOR UPDATE`,
    [id, accountId ?? null],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND', 'Return not found');
  return rows[0];
}

function requireStatus(r: ReturnRow, ...allowed: ReturnStatus[]): void {
  if (!allowed.includes(r.status)) throw new AppError('CONFLICT', `Return ${r.return_number} is ${r.status.replaceAll('_', ' ')}`);
}

/** Evidence can be added while the request waits for review. */
export async function lockReturnForEvidence(client: PoolClient, id: string, accountId: string) {
  const r = await lockReturn(client, id, accountId);
  requireStatus(r, 'requested');
  const { rows } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM return_evidence WHERE return_id = $1', [id]);
  if (rows[0]!.n >= MAX_EVIDENCE_FILES) throw new AppError('CONFLICT', `At most ${MAX_EVIDENCE_FILES} files per return`);
  return r;
}

export async function recordEvidence(
  client: PoolClient,
  returnId: string,
  userId: string,
  file: { key: string; contentType: string; sizeBytes: number; sha256: string },
) {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO return_evidence (return_id, storage_key, content_type, size_bytes, sha256, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [returnId, file.key, file.contentType, file.sizeBytes, file.sha256, userId],
  );
  return rows[0]!.id;
}

export async function cancelReturn(client: PoolClient, id: string, accountId: string) {
  const r = await lockReturn(client, id, accountId);
  requireStatus(r, 'requested');
  await client.query("UPDATE return_requests SET status = 'cancelled', updated_at = now() WHERE id = $1", [id]);
}

export async function decideReturn(
  client: PoolClient,
  id: string,
  actor: string,
  input: { decision: 'approve' | 'reject'; reason: string },
) {
  const r = await lockReturn(client, id);
  requireStatus(r, 'requested');
  const to = input.decision === 'approve' ? 'approved' : 'rejected';
  await client.query(
    `UPDATE return_requests SET status = $2, decided_by = $3, decided_at = now(), decision_reason = $4, updated_at = now()
     WHERE id = $1`,
    [id, to, actor, input.reason],
  );
  return { before: r, status: to };
}

export async function schedulePickup(client: PoolClient, id: string, input: { riderUserId: string; pickupDate: string }) {
  const r = await lockReturn(client, id);
  requireStatus(r, 'approved', 'pickup_scheduled');
  const { rows } = await client.query(
    `SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.role = 'rider' WHERE u.id = $1 AND u.status = 'active'`,
    [input.riderUserId],
  );
  if (!rows[0]) throw new AppError('BAD_REQUEST', 'That user is not an active rider');
  await client.query(
    `UPDATE return_requests SET status = 'pickup_scheduled', pickup_rider_user_id = $2, pickup_date = $3, updated_at = now()
     WHERE id = $1`,
    [id, input.riderUserId, input.pickupDate],
  );
  return r;
}

/** Goods are back at the Taneja warehouse. They stay off sale until inspection decides what happens. */
export async function receiveReturn(client: PoolClient, id: string, actor: string) {
  const r = await lockReturn(client, id);
  requireStatus(r, 'approved', 'pickup_scheduled');
  await client.query(
    "UPDATE return_requests SET status = 'received', received_by = $2, received_at = now(), updated_at = now() WHERE id = $1",
    [id, actor],
  );
  return r;
}

export interface InspectionInput {
  grReference: string;
  resolution: 'credit_note' | 'replacement' | 'no_action';
  resolutionReference?: string;
  items: { itemId: string; acceptedQty: number; disposition: Disposition; batchNumber?: string; note?: string }[];
}

/**
 * Records the inspection of every returned line and closes the return. Only units marked
 * "restock" go back into a known batch of the same product; the rest never re-enter stock.
 * The outcome (credit note or replacement) is recorded by reference; no money moves here.
 */
export async function inspectReturn(client: PoolClient, id: string, actor: string, input: InspectionInput) {
  const r = await lockReturn(client, id);
  requireStatus(r, 'received');
  if (input.resolution !== 'no_action' && !input.resolutionReference) {
    throw new AppError('BAD_REQUEST', 'Give the credit note or replacement order number');
  }
  const { rows: items } = await client.query<{ id: string; product_id: string; quantity: number }>(
    'SELECT id, product_id, quantity FROM return_items WHERE return_id = $1 FOR UPDATE',
    [id],
  );
  const byId = new Map(input.items.map((i) => [i.itemId, i]));
  if (byId.size !== input.items.length || items.length !== input.items.length || items.some((i) => !byId.has(i.id))) {
    throw new AppError('BAD_REQUEST', 'Inspect every line of the return exactly once');
  }
  const restocked: { itemId: string; batchId: string; quantity: number }[] = [];
  for (const item of items) {
    const result = byId.get(item.id)!;
    if (result.acceptedQty > item.quantity) throw new AppError('BAD_REQUEST', 'Accepted quantity exceeds the returned quantity', { itemId: item.id });
    let batchId: string | null = null;
    if (result.disposition === 'restock' && result.acceptedQty > 0) {
      if (!result.batchNumber) throw new AppError('BAD_REQUEST', 'Give the batch to restock into', { itemId: item.id });
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM inventory_batches WHERE product_id = $1 AND batch_number = $2 FOR UPDATE',
        [item.product_id, result.batchNumber],
      );
      if (!rows[0]) throw new AppError('BAD_REQUEST', `Batch ${result.batchNumber} is not known for this product`, { itemId: item.id });
      batchId = rows[0].id;
      await client.query('UPDATE inventory_batches SET on_hand_qty = on_hand_qty + $2, updated_at = now() WHERE id = $1', [
        batchId,
        result.acceptedQty,
      ]);
      await client.query(
        "INSERT INTO inventory_movements (batch_id, kind, quantity, reference, actor_user_id) VALUES ($1, 'return', $2, $3, $4)",
        [batchId, result.acceptedQty, r.return_number, actor],
      );
      restocked.push({ itemId: item.id, batchId, quantity: result.acceptedQty });
    }
    await client.query(
      `UPDATE return_items SET accepted_qty = $2, disposition = $3, restock_batch_id = $4, inspection_note = $5,
              batch_number = coalesce($6, batch_number)
       WHERE id = $1`,
      [item.id, result.acceptedQty, result.disposition, batchId, result.note ?? null, result.batchNumber ?? null],
    );
  }
  await client.query(
    `UPDATE return_requests SET status = 'closed', gr_reference = $2, resolution = $3, resolution_reference = $4,
            closed_by = $5, closed_at = now(), updated_at = now()
     WHERE id = $1`,
    [id, input.grReference, input.resolution, input.resolutionReference ?? null, actor],
  );
  return { before: r, restocked };
}

/** Retailer view: their own returns, with the outcome but no internal notes or dispositions. */
export async function listReturns(
  db: Queryable,
  filter: { accountId?: string; status?: ReturnStatus; limit: number; offset: number; staff: boolean },
) {
  const { rows } = await db.query(
    `SELECT r.id, r.return_number AS "returnNumber", r.order_id AS "orderId", o.order_number AS "orderNumber", r.status,
            r.note, r.decision_reason AS "decisionReason", r.pickup_date AS "pickupDate", r.resolution,
            r.resolution_reference AS "resolutionReference", r.created_at AS "createdAt", r.updated_at AS "updatedAt"
            ${filter.staff ? ', a.business_name AS "businessName", r.gr_reference AS "grReference"' : ''}
     FROM return_requests r JOIN orders o ON o.id = r.order_id JOIN retailer_accounts a ON a.id = r.retailer_account_id
     WHERE ($1::uuid IS NULL OR r.retailer_account_id = $1) AND ($2::text IS NULL OR r.status = $2)
     ORDER BY r.created_at DESC
     LIMIT $3 OFFSET $4`,
    [filter.accountId ?? null, filter.status ?? null, filter.limit, filter.offset],
  );
  return rows;
}

export async function getReturn(db: Queryable, id: string, opts: { accountId?: string; staff: boolean }) {
  const list = await db.query(
    `SELECT r.id, r.return_number AS "returnNumber", r.order_id AS "orderId", o.order_number AS "orderNumber", r.status,
            r.note, r.decision_reason AS "decisionReason", r.pickup_date AS "pickupDate", r.resolution,
            r.resolution_reference AS "resolutionReference", r.created_at AS "createdAt"
            ${opts.staff ? `, a.business_name AS "businessName", r.gr_reference AS "grReference", r.decided_by AS "decidedBy",
                            r.pickup_rider_user_id AS "pickupRiderUserId", r.received_at AS "receivedAt", r.closed_at AS "closedAt"` : ''}
     FROM return_requests r JOIN orders o ON o.id = r.order_id JOIN retailer_accounts a ON a.id = r.retailer_account_id
     WHERE r.id = $1 AND ($2::uuid IS NULL OR r.retailer_account_id = $2)`,
    [id, opts.accountId ?? null],
  );
  if (!list.rows[0]) throw new AppError('NOT_FOUND', 'Return not found');
  const items = await db.query(
    `SELECT ri.id, ri.product_id AS "productId", p.sku, p.name, ri.quantity, ri.reason, ri.batch_number AS "batchNumber",
            ri.accepted_qty AS "acceptedQty"
            ${opts.staff ? ', ri.disposition, ri.inspection_note AS "inspectionNote"' : ''}
     FROM return_items ri JOIN products p ON p.id = ri.product_id WHERE ri.return_id = $1 ORDER BY p.name`,
    [id],
  );
  const evidence = await db.query(
    `SELECT id, content_type AS "contentType", size_bytes AS "sizeBytes", uploaded_at AS "uploadedAt"
     FROM return_evidence WHERE return_id = $1 ORDER BY uploaded_at`,
    [id],
  );
  return { ...list.rows[0], items: items.rows, evidence: evidence.rows };
}
