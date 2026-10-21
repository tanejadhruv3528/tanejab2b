import type { PoolClient } from 'pg';
import type { Db } from './db.js';
import { AppError } from './errors.js';
import { consumeReserved, loadAvailabilityPolicy, quarantineReserved, reserveStock } from './inventory.js';
import { lockOrder, setStatus, type OrderRow } from './orders.js';

type Queryable = Pick<Db, 'query'> | PoolClient;

export type TaskStatus = 'open' | 'picking' | 'short_pick' | 'picked' | 'packed' | 'cancelled';
export type ShortReason = 'not_found' | 'damaged' | 'expiry_mismatch' | 'other';

export const ACTIVE_TASK_STATUSES: TaskStatus[] = ['open', 'picking', 'short_pick', 'picked'];

interface TaskRow {
  id: string;
  order_id: string;
  status: TaskStatus;
}

export async function listTasks(db: Queryable, filter: { statuses: TaskStatus[]; limit: number; offset: number }) {
  const { rows } = await db.query(
    `SELECT t.id, t.status, t.order_id AS "orderId", o.order_number AS "orderNumber", o.status AS "orderStatus",
            a.business_name AS "businessName", t.assigned_to AS "assignedTo", t.created_at AS "createdAt",
            (SELECT count(*)::int FROM warehouse_pick_lines l WHERE l.task_id = t.id) AS "lineCount"
     FROM warehouse_tasks t
     JOIN orders o ON o.id = t.order_id
     JOIN retailer_accounts a ON a.id = o.retailer_account_id
     WHERE t.status = ANY($1::text[])
     ORDER BY t.created_at, o.order_number
     LIMIT $2 OFFSET $3`,
    [filter.statuses, filter.limit, filter.offset],
  );
  return rows;
}

/** A pick task with what to take from where. No prices: pickers only need the goods. */
export async function getTask(db: Queryable, taskId: string) {
  const { rows } = await db.query(
    `SELECT t.id, t.status, t.order_id AS "orderId", o.order_number AS "orderNumber", o.status AS "orderStatus",
            a.business_name AS "businessName", t.assigned_to AS "assignedTo", t.started_at AS "startedAt",
            t.picked_at AS "pickedAt", t.packed_by AS "packedBy", t.packed_at AS "packedAt",
            t.package_count AS "packageCount", t.pack_checklist AS "packChecklist"
     FROM warehouse_tasks t
     JOIN orders o ON o.id = t.order_id
     JOIN retailer_accounts a ON a.id = o.retailer_account_id
     WHERE t.id = $1`,
    [taskId],
  );
  const task = rows[0];
  if (!task) throw new AppError('NOT_FOUND', 'Task not found');
  const lines = await db.query(
    `SELECT l.id, l.product_id AS "productId", p.sku, p.name, p.pack_size AS "packSize", b.batch_number AS "batchNumber",
            to_char(b.expiry_date, 'YYYY-MM-DD') AS "expiryDate", b.location, l.expected_qty AS "expectedQty",
            l.picked_qty AS "pickedQty", l.short_reason AS "shortReason", l.short_note AS "shortNote",
            l.short_resolved_at AS "shortResolvedAt", l.confirmed_by AS "confirmedBy", l.confirmed_at AS "confirmedAt"
     FROM warehouse_pick_lines l
     JOIN products p ON p.id = l.product_id
     JOIN inventory_batches b ON b.id = l.batch_id
     WHERE l.task_id = $1
     ORDER BY l.created_at, b.location NULLS LAST, p.name, b.batch_number`,
    [taskId],
  );
  return { ...task, lines: lines.rows };
}

/** Locks the order first, then its task, the same order every path uses. */
async function lockTaskById(client: PoolClient, taskId: string): Promise<{ task: TaskRow; order: OrderRow }> {
  const { rows } = await client.query<{ order_id: string }>('SELECT order_id FROM warehouse_tasks WHERE id = $1', [taskId]);
  if (!rows[0]) throw new AppError('NOT_FOUND', 'Task not found');
  const order = await lockOrder(client, rows[0].order_id);
  const task = await client.query<TaskRow>('SELECT id, order_id, status FROM warehouse_tasks WHERE id = $1 FOR UPDATE', [taskId]);
  return { task: task.rows[0]!, order };
}

async function lockTaskByOrder(client: PoolClient, orderId: string): Promise<{ task: TaskRow; order: OrderRow }> {
  const order = await lockOrder(client, orderId);
  const { rows } = await client.query<TaskRow>(
    'SELECT id, order_id, status FROM warehouse_tasks WHERE order_id = $1 FOR UPDATE',
    [orderId],
  );
  if (!rows[0]) throw new AppError('CONFLICT', 'This order has no pick task yet');
  return { task: rows[0], order };
}

function requireState(order: OrderRow, task: TaskRow, orderStatus: string, taskStatus: TaskStatus): void {
  if (order.status !== orderStatus) {
    throw new AppError('CONFLICT', `Order ${order.order_number} is ${order.status.replaceAll('_', ' ')}`, {
      orderStatus: order.status,
    });
  }
  if (task.status !== taskStatus) {
    throw new AppError('CONFLICT', `Task is ${task.status.replaceAll('_', ' ')}, not ${taskStatus.replaceAll('_', ' ')}`, {
      taskStatus: task.status,
    });
  }
}

export async function startPicking(client: PoolClient, taskId: string, actor: string) {
  const { task, order } = await lockTaskById(client, taskId);
  requireState(order, task, 'accepted', 'open');
  await client.query(
    "UPDATE warehouse_tasks SET status = 'picking', assigned_to = $2, started_at = now(), updated_at = now() WHERE id = $1",
    [task.id, actor],
  );
  await setStatus(client, order, 'picking', actor, null);
  return { task, order };
}

export interface PickConfirmation {
  lineId: string;
  pickedQty: number;
  shortReason?: ShortReason;
  shortNote?: string;
}

/**
 * Records what was actually picked for every open line. Any shortfall is taken off the order's
 * reservation and held in quarantine until a stock check, and the order goes to short-pick review.
 * Lines are never dropped silently.
 */
export async function confirmPick(client: PoolClient, taskId: string, actor: string, input: PickConfirmation[]) {
  const { task, order } = await lockTaskById(client, taskId);
  requireState(order, task, 'picking', 'picking');
  const { rows: open } = await client.query<{ id: string; batch_id: string; expected_qty: number }>(
    'SELECT id, batch_id, expected_qty FROM warehouse_pick_lines WHERE task_id = $1 AND confirmed_at IS NULL ORDER BY batch_id',
    [task.id],
  );
  const byId = new Map(input.map((l) => [l.lineId, l]));
  if (byId.size !== input.length) throw new AppError('BAD_REQUEST', 'Each line can be confirmed only once');
  const missing = open.filter((l) => !byId.has(l.id)).map((l) => l.id);
  const unknown = input.filter((l) => !open.some((o) => o.id === l.lineId)).map((l) => l.lineId);
  if (missing.length || unknown.length) {
    throw new AppError('BAD_REQUEST', 'Confirm every open line of this task, and only those', { missing, unknown });
  }

  const shorts: { lineId: string; shortfall: number }[] = [];
  for (const line of open) {
    const c = byId.get(line.id)!;
    if (c.pickedQty > line.expected_qty) {
      throw new AppError('BAD_REQUEST', 'Picked quantity cannot exceed the pick list', { lineId: line.id });
    }
    const shortfall = line.expected_qty - c.pickedQty;
    if (shortfall > 0 && !c.shortReason) {
      throw new AppError('BAD_REQUEST', 'Give a reason for every short line', { lineId: line.id });
    }
    await client.query(
      `UPDATE warehouse_pick_lines SET picked_qty = $2, short_reason = $3, short_note = $4, confirmed_by = $5, confirmed_at = now()
       WHERE id = $1`,
      [line.id, c.pickedQty, shortfall > 0 ? c.shortReason : null, shortfall > 0 ? (c.shortNote ?? null) : null, actor],
    );
    if (shortfall === 0) continue;
    shorts.push({ lineId: line.id, shortfall });
    await quarantineReserved(client, line.batch_id, shortfall, { reference: `${order.order_number}:short-pick`, actorUserId: actor });
    // The allocation now covers only what was found. A fully short batch stops being reserved for this order.
    await client.query(
      `UPDATE order_allocations
       SET quantity = CASE WHEN quantity > $3 THEN quantity - $3 ELSE quantity END,
           released_at = CASE WHEN quantity > $3 THEN released_at ELSE now() END
       WHERE order_id = $1 AND batch_id = $2 AND released_at IS NULL`,
      [order.id, line.batch_id, shortfall],
    );
  }

  if (shorts.length > 0) {
    await client.query("UPDATE warehouse_tasks SET status = 'short_pick', updated_at = now() WHERE id = $1", [task.id]);
    const units = shorts.reduce((sum, s) => sum + s.shortfall, 0);
    await setStatus(client, order, 'short_pick_review', actor, `${units} unit(s) could not be picked; our team will review`);
  } else {
    await client.query("UPDATE warehouse_tasks SET status = 'picked', picked_at = now(), updated_at = now() WHERE id = $1", [
      task.id,
    ]);
  }
  return { task, order, shorts };
}

/**
 * Resolves a short pick by reserving the missing units from other batches of the same product
 * (never a different product). Fails with INSUFFICIENT_STOCK if there is not enough; staff can then
 * cancel the order instead. Partial fulfilment is not offered until the owner approves it.
 */
export async function reallocateShortPick(client: PoolClient, orderId: string, actor: string, reason: string) {
  const { task, order } = await lockTaskByOrder(client, orderId);
  requireState(order, task, 'short_pick_review', 'short_pick');
  const { rows: shorts } = await client.query<{ id: string; product_id: string; batch_id: string; shortfall: number; name: string }>(
    `SELECT l.id, l.product_id, l.batch_id, l.expected_qty - l.picked_qty AS shortfall, p.name
     FROM warehouse_pick_lines l JOIN products p ON p.id = l.product_id
     WHERE l.task_id = $1 AND l.picked_qty < l.expected_qty AND l.short_resolved_at IS NULL
     ORDER BY p.name, l.batch_id`,
    [task.id],
  );
  const { rows: tried } = await client.query<{ product_id: string; batch_id: string }>(
    'SELECT DISTINCT product_id, batch_id FROM warehouse_pick_lines WHERE task_id = $1 AND picked_qty < expected_qty',
    [task.id],
  );
  const policy = await loadAvailabilityPolicy(client);
  const needs = new Map<string, { shortfall: number; name: string }>();
  for (const s of shorts) {
    const n = needs.get(s.product_id) ?? { shortfall: 0, name: s.name };
    n.shortfall += s.shortfall;
    needs.set(s.product_id, n);
  }
  const added: { productId: string; batchId: string; quantity: number }[] = [];
  for (const [productId, need] of needs) {
    let reserved;
    try {
      reserved = await reserveStock(client, productId, need.shortfall, {
        reference: `${order.order_number}:reallocate`,
        actorUserId: actor,
        minShelfLifeDays: policy.minShelfLifeDays,
        // Batches that already came up short in this task are not offered again.
        excludeBatchIds: tried.filter((t) => t.product_id === productId).map((t) => t.batch_id),
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'CONFLICT') {
        throw new AppError('INSUFFICIENT_STOCK', `Not enough other stock of ${need.name} to cover the short pick`, error.details);
      }
      throw error;
    }
    for (const r of reserved) {
      await client.query(
        `INSERT INTO order_allocations (order_id, product_id, batch_id, quantity) VALUES ($1, $2, $3, $4)
         ON CONFLICT (order_id, batch_id) DO UPDATE SET
           quantity = CASE WHEN order_allocations.released_at IS NULL
                           THEN order_allocations.quantity + EXCLUDED.quantity ELSE EXCLUDED.quantity END,
           released_at = NULL`,
        [order.id, productId, r.batchId, r.quantity],
      );
      await client.query(
        'INSERT INTO warehouse_pick_lines (task_id, product_id, batch_id, expected_qty) VALUES ($1, $2, $3, $4)',
        [task.id, productId, r.batchId, r.quantity],
      );
      added.push({ productId, batchId: r.batchId, quantity: r.quantity });
    }
  }
  await client.query('UPDATE warehouse_pick_lines SET short_resolved_at = now() WHERE id = ANY($1::uuid[])', [
    shorts.map((s) => s.id),
  ]);
  await client.query("UPDATE warehouse_tasks SET status = 'picking', updated_at = now() WHERE id = $1", [task.id]);
  await setStatus(client, order, 'picking', actor, 'Missing items found in other stock; picking resumed');
  return { task, order, added, reason };
}

export interface PackInput {
  packageCount: number;
  checklist: { quantitiesMatch: true; batchAndExpiryChecked: true; sealedAndLabelled: true };
}

export async function confirmPack(client: PoolClient, taskId: string, actor: string, input: PackInput) {
  const { task, order } = await lockTaskById(client, taskId);
  requireState(order, task, 'picking', 'picked');
  await client.query(
    `UPDATE warehouse_tasks SET status = 'packed', packed_by = $2, packed_at = now(), package_count = $3, pack_checklist = $4,
            updated_at = now()
     WHERE id = $1`,
    [task.id, actor, input.packageCount, JSON.stringify(input.checklist)],
  );
  await setStatus(client, order, 'packed', actor, null);
  return { task, order };
}

export interface InvoiceInput {
  invoiceNumber: string;
  amountPaise: number;
  mismatchReason?: string;
}

/**
 * Records the Marg tax invoice for a packed order. Typed in by billing staff; nothing is sent to Marg.
 * The invoiced units leave stock and the order becomes ready for dispatch.
 */
export async function recordInvoice(client: PoolClient, orderId: string, actor: string, input: InvoiceInput) {
  const order = await lockOrder(client, orderId);
  if (order.status !== 'packed') {
    throw new AppError('CONFLICT', `Order ${order.order_number} is ${order.status.replaceAll('_', ' ')}, not packed`);
  }
  const { rows } = await client.query<{ payable_paise: string }>('SELECT payable_paise FROM orders WHERE id = $1', [order.id]);
  const payablePaise = Number(rows[0]!.payable_paise);
  const mismatch = input.amountPaise !== payablePaise;
  if (mismatch && !input.mismatchReason) {
    throw new AppError('CONFLICT', 'Invoice total does not match the order. Check it, or give a reason to accept it.', {
      payablePaise,
      invoiceAmountPaise: input.amountPaise,
    });
  }
  try {
    await client.query(
      `INSERT INTO order_invoices (order_id, invoice_number, amount_paise, mismatch_reason, recorded_by) VALUES ($1, $2, $3, $4, $5)`,
      [order.id, input.invoiceNumber, input.amountPaise, mismatch ? input.mismatchReason : null, actor],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new AppError('CONFLICT', 'This invoice number is already recorded against another order');
    }
    throw error;
  }
  const { rows: allocations } = await client.query<{ batch_id: string; quantity: number }>(
    'SELECT batch_id, quantity FROM order_allocations WHERE order_id = $1 AND released_at IS NULL',
    [order.id],
  );
  await consumeReserved(
    client,
    allocations.map((a) => ({ batchId: a.batch_id, quantity: a.quantity })),
    { reference: `${order.order_number}:invoice:${input.invoiceNumber}`, actorUserId: actor },
  );
  // released_at here means "no longer reserved": the units were invoiced, not returned to sale.
  await client.query('UPDATE order_allocations SET released_at = now() WHERE order_id = $1 AND released_at IS NULL', [order.id]);
  await setStatus(client, order, 'ready_for_dispatch', actor, null);
  return { order, payablePaise, mismatch };
}
