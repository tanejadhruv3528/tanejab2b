import { availabilityFor, isStale, type Availability, type AvailabilityPolicy, type CatalogRow } from '@taneja/domain';
import type { PoolClient } from 'pg';
import type { Db } from './db.js';
import { sellableUnitsSql } from './inventory.js';

type Queryable = Pick<Db, 'query'> | PoolClient;

export interface ProductView {
  id: string;
  sku: string;
  name: string;
  genericName: string | null;
  manufacturer: string;
  strength: string | null;
  dosageForm: string | null;
  packSize: string | null;
  mrpPaise: number | null;
  gstRateBps: number | null;
  hsnCode: string | null;
  schedule: string;
  coldChain: boolean;
  status: string;
  aliases: string[];
  availability: Availability;
  /** When the warehouse stock for this product was last synced; null if never. */
  stockSyncedAt: string | null;
  /** True when stock data is older than the configured limit: treat availability as uncertain. */
  stockStale: boolean;
  /** Exact sellable units, shown to staff only. */
  sellableUnits?: number;
}

interface ProductRow extends Omit<ProductView, 'availability' | 'stockStale' | 'sellableUnits' | 'stockSyncedAt'> {
  sellableUnits: number;
  stockSyncedAt: Date | null;
}

export interface ViewOptions {
  policy: AvailabilityPolicy;
  /** Staff see exact quantities; retailers see only the availability status. */
  includeQuantities: boolean;
}

function toView(row: ProductRow, opts: ViewOptions): ProductView {
  const { sellableUnits, stockSyncedAt, ...rest } = row;
  const view: ProductView = {
    ...rest,
    availability: availabilityFor(row.status as 'active' | 'restricted' | 'discontinued', sellableUnits, opts.policy),
    stockSyncedAt: stockSyncedAt ? stockSyncedAt.toISOString() : null,
    stockStale: isStale(stockSyncedAt, new Date(), opts.policy),
  };
  if (opts.includeQuantities) view.sellableUnits = sellableUnits;
  return view;
}

/**
 * Retailer-facing product columns. Supplier and cost data must never be added here; the
 * catalogue tables do not hold any, and procurement tables are never joined into this view.
 */
const productSelect = (shelfLifeParam: string) => `
  SELECT p.id, p.sku, p.name, p.generic_name AS "genericName", m.name AS manufacturer, p.strength,
         p.dosage_form AS "dosageForm", p.pack_size AS "packSize", p.mrp_paise::int AS "mrpPaise",
         p.gst_rate_bps AS "gstRateBps", p.hsn_code AS "hsnCode", p.schedule, p.cold_chain AS "coldChain", p.status,
         coalesce((SELECT array_agg(a.alias ORDER BY a.alias) FROM product_aliases a WHERE a.product_id = p.id), '{}') AS aliases,
         ${sellableUnitsSql(shelfLifeParam)} AS "sellableUnits",
         (SELECT max(b.synced_at) FROM inventory_batches b WHERE b.product_id = p.id) AS "stockSyncedAt"
  FROM products p JOIN manufacturers m ON m.id = p.manufacturer_id`;

function searchText(row: CatalogRow): string {
  return [row.name, row.genericName, row.manufacturer, row.strength, row.dosageForm, row.sku, ...row.aliases]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

async function manufacturerId(client: PoolClient, name: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO manufacturers (name) VALUES ($1)
     ON CONFLICT (lower(name)) DO UPDATE SET name = manufacturers.name
     RETURNING id`,
    [name],
  );
  return rows[0]!.id;
}

/** Inserts or updates products by SKU and replaces their aliases. Returns how many were created and updated. */
export async function upsertProducts(
  client: PoolClient,
  rows: CatalogRow[],
  source: string,
  runId: string,
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const row of rows) {
    const mId = await manufacturerId(client, row.manufacturer);
    const { rows: result } = await client.query<{ id: string; inserted: boolean }>(
      `INSERT INTO products
         (sku, name, generic_name, manufacturer_id, strength, dosage_form, pack_size, hsn_code, gst_rate_bps,
          mrp_paise, schedule, cold_chain, status, source, last_import_run_id, search_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (sku) DO UPDATE SET
         name = EXCLUDED.name, generic_name = EXCLUDED.generic_name, manufacturer_id = EXCLUDED.manufacturer_id,
         strength = EXCLUDED.strength, dosage_form = EXCLUDED.dosage_form, pack_size = EXCLUDED.pack_size,
         hsn_code = EXCLUDED.hsn_code, gst_rate_bps = EXCLUDED.gst_rate_bps, mrp_paise = EXCLUDED.mrp_paise,
         schedule = EXCLUDED.schedule, cold_chain = EXCLUDED.cold_chain, status = EXCLUDED.status,
         source = EXCLUDED.source, last_import_run_id = EXCLUDED.last_import_run_id,
         search_text = EXCLUDED.search_text, updated_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [
        row.sku,
        row.name,
        row.genericName,
        mId,
        row.strength,
        row.dosageForm,
        row.packSize,
        row.hsnCode,
        row.gstRateBps,
        row.mrpPaise,
        row.schedule,
        row.coldChain,
        row.status,
        source,
        runId,
        searchText(row),
      ],
    );
    const product = result[0]!;
    if (product.inserted) created += 1;
    else updated += 1;
    await client.query('DELETE FROM product_aliases WHERE product_id = $1', [product.id]);
    if (row.aliases.length > 0) {
      await client.query(
        'INSERT INTO product_aliases (product_id, alias) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING',
        [product.id, row.aliases],
      );
    }
  }
  return { created, updated };
}

export interface SearchOptions {
  query: string;
  limit: number;
  offset: number;
  /** Retailers never see discontinued products. */
  includeDiscontinued: boolean;
}

/**
 * Ranked search over name, generic/salt, manufacturer, strength, form, SKU and aliases.
 * Exact SKU beats name prefix, which beats alias prefix, which beats fuzzy (typo-tolerant) matches.
 */
export async function searchProducts(db: Queryable, opts: SearchOptions & ViewOptions): Promise<ProductView[]> {
  const q = opts.query.trim().toLowerCase();
  const { rows } = await db.query<ProductRow>(
    `WITH scored AS (
       SELECT p.id,
         CASE
           WHEN lower(p.sku) = $1 THEN 100
           WHEN lower(p.name) LIKE $2 THEN 80
           WHEN EXISTS (SELECT 1 FROM product_aliases a WHERE a.product_id = p.id AND lower(a.alias) LIKE $2) THEN 70
           WHEN lower(coalesce(p.generic_name, '')) LIKE $2 THEN 60
           WHEN p.search_text LIKE $3 THEN 50
           ELSE 0
         END + 40 * greatest(similarity(lower(p.name), $1), word_similarity($1, p.search_text)) AS score
       FROM products p
       WHERE ($4 OR p.status <> 'discontinued')
         AND (p.search_text LIKE $3 OR $1 <% p.search_text OR lower(p.name) % $1)
     )
     ${productSelect('$7')}
     JOIN scored s ON s.id = p.id
     ORDER BY s.score DESC, p.name ASC
     LIMIT $5 OFFSET $6`,
    [
      q,
      `${escapeLike(q)}%`,
      `%${escapeLike(q)}%`,
      opts.includeDiscontinued,
      opts.limit,
      opts.offset,
      opts.policy.minShelfLifeDays,
    ],
  );
  return rows.map((row) => toView(row, opts));
}

export async function getProduct(db: Queryable, id: string, opts: ViewOptions): Promise<ProductView | null> {
  const { rows } = await db.query<ProductRow>(`${productSelect('$2')} WHERE p.id = $1`, [id, opts.policy.minShelfLifeDays]);
  return rows[0] ? toView(rows[0], opts) : null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
