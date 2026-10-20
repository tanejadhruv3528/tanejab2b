import { parseCsvRecords } from './csv.js';
import { rupeesToPaise, type Paise } from './money.js';

export type Availability = 'in_stock' | 'low_stock' | 'out_of_stock' | 'restricted' | 'discontinued';

export interface AvailabilityPolicy {
  /** Sellable units at or below this count show as low stock. */
  lowStockUnits: number;
  /** Batches expiring within this many days are not sellable. */
  minShelfLifeDays: number;
  /** Stock data older than this is flagged stale. */
  staleAfterMinutes: number;
}

export const DEFAULT_AVAILABILITY_POLICY: AvailabilityPolicy = {
  lowStockUnits: 10,
  minShelfLifeDays: 30,
  staleAfterMinutes: 240,
};

export function availabilityFor(
  productStatus: 'active' | 'restricted' | 'discontinued',
  sellableUnits: number,
  policy: AvailabilityPolicy = DEFAULT_AVAILABILITY_POLICY,
): Availability {
  if (productStatus !== 'active') return productStatus;
  if (sellableUnits <= 0) return 'out_of_stock';
  if (sellableUnits <= policy.lowStockUnits) return 'low_stock';
  return 'in_stock';
}

export function isStale(syncedAt: Date | null, now: Date, policy: AvailabilityPolicy = DEFAULT_AVAILABILITY_POLICY) {
  return syncedAt === null || now.getTime() - syncedAt.getTime() > policy.staleAfterMinutes * 60_000;
}

/**
 * Parses expiry dates in the forms distributors commonly use: 2027-03-31, 03/2027, 03/27, 3-2027.
 * Month-only dates mean the last day of that month. Returns YYYY-MM-DD or null.
 */
export function parseExpiry(input: string): string | null {
  const value = input.trim();
  let year: number;
  let month: number;
  let day: number | null = null;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) {
    [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else if ((m = /^(\d{1,2})[/-](\d{4}|\d{2})$/.exec(value))) {
    month = Number(m[1]);
    year = m[2]!.length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  } else {
    return null;
  }
  if (month < 1 || month > 12 || year < 2000 || year > 2099) return null;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day === null) day = lastDay;
  if (day < 1 || day > lastDay) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface StockRow {
  line: number;
  sku: string;
  batch: string;
  expiry: string;
  mrpPaise: Paise | null;
  ratePaise: Paise | null;
  quantity: number;
  location: string | null;
}

export interface StockRowError {
  line: number;
  field: string;
  message: string;
}

/**
 * Validates a stock snapshot CSV: sku, batch, expiry, qty required; mrp, rate, location optional.
 * The exact Marg export layout is not confirmed yet; map its columns to these names until it is.
 */
export function parseStockCsv(text: string): { rows: StockRow[]; errors: StockRowError[] } {
  const { headers, records } = parseCsvRecords(text);
  const required = ['sku', 'batch', 'expiry', 'qty'];
  const missing = required.filter((c) => !headers.includes(c));
  if (missing.length > 0) {
    return { rows: [], errors: missing.map((c) => ({ line: 1, field: c, message: `Missing required column "${c}"` })) };
  }
  const rows: StockRow[] = [];
  const errors: StockRowError[] = [];
  const seen = new Map<string, number>();
  records.forEach((r, index) => {
    const line = index + 2;
    const rowErrors: StockRowError[] = [];
    const fail = (field: string, message: string) => rowErrors.push({ line, field, message });

    const sku = (r.sku ?? '').toUpperCase();
    if (!sku) fail('sku', 'SKU is required');
    const batch = (r.batch ?? '').toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9./-]{0,39}$/.test(batch)) fail('batch', 'Batch must be 1-40 letters, digits or . / -');
    const key = `${sku}|${batch}`;
    if (sku && batch && seen.has(key)) fail('batch', `Duplicate SKU and batch (also on line ${seen.get(key)})`);
    else seen.set(key, line);

    const expiry = parseExpiry(r.expiry ?? '');
    if (!expiry) fail('expiry', 'Expiry must be like 2027-03-31 or 03/2027');

    const quantity = Number(r.qty);
    if (!/^\d+$/.test(r.qty ?? '') || !Number.isSafeInteger(quantity)) fail('qty', 'Quantity must be a whole number');

    const money = (field: 'mrp' | 'rate'): Paise | null => {
      if (!r[field]) return null;
      try {
        const value = rupeesToPaise(r[field]!);
        if (value <= 0) fail(field, `${field.toUpperCase()} must be positive`);
        return value;
      } catch {
        fail(field, `${field.toUpperCase()} must be a rupee amount like 125.50`);
        return null;
      }
    };
    const mrpPaise = money('mrp');
    const ratePaise = money('rate');
    if (mrpPaise && ratePaise && ratePaise > mrpPaise) fail('rate', 'Rate cannot be above MRP');

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      return;
    }
    rows.push({ line, sku, batch, expiry: expiry!, mrpPaise, ratePaise, quantity, location: r.location || null });
  });
  return { rows, errors };
}
