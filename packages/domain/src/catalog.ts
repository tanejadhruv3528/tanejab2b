import { parseCsvRecords } from './csv.js';
import { rupeesToPaise, type Paise } from './money.js';

export type DrugSchedule = 'none' | 'G' | 'H' | 'H1' | 'X';
export type ProductStatus = 'active' | 'restricted' | 'discontinued';

export interface CatalogRow {
  sku: string;
  name: string;
  genericName: string | null;
  manufacturer: string;
  strength: string | null;
  dosageForm: string | null;
  packSize: string | null;
  hsnCode: string | null;
  gstRateBps: number | null;
  mrpPaise: Paise | null;
  schedule: DrugSchedule;
  coldChain: boolean;
  status: ProductStatus;
  aliases: string[];
}

export interface RowError {
  line: number;
  field: string;
  message: string;
}

export const CATALOG_REQUIRED_COLUMNS = ['sku', 'name', 'manufacturer'] as const;
export const CATALOG_OPTIONAL_COLUMNS = [
  'generic_name',
  'strength',
  'dosage_form',
  'pack_size',
  'hsn_code',
  'gst_rate',
  'mrp',
  'schedule',
  'cold_chain',
  'status',
  'aliases',
] as const;

const GST_RATES = new Set([0, 5, 12, 18, 28]);
const SCHEDULES: Record<string, DrugSchedule> = { '': 'none', none: 'none', g: 'G', h: 'H', h1: 'H1', x: 'X' };
const YES = new Set(['y', 'yes', 'true', '1']);
const NO = new Set(['', 'n', 'no', 'false', '0']);

/**
 * Validates a catalogue CSV. Line numbers are 1-based file lines (header is line 1).
 * Valid rows are returned even when other rows fail, so a dry run can show everything at once.
 */
export function parseCatalogCsv(text: string): { rows: (CatalogRow & { line: number })[]; errors: RowError[] } {
  const { headers, records } = parseCsvRecords(text);
  const errors: RowError[] = [];
  const missing = CATALOG_REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
  if (missing.length > 0) {
    return { rows: [], errors: missing.map((c) => ({ line: 1, field: c, message: `Missing required column "${c}"` })) };
  }

  const rows: (CatalogRow & { line: number })[] = [];
  const seen = new Map<string, number>();
  records.forEach((r, index) => {
    const line = index + 2;
    const rowErrors: RowError[] = [];
    const fail = (field: string, message: string) => rowErrors.push({ line, field, message });

    const sku = (r.sku ?? '').toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._/-]{0,49}$/.test(sku)) fail('sku', 'SKU must be 1-50 letters, digits or . _ / -');
    else if (seen.has(sku)) fail('sku', `Duplicate SKU (also on line ${seen.get(sku)})`);
    else seen.set(sku, line);

    const name = r.name ?? '';
    if (name.length < 2 || name.length > 200) fail('name', 'Name must be 2-200 characters');
    const manufacturer = r.manufacturer ?? '';
    if (manufacturer.length < 2 || manufacturer.length > 200) fail('manufacturer', 'Manufacturer is required');

    const hsn = r.hsn_code || null;
    if (hsn && !/^\d{4,8}$/.test(hsn)) fail('hsn_code', 'HSN code must be 4-8 digits');

    let gstRateBps: number | null = null;
    if (r.gst_rate) {
      const rate = Number(r.gst_rate.replace('%', ''));
      if (!GST_RATES.has(rate)) fail('gst_rate', 'GST rate must be one of 0, 5, 12, 18, 28');
      else gstRateBps = rate * 100;
    }

    let mrpPaise: Paise | null = null;
    if (r.mrp) {
      try {
        mrpPaise = rupeesToPaise(r.mrp);
        if (mrpPaise <= 0) fail('mrp', 'MRP must be positive');
      } catch {
        fail('mrp', 'MRP must be a rupee amount like 125.50');
      }
    }

    const schedule = SCHEDULES[(r.schedule ?? '').toLowerCase().replace(/^schedule\s*/, '')];
    if (!schedule) fail('schedule', 'Schedule must be blank, G, H, H1 or X');

    const coldRaw = (r.cold_chain ?? '').toLowerCase();
    if (!YES.has(coldRaw) && !NO.has(coldRaw)) fail('cold_chain', 'cold_chain must be yes or no');

    const statusRaw = (r.status || 'active').toLowerCase();
    if (!['active', 'restricted', 'discontinued'].includes(statusRaw)) {
      fail('status', 'Status must be active, restricted or discontinued');
    }

    const aliases = [...new Set((r.aliases ?? '').split('|').map((a) => a.trim()).filter(Boolean))];
    if (aliases.some((a) => a.length > 200)) fail('aliases', 'Each alias must be at most 200 characters');

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      return;
    }
    rows.push({
      line,
      sku,
      name,
      genericName: r.generic_name || null,
      manufacturer,
      strength: r.strength || null,
      dosageForm: r.dosage_form || null,
      packSize: r.pack_size || null,
      hsnCode: hsn,
      gstRateBps,
      mrpPaise,
      schedule: schedule!,
      coldChain: YES.has(coldRaw),
      status: statusRaw as ProductStatus,
      aliases,
    });
  });
  return { rows, errors };
}
