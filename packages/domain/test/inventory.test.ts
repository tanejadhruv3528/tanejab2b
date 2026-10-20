import { describe, expect, it } from 'vitest';
import { availabilityFor, isStale, parseExpiry, parseStockCsv } from '../src/inventory.js';

describe('availabilityFor', () => {
  it('maps sellable units to a status', () => {
    expect(availabilityFor('active', 0)).toBe('out_of_stock');
    expect(availabilityFor('active', -3)).toBe('out_of_stock');
    expect(availabilityFor('active', 10)).toBe('low_stock');
    expect(availabilityFor('active', 11)).toBe('in_stock');
  });

  it('lets product status win', () => {
    expect(availabilityFor('restricted', 500)).toBe('restricted');
    expect(availabilityFor('discontinued', 500)).toBe('discontinued');
  });
});

describe('isStale', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  it('treats never-synced and old data as stale', () => {
    expect(isStale(null, now)).toBe(true);
    expect(isStale(new Date('2026-10-20T07:59:00Z'), now)).toBe(true);
    expect(isStale(new Date('2026-10-20T08:01:00Z'), now)).toBe(false);
  });
});

describe('parseExpiry', () => {
  it.each([
    ['2027-03-31', '2027-03-31'],
    ['03/2027', '2027-03-31'],
    ['3/27', '2027-03-31'],
    ['02-2028', '2028-02-29'],
    ['02/2027', '2027-02-28'],
  ])('parses %s', (input, expected) => {
    expect(parseExpiry(input)).toBe(expected);
  });

  it.each(['', '2027-02-30', '13/2027', '31-03-2027', 'Mar 2027', '03/1999'])('rejects %s', (input) => {
    expect(parseExpiry(input)).toBeNull();
  });
});

describe('parseStockCsv', () => {
  it('parses valid rows', () => {
    const { rows, errors } = parseStockCsv('SKU,Batch,Expiry,Qty,MRP,Rate,Location\ntda-1,b123,06/2027,120,33.60,26.88,R1-S2');
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { line: 2, sku: 'TDA-1', batch: 'B123', expiry: '2027-06-30', quantity: 120, mrpPaise: 3360, ratePaise: 2688, location: 'R1-S2' },
    ]);
  });

  it('reports bad rows with line numbers', () => {
    const csv = 'sku,batch,expiry,qty,mrp,rate\nA,B1,2027-01-01,5,,\n,??,never,-1,abc,50\nA,B1,2027-01-01,5,,\nC,B2,2027-01-01,5,10,20';
    const { rows, errors } = parseStockCsv(csv);
    expect(rows.map((r) => r.line)).toEqual([2]);
    expect(errors.filter((e) => e.line === 3).map((e) => e.field)).toEqual(['sku', 'batch', 'expiry', 'qty', 'mrp']);
    expect(errors.find((e) => e.line === 4)?.message).toMatch(/Duplicate/);
    expect(errors.find((e) => e.line === 5)).toMatchObject({ field: 'rate', message: 'Rate cannot be above MRP' });
  });

  it('requires the core columns', () => {
    expect(parseStockCsv('sku,batch\nA,B').errors.map((e) => e.field)).toEqual(['expiry', 'qty']);
  });
});
