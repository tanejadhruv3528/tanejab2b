import type { PoolClient } from 'pg';
import type { Db } from './db.js';
import { AppError } from './errors.js';

type Queryable = Pick<Db, 'query'> | PoolClient;

export type RequestStatus = 'open' | 'ordered' | 'received' | 'unavailable' | 'cancelled';

/** Open requests a single retailer may have at once, to keep the procurement queue usable. */
export const MAX_OPEN_SPECIAL_ORDERS = 20;

async function requireOrderableProduct(db: Queryable, productId: string): Promise<{ name: string }> {
  const { rows } = await db.query<{ name: string; status: string; cold_chain: boolean }>(
    'SELECT name, status, cold_chain FROM products WHERE id = $1',
    [productId],
  );
  const p = rows[0];
  if (!p) throw new AppError('NOT_FOUND', 'Product not found');
  if (p.status !== 'active') throw new AppError('CONFLICT', `${p.name} cannot be ordered (${p.status})`);
  // Cold-chain delivery is not validated yet, so these cannot be special-ordered either.
  if (p.cold_chain) throw new AppError('CONFLICT', `${p.name} needs cold-chain delivery, which is not available yet`);
  return { name: p.name };
}

export interface SpecialOrderInput {
  productId?: string;
  requestedName?: string;
  quantity: number;
  note?: string;
}

export async function createSpecialOrder(client: PoolClient, accountId: string, userId: string, input: SpecialOrderInput) {
  if (!input.productId && !input.requestedName) {
    throw new AppError('BAD_REQUEST', 'Choose a product or type the medicine name');
  }
  if (input.productId) await requireOrderableProduct(client, input.productId);
  // Serialise per retailer so the open-request cap holds under concurrent submits.
  await client.query('SELECT id FROM retailer_accounts WHERE id = $1 FOR UPDATE', [accountId]);
  const { rows: open } = await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM procurement_requests WHERE retailer_account_id = $1 AND status IN ('open', 'ordered')",
    [accountId],
  );
  if (open[0]!.n >= MAX_OPEN_SPECIAL_ORDERS) {
    throw new AppError('CONFLICT', `You already have ${MAX_OPEN_SPECIAL_ORDERS} open special-order requests`);
  }
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO procurement_requests (kind, retailer_account_id, requested_by, product_id, requested_name, quantity, note)
     VALUES ('special_order', $1, $2, $3, $4, $5, $6) RETURNING id`,
    [accountId, userId, input.productId ?? null, input.productId ? null : input.requestedName, input.quantity, input.note ?? null],
  );
  return rows[0]!.id;
}

export async function createRestockRequest(client: PoolClient, userId: string, input: { productId: string; quantity: number; note?: string }) {
  const { rows: products } = await client.query('SELECT 1 FROM products WHERE id = $1', [input.productId]);
  if (!products[0]) throw new AppError('NOT_FOUND', 'Product not found');
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO procurement_requests (kind, requested_by, product_id, quantity, note)
     VALUES ('restock', $1, $2, $3, $4) RETURNING id`,
    [userId, input.productId, input.quantity, input.note ?? null],
  );
  return rows[0]!.id;
}

/**
 * The retailer's view: no supplier, cost or internal notes. The ETA is shown only once a supplier
 * has confirmed it; until then it is "to be confirmed".
 */
export async function listSpecialOrders(db: Queryable, accountId: string, opts: { limit: number; offset: number }) {
  const { rows } = await db.query(
    `SELECT r.id, r.request_number AS "requestNumber", r.product_id AS "productId", coalesce(p.name, r.requested_name) AS name,
            p.pack_size AS "packSize", r.quantity, r.note, r.status,
            CASE WHEN r.eta_confirmed_at IS NOT NULL THEN to_char(r.eta_date, 'YYYY-MM-DD') END AS "etaDate",
            r.eta_confirmed_at IS NOT NULL AS "etaConfirmed", r.created_at AS "createdAt", r.updated_at AS "updatedAt"
     FROM procurement_requests r LEFT JOIN products p ON p.id = r.product_id
     WHERE r.retailer_account_id = $1
     ORDER BY r.created_at DESC
     LIMIT $2 OFFSET $3`,
    [accountId, opts.limit, opts.offset],
  );
  return rows;
}

export async function cancelSpecialOrder(client: PoolClient, requestId: string, accountId: string) {
  const { rows } = await client.query<{ status: RequestStatus }>(
    'SELECT status FROM procurement_requests WHERE id = $1 AND retailer_account_id = $2 FOR UPDATE',
    [requestId, accountId],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND', 'Request not found');
  if (rows[0].status !== 'open') {
    throw new AppError('CONFLICT', 'Only requests not yet ordered from a supplier can be cancelled here');
  }
  await client.query(
    "UPDATE procurement_requests SET status = 'cancelled', outcome_note = 'Cancelled by retailer', updated_at = now() WHERE id = $1",
    [requestId],
  );
}

export async function listRequests(db: Queryable, filter: { status?: RequestStatus; limit: number; offset: number }) {
  const { rows } = await db.query(
    `SELECT r.id, r.request_number AS "requestNumber", r.kind, r.retailer_account_id AS "retailerAccountId",
            a.business_name AS "businessName", r.product_id AS "productId", p.sku, coalesce(p.name, r.requested_name) AS name,
            r.requested_name AS "requestedName", r.quantity, r.note, r.status,
            to_char(r.eta_date, 'YYYY-MM-DD') AS "etaDate", r.eta_confirmed_at AS "etaConfirmedAt",
            r.outcome_note AS "outcomeNote", r.created_at AS "createdAt", r.updated_at AS "updatedAt"
     FROM procurement_requests r
     LEFT JOIN products p ON p.id = r.product_id
     LEFT JOIN retailer_accounts a ON a.id = r.retailer_account_id
     WHERE ($1::text IS NULL OR r.status = $1)
     ORDER BY r.created_at
     LIMIT $2 OFFSET $3`,
    [filter.status ?? null, filter.limit, filter.offset],
  );
  return rows;
}

async function lockRequest(client: PoolClient, id: string) {
  const { rows } = await client.query<{ id: string; status: RequestStatus; eta_date: string | null }>(
    "SELECT id, status, to_char(eta_date, 'YYYY-MM-DD') AS eta_date FROM procurement_requests WHERE id = $1 FOR UPDATE",
    [id],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND', 'Request not found');
  return rows[0];
}

/** Records a supplier-confirmed arrival date. Only now does the retailer see a date. */
export async function confirmEta(client: PoolClient, id: string, etaDate: string) {
  const before = await lockRequest(client, id);
  if (before.status !== 'open' && before.status !== 'ordered') {
    throw new AppError('CONFLICT', `Request is ${before.status}`);
  }
  const { rows } = await client.query<{ past: boolean }>(
    "SELECT $1::date < (now() AT TIME ZONE 'Asia/Kolkata')::date AS past",
    [etaDate],
  );
  if (rows[0]!.past) throw new AppError('BAD_REQUEST', 'ETA cannot be in the past');
  await client.query(
    'UPDATE procurement_requests SET eta_date = $2, eta_confirmed_at = now(), updated_at = now() WHERE id = $1',
    [id, etaDate],
  );
  return before;
}

/** Closes a request that cannot be met (e.g. no supplier has it) or is no longer needed. */
export async function closeRequest(client: PoolClient, id: string, outcome: 'unavailable' | 'cancelled', reason: string) {
  const before = await lockRequest(client, id);
  if (before.status !== 'open') {
    throw new AppError('CONFLICT', before.status === 'ordered' ? 'Cancel the purchase order first' : `Request is ${before.status}`);
  }
  await client.query(
    'UPDATE procurement_requests SET status = $2, outcome_note = $3, updated_at = now() WHERE id = $1',
    [id, outcome, reason],
  );
  return before;
}

export async function listSuppliers(db: Queryable) {
  const { rows } = await db.query(
    'SELECT id, name, gstin, phone, active, created_at AS "createdAt" FROM suppliers ORDER BY name',
  );
  return rows;
}

export async function createSupplier(client: PoolClient, userId: string, input: { name: string; gstin?: string; phone?: string }) {
  try {
    const { rows } = await client.query<{ id: string }>(
      'INSERT INTO suppliers (name, gstin, phone, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
      [input.name, input.gstin ?? null, input.phone ?? null, userId],
    );
    return rows[0]!.id;
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new AppError('CONFLICT', 'A supplier with this name exists');
    throw error;
  }
}

export interface PurchaseOrderInput {
  supplierId: string;
  note?: string;
  items: { productId: string; quantity: number; unitCostPaise: number; requestId?: string }[];
}

export async function createPurchaseOrder(client: PoolClient, userId: string, input: PurchaseOrderInput) {
  const { rows: suppliers } = await client.query<{ active: boolean }>('SELECT active FROM suppliers WHERE id = $1', [
    input.supplierId,
  ]);
  if (!suppliers[0]) throw new AppError('NOT_FOUND', 'Supplier not found');
  if (!suppliers[0].active) throw new AppError('CONFLICT', 'Supplier is inactive');
  const requestIds = input.items.flatMap((i) => (i.requestId ? [i.requestId] : []));
  if (new Set(requestIds).size !== requestIds.length) throw new AppError('BAD_REQUEST', 'A request can be on one line only');

  const { rows: po } = await client.query<{ id: string }>(
    'INSERT INTO purchase_orders (supplier_id, note, created_by) VALUES ($1, $2, $3) RETURNING id',
    [input.supplierId, input.note ?? null, userId],
  );
  const poId = po[0]!.id;
  for (const item of input.items) {
    const { rows: products } = await client.query('SELECT 1 FROM products WHERE id = $1', [item.productId]);
    if (!products[0]) throw new AppError('NOT_FOUND', 'Product not found', { productId: item.productId });
    if (item.requestId) {
      const { rows } = await client.query<{ status: RequestStatus; product_id: string | null }>(
        'SELECT status, product_id FROM procurement_requests WHERE id = $1 FOR UPDATE',
        [item.requestId],
      );
      const request = rows[0];
      if (!request) throw new AppError('NOT_FOUND', 'Request not found', { requestId: item.requestId });
      if (request.status !== 'open') throw new AppError('CONFLICT', `Request is ${request.status}`, { requestId: item.requestId });
      if (request.product_id && request.product_id !== item.productId) {
        throw new AppError('BAD_REQUEST', 'Line product differs from the requested product', { requestId: item.requestId });
      }
      // A typed-in request gets linked to the catalogue product procurement chose.
      await client.query(
        "UPDATE procurement_requests SET status = 'ordered', product_id = $2, updated_at = now() WHERE id = $1",
        [item.requestId, item.productId],
      );
    }
    await client.query(
      `INSERT INTO purchase_order_items (purchase_order_id, product_id, procurement_request_id, quantity, unit_cost_paise)
       VALUES ($1, $2, $3, $4, $5)`,
      [poId, item.productId, item.requestId ?? null, item.quantity, item.unitCostPaise],
    );
  }
  return poId;
}

export async function listPurchaseOrders(db: Queryable, filter: { status?: string; limit: number; offset: number }) {
  const { rows } = await db.query(
    `SELECT po.id, po.po_number AS "poNumber", po.status, s.name AS "supplierName", po.created_at AS "createdAt",
            po.sent_at AS "sentAt", (SELECT count(*)::int FROM purchase_order_items i WHERE i.purchase_order_id = po.id) AS "lineCount",
            (SELECT coalesce(sum(i.quantity * i.unit_cost_paise), 0)::bigint FROM purchase_order_items i
             WHERE i.purchase_order_id = po.id)::text AS "totalCostPaise"
     FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
     WHERE ($1::text IS NULL OR po.status = $1)
     ORDER BY po.created_at DESC
     LIMIT $2 OFFSET $3`,
    [filter.status ?? null, filter.limit, filter.offset],
  );
  return rows;
}

export async function getPurchaseOrder(db: Queryable, id: string) {
  const { rows } = await db.query(
    `SELECT po.id, po.po_number AS "poNumber", po.status, po.note, po.supplier_id AS "supplierId", s.name AS "supplierName",
            po.created_by AS "createdBy", po.created_at AS "createdAt", po.sent_at AS "sentAt"
     FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1`,
    [id],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND', 'Purchase order not found');
  const items = await db.query(
    `SELECT i.id, i.product_id AS "productId", p.sku, p.name, i.procurement_request_id AS "requestId", i.quantity,
            i.unit_cost_paise::text AS "unitCostPaise", i.received_qty AS "receivedQty", i.rejected_qty AS "rejectedQty"
     FROM purchase_order_items i JOIN products p ON p.id = i.product_id
     WHERE i.purchase_order_id = $1 ORDER BY p.name`,
    [id],
  );
  const receipts = await db.query(
    `SELECT g.id, g.purchase_order_item_id AS "itemId", g.batch_number AS "batchNumber",
            to_char(g.expiry_date, 'YYYY-MM-DD') AS "expiryDate", g.accepted_qty AS "acceptedQty", g.rejected_qty AS "rejectedQty",
            g.reject_reason AS "rejectReason", g.supplier_invoice_ref AS "supplierInvoiceRef", g.received_by AS "receivedBy",
            g.received_at AS "receivedAt"
     FROM goods_receipts g JOIN purchase_order_items i ON i.id = g.purchase_order_item_id
     WHERE i.purchase_order_id = $1 ORDER BY g.received_at`,
    [id],
  );
  return { ...rows[0], items: items.rows, receipts: receipts.rows };
}

async function lockPurchaseOrder(client: PoolClient, id: string) {
  const { rows } = await client.query<{ id: string; po_number: string; status: string }>(
    'SELECT id, po_number, status FROM purchase_orders WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND', 'Purchase order not found');
  return rows[0];
}

/** Marks a draft as sent. Nothing is sent to the supplier by the system; staff send it themselves. */
export async function markPurchaseOrderSent(client: PoolClient, id: string) {
  const po = await lockPurchaseOrder(client, id);
  if (po.status !== 'draft') throw new AppError('CONFLICT', `Purchase order is ${po.status}`);
  await client.query("UPDATE purchase_orders SET status = 'sent', sent_at = now(), updated_at = now() WHERE id = $1", [id]);
  return po;
}

/** Cancels a purchase order nothing has been received against; its requests go back to the queue. */
export async function cancelPurchaseOrder(client: PoolClient, id: string, reason: string) {
  const po = await lockPurchaseOrder(client, id);
  if (po.status !== 'draft' && po.status !== 'sent') throw new AppError('CONFLICT', `Purchase order is ${po.status}`);
  await client.query("UPDATE purchase_orders SET status = 'cancelled', note = $2, updated_at = now() WHERE id = $1", [id, reason]);
  await client.query(
    `UPDATE procurement_requests SET status = 'open', eta_date = NULL, eta_confirmed_at = NULL, updated_at = now()
     WHERE id IN (SELECT procurement_request_id FROM purchase_order_items WHERE purchase_order_id = $1) AND status = 'ordered'`,
    [id],
  );
  return po;
}

export interface ReceiptLine {
  itemId: string;
  batchNumber: string;
  expiryDate: string;
  acceptedQty: number;
  rejectedQty: number;
  rejectReason?: 'damaged' | 'short_expiry' | 'wrong_item' | 'other';
}

/**
 * Checks goods in at the Taneja warehouse. Accepted units are added to the batch's on-hand stock
 * straight away; the batch has no selling rate until a Marg stock import supplies one, so new
 * batches are not sold before billing has them. Rejected units are recorded and never stocked.
 */
export async function receiveGoods(
  client: PoolClient,
  poId: string,
  actor: string,
  input: { supplierInvoiceRef?: string; items: ReceiptLine[] },
) {
  const po = await lockPurchaseOrder(client, poId);
  if (po.status !== 'sent' && po.status !== 'partially_received') {
    throw new AppError('CONFLICT', `Goods can be received only against a sent purchase order (this one is ${po.status})`);
  }
  const received: { itemId: string; batchId: string | null; acceptedQty: number; rejectedQty: number }[] = [];
  for (const line of input.items) {
    if (line.acceptedQty + line.rejectedQty === 0) throw new AppError('BAD_REQUEST', 'Each line needs a quantity', { itemId: line.itemId });
    if (line.rejectedQty > 0 && !line.rejectReason) {
      throw new AppError('BAD_REQUEST', 'Give a reason for rejected units', { itemId: line.itemId });
    }
    const { rows } = await client.query<{ product_id: string; quantity: number; received_qty: number; rejected_qty: number }>(
      `SELECT product_id, quantity, received_qty, rejected_qty FROM purchase_order_items
       WHERE id = $1 AND purchase_order_id = $2 FOR UPDATE`,
      [line.itemId, poId],
    );
    const item = rows[0];
    if (!item) throw new AppError('NOT_FOUND', 'Line not on this purchase order', { itemId: line.itemId });
    const outstanding = item.quantity - item.received_qty - item.rejected_qty;
    if (line.acceptedQty + line.rejectedQty > outstanding) {
      throw new AppError('CONFLICT', `Only ${outstanding} units are outstanding on this line`, { itemId: line.itemId, outstanding });
    }

    let batchId: string | null = null;
    if (line.acceptedQty > 0) {
      const { rows: batch } = await client.query<{ id: string; expiry: string }>(
        `INSERT INTO inventory_batches (product_id, batch_number, expiry_date, on_hand_qty)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (product_id, batch_number) DO UPDATE SET on_hand_qty = inventory_batches.on_hand_qty + EXCLUDED.on_hand_qty,
           updated_at = now()
         RETURNING id, to_char(expiry_date, 'YYYY-MM-DD') AS expiry`,
        [item.product_id, line.batchNumber, line.expiryDate, line.acceptedQty],
      );
      if (batch[0]!.expiry !== line.expiryDate) {
        throw new AppError('CONFLICT', `Batch ${line.batchNumber} is already recorded with expiry ${batch[0]!.expiry}`, {
          itemId: line.itemId,
        });
      }
      batchId = batch[0]!.id;
      await client.query(
        "INSERT INTO inventory_movements (batch_id, kind, quantity, reference, actor_user_id) VALUES ($1, 'receipt', $2, $3, $4)",
        [batchId, line.acceptedQty, po.po_number, actor],
      );
    }
    await client.query(
      `INSERT INTO goods_receipts (purchase_order_item_id, batch_id, batch_number, expiry_date, accepted_qty, rejected_qty,
                                   reject_reason, supplier_invoice_ref, received_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [line.itemId, batchId, line.batchNumber, line.expiryDate, line.acceptedQty, line.rejectedQty,
       line.rejectedQty > 0 ? line.rejectReason : null, input.supplierInvoiceRef ?? null, actor],
    );
    await client.query(
      'UPDATE purchase_order_items SET received_qty = received_qty + $2, rejected_qty = rejected_qty + $3 WHERE id = $1',
      [line.itemId, line.acceptedQty, line.rejectedQty],
    );
    received.push({ itemId: line.itemId, batchId, acceptedQty: line.acceptedQty, rejectedQty: line.rejectedQty });
  }

  // A request is met once its line is fully accounted for with at least one unit accepted.
  // If every unit was rejected it goes back to the queue for another supplier.
  await client.query(
    `UPDATE procurement_requests r
     SET status = CASE WHEN i.received_qty > 0 THEN 'received' ELSE 'open' END,
         eta_date = CASE WHEN i.received_qty > 0 THEN r.eta_date END,
         eta_confirmed_at = CASE WHEN i.received_qty > 0 THEN r.eta_confirmed_at END,
         updated_at = now()
     FROM purchase_order_items i
     WHERE i.purchase_order_id = $1 AND i.procurement_request_id = r.id AND r.status = 'ordered'
       AND i.received_qty + i.rejected_qty = i.quantity`,
    [poId],
  );
  const { rows: remaining } = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM purchase_order_items WHERE purchase_order_id = $1 AND received_qty + rejected_qty < quantity',
    [poId],
  );
  const status = remaining[0]!.n === 0 ? 'received' : 'partially_received';
  await client.query('UPDATE purchase_orders SET status = $2, updated_at = now() WHERE id = $1', [poId, status]);
  return { po, status, received };
}
