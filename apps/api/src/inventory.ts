import { DEFAULT_AVAILABILITY_POLICY, type AvailabilityPolicy, type StockRow } from '@taneja/domain';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Db } from './db.js';
import { AppError } from './errors.js';

type Queryable = Pick<Db, 'query'> | PoolClient;

const policySchema = z.object({
  lowStockUnits: z.number().int().min(0),
  minShelfLifeDays: z.number().int().min(0),
  staleAfterMinutes: z.number().int().min(1),
});

export async function loadAvailabilityPolicy(db: Queryable): Promise<AvailabilityPolicy> {
  const { rows } = await db.query<{ value: unknown }>(
    "SELECT value FROM app_settings WHERE key = 'inventory.availability'",
  );
  return rows[0] ? policySchema.parse(rows[0].value) : DEFAULT_AVAILABILITY_POLICY;
}

/**
 * SQL for sellable units of product `p`: on hand minus reserved and quarantined, only from priced batches
 * with at least `min_shelf_life_days` left (in India's calendar). Parameter $N is min shelf life days.
 */
export function sellableUnitsSql(shelfLifeParam: string): string {
  return `(SELECT coalesce(sum(greatest(b.on_hand_qty - b.reserved_qty - b.quarantined_qty, 0)), 0)::int
           FROM inventory_batches b
           WHERE b.product_id = p.id AND b.rate_paise IS NOT NULL
             AND b.expiry_date > (now() AT TIME ZONE 'Asia/Kolkata')::date + ${shelfLifeParam}::int)`;
}

export interface SnapshotResult {
  applied: number;
  unknownSkus: string[];
  /** Batches where the new count is below what is already reserved for open orders. */
  oversold: { sku: string; batch: string; onHand: number; reserved: number }[];
}

/**
 * Applies a full stock snapshot from the warehouse system. Listed batches get the new on-hand
 * count; batches of listed products that are missing from the file are set to zero. Products not in
 * the file are left alone. Reservations are kept, and shortfalls are reported, never hidden.
 */
export async function applyStockSnapshot(
  client: PoolClient,
  rows: StockRow[],
  meta: { runId: string; asOf: Date; actorUserId: string },
): Promise<SnapshotResult> {
  const skus = [...new Set(rows.map((r) => r.sku))];
  const { rows: products } = await client.query<{ id: string; sku: string }>(
    'SELECT id, sku FROM products WHERE sku = ANY($1::text[])',
    [skus],
  );
  const productBySku = new Map(products.map((p) => [p.sku, p.id]));
  const unknownSkus = skus.filter((s) => !productBySku.has(s));
  const known = rows.filter((r) => productBySku.has(r.sku));
  const productIds = [...new Set(known.map((r) => productBySku.get(r.sku)!))];

  // Lock every batch of the affected products in a fixed order to avoid deadlocks with reservations.
  await client.query('SELECT id FROM inventory_batches WHERE product_id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [
    productIds,
  ]);

  for (const row of known) {
    const productId = productBySku.get(row.sku)!;
    const { rows: batch } = await client.query<{ id: string; delta: number }>(
      `WITH prev AS (SELECT on_hand_qty FROM inventory_batches WHERE product_id = $1 AND batch_number = $2)
       INSERT INTO inventory_batches
         (product_id, batch_number, expiry_date, mrp_paise, rate_paise, on_hand_qty, location, synced_at, last_sync_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (product_id, batch_number) DO UPDATE SET
         expiry_date = EXCLUDED.expiry_date, mrp_paise = coalesce(EXCLUDED.mrp_paise, inventory_batches.mrp_paise),
         rate_paise = coalesce(EXCLUDED.rate_paise, inventory_batches.rate_paise), on_hand_qty = EXCLUDED.on_hand_qty,
         location = coalesce(EXCLUDED.location, inventory_batches.location), synced_at = EXCLUDED.synced_at,
         last_sync_run_id = EXCLUDED.last_sync_run_id, updated_at = now()
       RETURNING id, on_hand_qty - coalesce((SELECT on_hand_qty FROM prev), 0) AS delta`,
      [productId, row.batch, row.expiry, row.mrpPaise, row.ratePaise, row.quantity, row.location, meta.asOf, meta.runId],
    );
    if (batch[0]!.delta !== 0) {
      await client.query(
        "INSERT INTO inventory_movements (batch_id, kind, quantity, reference, actor_user_id) VALUES ($1, 'sync', $2, $3, $4)",
        [batch[0]!.id, batch[0]!.delta, `sync:${meta.runId}`, meta.actorUserId],
      );
    }
  }

  // Batches of synced products that the snapshot no longer lists have been sold or written off.
  const zeroed = await client.query<{ id: string; delta: number }>(
    `UPDATE inventory_batches b SET on_hand_qty = 0, synced_at = $2, last_sync_run_id = $3, updated_at = now()
     FROM (SELECT id, on_hand_qty FROM inventory_batches WHERE product_id = ANY($1::uuid[])) prev
     WHERE b.id = prev.id AND b.product_id = ANY($1::uuid[]) AND b.last_sync_run_id IS DISTINCT FROM $3
     RETURNING b.id, -prev.on_hand_qty AS delta`,
    [productIds, meta.asOf, meta.runId],
  );
  for (const z of zeroed.rows.filter((r) => r.delta !== 0)) {
    await client.query(
      "INSERT INTO inventory_movements (batch_id, kind, quantity, reference, actor_user_id) VALUES ($1, 'sync', $2, $3, $4)",
      [z.id, z.delta, `sync:${meta.runId}`, meta.actorUserId],
    );
  }

  const { rows: oversold } = await client.query<SnapshotResult['oversold'][number]>(
    `SELECT p.sku, b.batch_number AS batch, b.on_hand_qty AS "onHand", b.reserved_qty AS reserved
     FROM inventory_batches b JOIN products p ON p.id = b.product_id
     WHERE b.product_id = ANY($1::uuid[]) AND b.reserved_qty > b.on_hand_qty - b.quarantined_qty
     ORDER BY p.sku, b.batch_number`,
    [productIds],
  );
  return { applied: known.length, unknownSkus, oversold };
}

export interface ReservationLine {
  batchId: string;
  batchNumber: string;
  expiryDate: string;
  quantity: number;
}

/**
 * Reserves `quantity` units of a product from the earliest-expiring sellable batches (FEFO).
 * Must run inside the caller's transaction. Row locks mean two concurrent orders can never
 * both take the last unit: the second sees the first's reservation and fails.
 */
export async function reserveStock(
  client: PoolClient,
  productId: string,
  quantity: number,
  meta: { reference: string; actorUserId: string | null; minShelfLifeDays: number; excludeBatchIds?: string[] },
): Promise<ReservationLine[]> {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new AppError('BAD_REQUEST', 'Quantity must be positive');
  const { rows: batches } = await client.query<{
    id: string;
    batch_number: string;
    expiry_date: string;
    free: number;
  }>(
    `SELECT id, batch_number, to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date,
            on_hand_qty - reserved_qty - quarantined_qty AS free
     FROM inventory_batches
     WHERE product_id = $1 AND expiry_date > (now() AT TIME ZONE 'Asia/Kolkata')::date + $2::int
       AND NOT (id = ANY($3::uuid[]))
       -- Same rule as pricing: a batch without a selling rate is not sold.
       AND rate_paise IS NOT NULL
     ORDER BY expiry_date, batch_number
     FOR UPDATE`,
    [productId, meta.minShelfLifeDays, meta.excludeBatchIds ?? []],
  );
  const available = batches.reduce((sum, b) => sum + Math.max(b.free, 0), 0);
  if (available < quantity) {
    throw new AppError('CONFLICT', 'Not enough stock', { productId, requested: quantity, available });
  }
  const lines: ReservationLine[] = [];
  let remaining = quantity;
  for (const b of batches) {
    if (remaining === 0) break;
    const take = Math.min(Math.max(b.free, 0), remaining);
    if (take === 0) continue;
    await client.query('UPDATE inventory_batches SET reserved_qty = reserved_qty + $2, updated_at = now() WHERE id = $1', [
      b.id,
      take,
    ]);
    await client.query(
      "INSERT INTO inventory_movements (batch_id, kind, quantity, reference, actor_user_id) VALUES ($1, 'reserve', $2, $3, $4)",
      [b.id, take, meta.reference, meta.actorUserId],
    );
    lines.push({ batchId: b.id, batchNumber: b.batch_number, expiryDate: b.expiry_date, quantity: take });
    remaining -= take;
  }
  return lines;
}

/** Returns reserved units to sale, e.g. when an order is cancelled. */
export async function releaseStock(
  client: PoolClient,
  lines: { batchId: string; quantity: number }[],
  meta: { reference: string; actorUserId: string | null },
): Promise<void> {
  for (const line of [...lines].sort((a, b) => a.batchId.localeCompare(b.batchId))) {
    const result = await client.query(
      `UPDATE inventory_batches SET reserved_qty = reserved_qty - $2, updated_at = now()
       WHERE id = $1 AND reserved_qty >= $2`,
      [line.batchId, line.quantity],
    );
    if (result.rowCount === 0) throw new AppError('CONFLICT', 'Release exceeds reserved quantity');
    await client.query(
      "INSERT INTO inventory_movements (batch_id, kind, quantity, reference, actor_user_id) VALUES ($1, 'release', $2, $3, $4)",
      [line.batchId, -line.quantity, meta.reference, meta.actorUserId],
    );
  }
}

/** Units reserved for an order that the picker could not find or use: no longer reserved, held off sale. */
export async function quarantineReserved(
  client: PoolClient,
  batchId: string,
  quantity: number,
  meta: { reference: string; actorUserId: string },
): Promise<void> {
  const result = await client.query(
    `UPDATE inventory_batches SET reserved_qty = reserved_qty - $2, quarantined_qty = quarantined_qty + $2, updated_at = now()
     WHERE id = $1 AND reserved_qty >= $2`,
    [batchId, quantity],
  );
  if (result.rowCount === 0) throw new AppError('CONFLICT', 'Quarantine exceeds reserved quantity');
  await client.query(
    "INSERT INTO inventory_movements (batch_id, kind, quantity, reference, actor_user_id) VALUES ($1, 'quarantine', $2, $3, $4)",
    [batchId, quantity, meta.reference, meta.actorUserId],
  );
}

/** Puts quarantined units back on sale after a stock check finds them usable. */
export async function releaseQuarantine(
  client: PoolClient,
  batchId: string,
  quantity: number,
  meta: { reference: string; actorUserId: string },
): Promise<{ before: number; after: number }> {
  const { rows } = await client.query<{ quarantined_qty: number }>(
    'SELECT quarantined_qty FROM inventory_batches WHERE id = $1 FOR UPDATE',
    [batchId],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND', 'Batch not found');
  const before = rows[0].quarantined_qty;
  if (quantity > before) throw new AppError('CONFLICT', `Only ${before} units are quarantined in this batch`);
  await client.query('UPDATE inventory_batches SET quarantined_qty = quarantined_qty - $2, updated_at = now() WHERE id = $1', [
    batchId,
    quantity,
  ]);
  await client.query(
    "INSERT INTO inventory_movements (batch_id, kind, quantity, reference, actor_user_id) VALUES ($1, 'unquarantine', $2, $3, $4)",
    [batchId, -quantity, meta.reference, meta.actorUserId],
  );
  return { before, after: before - quantity };
}

/**
 * Invoiced units leave the warehouse: they stop being reserved and stop counting as on hand.
 * On-hand never goes below zero, because a Marg snapshot taken after the invoice may already exclude them;
 * the next snapshot sets the true figure either way.
 */
export async function consumeReserved(
  client: PoolClient,
  lines: { batchId: string; quantity: number }[],
  meta: { reference: string; actorUserId: string },
): Promise<void> {
  for (const line of [...lines].sort((a, b) => a.batchId.localeCompare(b.batchId))) {
    const result = await client.query(
      `UPDATE inventory_batches
       SET reserved_qty = reserved_qty - $2, on_hand_qty = greatest(on_hand_qty - $2, 0), updated_at = now()
       WHERE id = $1 AND reserved_qty >= $2`,
      [line.batchId, line.quantity],
    );
    if (result.rowCount === 0) throw new AppError('CONFLICT', 'Invoice exceeds reserved quantity');
    await client.query(
      "INSERT INTO inventory_movements (batch_id, kind, quantity, reference, actor_user_id) VALUES ($1, 'invoice', $2, $3, $4)",
      [line.batchId, -line.quantity, meta.reference, meta.actorUserId],
    );
  }
}
