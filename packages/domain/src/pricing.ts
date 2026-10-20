import { applyBasisPoints, paise, ZERO, type Paise } from './money.js';

export interface SellableBatch {
  batchId: string;
  expiryDate: string;
  /** Units free to sell (on hand minus reserved and quarantined). */
  free: number;
  /** Taneja's selling rate per unit, or null if the batch has no rate. */
  ratePaise: Paise | null;
}

export interface Allocation {
  batchId: string;
  quantity: number;
  ratePaise: Paise;
}

/**
 * Splits a quantity across batches earliest-expiry first, the same order the warehouse reserves in,
 * so a quote prices exactly what the order will take. Batches without a rate are skipped.
 */
export function allocateFefo(batches: SellableBatch[], quantity: number): { allocations: Allocation[]; shortBy: number } {
  const sorted = [...batches].sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || a.batchId.localeCompare(b.batchId));
  const allocations: Allocation[] = [];
  let remaining = quantity;
  for (const b of sorted) {
    if (remaining <= 0) break;
    if (b.ratePaise === null || b.free <= 0) continue;
    const take = Math.min(b.free, remaining);
    allocations.push({ batchId: b.batchId, quantity: take, ratePaise: b.ratePaise });
    remaining -= take;
  }
  return { allocations, shortBy: Math.max(remaining, 0) };
}

export interface DiscountSlab {
  /** Order subtotal (before tax and delivery) at or above which this slab applies. */
  minSubtotalPaise: Paise;
  discountBps: number;
}

/** Picks the highest slab the subtotal reaches. Slabs only apply when discounts are switched on. */
export function slabDiscountBps(subtotal: Paise, slabs: DiscountSlab[]): number {
  let best: DiscountSlab | null = null;
  for (const slab of slabs) {
    if (subtotal >= slab.minSubtotalPaise && (!best || slab.minSubtotalPaise > best.minSubtotalPaise)) best = slab;
  }
  return best?.discountBps ?? 0;
}

/**
 * Spreads an order-level discount across lines in proportion to their value, using the largest
 * remainder so the parts add up exactly to the total. GST is then charged on each discounted line.
 */
export function allocateDiscount(lineValues: Paise[], discount: Paise): Paise[] {
  const total = lineValues.reduce((s, v) => s + v, 0);
  if (discount <= 0 || total <= 0) return lineValues.map(() => ZERO);
  if (discount > total) throw new RangeError('Discount cannot exceed the order value');
  const raw = lineValues.map((v) => (v * discount) / total);
  const floors = raw.map(Math.floor);
  let left = discount - floors.reduce((s, v) => s + v, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left === 0) break;
    floors[i]! += 1;
    left -= 1;
  }
  return floors.map(paise);
}

export interface PricedLineInput {
  productId: string;
  quantity: number;
  allocations: Allocation[];
  gstRateBps: number;
}

export interface PricedLine {
  productId: string;
  quantity: number;
  /** Sum of quantity x rate over the allocated batches. */
  valuePaise: Paise;
  discountPaise: Paise;
  taxablePaise: Paise;
  gstRateBps: number;
  taxPaise: Paise;
  totalPaise: Paise;
}

export interface PricingResult {
  lines: PricedLine[];
  subtotalPaise: Paise;
  discountBps: number;
  discountPaise: Paise;
  taxPaise: Paise;
}

/**
 * Prices order lines. Rates are treated as exclusive of GST (open decision: confirm with the owner and
 * Marg's rate convention). Tax is rounded half-up per line.
 */
export function priceLines(
  inputs: PricedLineInput[],
  discounts: { enabled: boolean; slabs: DiscountSlab[] },
): PricingResult {
  const values = inputs.map((l) => paise(l.allocations.reduce((s, a) => s + a.ratePaise * a.quantity, 0)));
  const subtotal = paise(values.reduce((s, v) => s + v, 0));
  const discountBps = discounts.enabled ? slabDiscountBps(subtotal, discounts.slabs) : 0;
  const discountTotal = applyBasisPoints(subtotal, discountBps);
  const lineDiscounts = allocateDiscount(values, discountTotal);
  const lines = inputs.map((input, i) => {
    const taxable = paise(values[i]! - lineDiscounts[i]!);
    const tax = applyBasisPoints(taxable, input.gstRateBps);
    return {
      productId: input.productId,
      quantity: input.quantity,
      valuePaise: values[i]!,
      discountPaise: lineDiscounts[i]!,
      taxablePaise: taxable,
      gstRateBps: input.gstRateBps,
      taxPaise: tax,
      totalPaise: paise(taxable + tax),
    };
  });
  return {
    lines,
    subtotalPaise: subtotal,
    discountBps,
    discountPaise: discountTotal,
    taxPaise: paise(lines.reduce((s, l) => s + l.taxPaise, 0)),
  };
}
