import { describe, expect, it } from 'vitest';
import { paise } from '../src/money.js';
import { allocateDiscount, allocateFefo, priceLines, slabDiscountBps, type DiscountSlab } from '../src/pricing.js';

const p = paise;

describe('allocateFefo', () => {
  const batches = [
    { batchId: 'late', expiryDate: '2028-01-31', free: 50, ratePaise: p(2700) },
    { batchId: 'early', expiryDate: '2027-01-31', free: 10, ratePaise: p(2600) },
    { batchId: 'norate', expiryDate: '2026-12-31', free: 99, ratePaise: null },
    { batchId: 'empty', expiryDate: '2026-11-30', free: 0, ratePaise: p(2500) },
  ];

  it('takes earliest-expiring priced stock first', () => {
    expect(allocateFefo(batches, 15)).toEqual({
      allocations: [
        { batchId: 'early', quantity: 10, ratePaise: 2600 },
        { batchId: 'late', quantity: 5, ratePaise: 2700 },
      ],
      shortBy: 0,
    });
  });

  it('reports a shortfall', () => {
    expect(allocateFefo(batches, 70).shortBy).toBe(10);
  });
});

describe('discount slabs', () => {
  // Placeholder slabs for tests only. Real rates are unconfirmed (3/5/7% vs 23/25/27%).
  const slabs: DiscountSlab[] = [
    { minSubtotalPaise: p(0), discountBps: 300 },
    { minSubtotalPaise: p(4_000_00), discountBps: 500 },
    { minSubtotalPaise: p(15_000_00), discountBps: 700 },
  ];

  it('picks the highest slab reached, at and around each boundary', () => {
    expect(slabDiscountBps(p(3_999_99), slabs)).toBe(300);
    expect(slabDiscountBps(p(4_000_00), slabs)).toBe(500);
    expect(slabDiscountBps(p(14_999_99), slabs)).toBe(500);
    expect(slabDiscountBps(p(15_000_00), slabs)).toBe(700);
    expect(slabDiscountBps(p(100), [])).toBe(0);
  });

  it('spreads a discount so parts add up exactly', () => {
    const parts = allocateDiscount([p(333), p(333), p(334)], p(100));
    expect(parts.reduce((s, v) => s + v, 0)).toBe(100);
    expect(parts).toEqual([33, 33, 34]);
    expect(allocateDiscount([p(1000)], p(0))).toEqual([0]);
    expect(() => allocateDiscount([p(10)], p(11))).toThrow(RangeError);
  });

  it('applies no discount while discounts are switched off', () => {
    const result = priceLines(
      [{ productId: 'a', quantity: 2, allocations: [{ batchId: 'b', quantity: 2, ratePaise: p(5_000_00) }], gstRateBps: 1200 }],
      { enabled: false, slabs },
    );
    expect(result).toMatchObject({ subtotalPaise: 10_000_00, discountBps: 0, discountPaise: 0, taxPaise: 1_200_00 });
  });
});

describe('priceLines', () => {
  it('charges GST per line on the discounted value', () => {
    const result = priceLines(
      [
        { productId: 'a', quantity: 3, allocations: [{ batchId: 'x', quantity: 3, ratePaise: p(2688) }], gstRateBps: 1200 },
        {
          productId: 'b',
          quantity: 10,
          allocations: [
            { batchId: 'y1', quantity: 4, ratePaise: p(19000) },
            { batchId: 'y2', quantity: 6, ratePaise: p(19500) },
          ],
          gstRateBps: 500,
        },
      ],
      { enabled: true, slabs: [{ minSubtotalPaise: p(0), discountBps: 500 }] },
    );
    // a: 3 x 26.88 = 80.64; b: 4 x 190 + 6 x 195 = 1930.00; subtotal 2010.64
    expect(result.subtotalPaise).toBe(201064);
    expect(result.discountPaise).toBe(10053); // 5% of 2010.64 = 100.532 -> 100.53
    const [a, b] = result.lines;
    expect(a!.discountPaise + b!.discountPaise).toBe(10053);
    expect(a!.taxPaise).toBe(Math.floor(((8064 - a!.discountPaise) * 1200 + 5000) / 10000));
    expect(b!.totalPaise).toBe(b!.taxablePaise + b!.taxPaise);
    expect(result.taxPaise).toBe(a!.taxPaise + b!.taxPaise);
  });
});
