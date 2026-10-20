import { describe, expect, it } from 'vitest';
import { parseCatalogCsv } from '../src/catalog.js';

const HEADER = 'sku,name,generic_name,manufacturer,strength,dosage_form,pack_size,hsn_code,gst_rate,mrp,schedule,cold_chain,status,aliases';

describe('parseCatalogCsv', () => {
  it('parses a valid row', () => {
    const csv = `${HEADER}\ntdx-001,Dolo 650,Paracetamol,Micro Labs,650 mg,Tablet,15 tablets,30049099,12%,33.60,H,no,,dolo|paracetamol 650|डोलो`;
    const { rows, errors } = parseCatalogCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      {
        line: 2,
        sku: 'TDX-001',
        name: 'Dolo 650',
        genericName: 'Paracetamol',
        manufacturer: 'Micro Labs',
        strength: '650 mg',
        dosageForm: 'Tablet',
        packSize: '15 tablets',
        hsnCode: '30049099',
        gstRateBps: 1200,
        mrpPaise: 3360,
        schedule: 'H',
        coldChain: false,
        status: 'active',
        aliases: ['dolo', 'paracetamol 650', 'डोलो'],
      },
    ]);
  });

  it('needs only sku, name and manufacturer', () => {
    const { rows, errors } = parseCatalogCsv('SKU,Name,Manufacturer\nA1,Insulin Glargine,Biocon');
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ sku: 'A1', schedule: 'none', coldChain: false, mrpPaise: null, gstRateBps: null });
  });

  it('reports missing required columns', () => {
    expect(parseCatalogCsv('sku,name\nA,B').errors).toEqual([
      { line: 1, field: 'manufacturer', message: 'Missing required column "manufacturer"' },
    ]);
  });

  it('reports every bad field with its line and keeps good rows', () => {
    const csv = [
      HEADER,
      'OK1,Good Product,,Cipla,,,,,,,,,,',
      ',X,,,,,,12ab,7,abc,Z,maybe,gone,',
      'ok1,Duplicate,,Cipla,,,,,,,,,,',
    ].join('\n');
    const { rows, errors } = parseCatalogCsv(csv);
    expect(rows.map((r) => r.sku)).toEqual(['OK1']);
    expect(errors.filter((e) => e.line === 3).map((e) => e.field)).toEqual([
      'sku',
      'name',
      'manufacturer',
      'hsn_code',
      'gst_rate',
      'mrp',
      'schedule',
      'cold_chain',
      'status',
    ]);
    expect(errors.find((e) => e.line === 4)).toMatchObject({ field: 'sku', message: 'Duplicate SKU (also on line 2)' });
  });

  it('accepts "Schedule H1" style values and yes/no cold chain', () => {
    const { rows } = parseCatalogCsv('sku,name,manufacturer,schedule,cold_chain\nB1,Alprazolam,Sun,Schedule H1,yes');
    expect(rows[0]).toMatchObject({ schedule: 'H1', coldChain: true });
  });
});
