import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHECKOUT_POLICY,
  evaluateCheckout,
  type CartAmounts,
  type CheckoutPolicy,
  type RetailerContext,
} from '../src/checkout.js';
import { paise, rupees } from '../src/money.js';

const approved: RetailerContext = {
  status: 'approved',
  storeVerified: true,
  inCodServiceZone: true,
  codAllowedByAdmin: true,
};

function cart(subtotalRupees: number, extra: Partial<CartAmounts> = {}): CartAmounts {
  return { subtotalPaise: rupees(subtotalRupees), discountPaise: paise(0), taxPaise: paise(0), ...extra };
}

describe('order eligibility', () => {
  it('adds the ₹50 delivery fee to the payable amount', () => {
    const result = evaluateCheckout(cart(5000), approved);
    expect(result.deliveryFeePaise).toBe(rupees(50));
    expect(result.payablePaise).toBe(rupees(5050));
    expect(result.canOrder).toBe(true);
  });

  it('enforces the ₹3,000 minimum at the boundary', () => {
    expect(evaluateCheckout(cart(2999.99), approved).orderBlockers).toContain('BELOW_MINIMUM_ORDER');
    expect(evaluateCheckout(cart(3000), approved).canOrder).toBe(true);
  });

  it.each(['draft', 'submitted', 'under_review', 'needs_resubmission', 'rejected', 'suspended'] as const)(
    'blocks a %s retailer',
    (status) => {
      const result = evaluateCheckout(cart(5000), { ...approved, status });
      expect(result.canOrder).toBe(false);
      expect(result.orderBlockers).toContain('RETAILER_NOT_APPROVED');
      expect(result.paymentMethods).toEqual([]);
    },
  );

  it('blocks an unverified store', () => {
    const result = evaluateCheckout(cart(5000), { ...approved, storeVerified: false });
    expect(result.orderBlockers).toEqual(['STORE_NOT_VERIFIED']);
  });

  it('blocks an empty cart', () => {
    expect(evaluateCheckout(cart(0), approved).orderBlockers).toEqual(['EMPTY_CART']);
  });

  it('never offers credit', () => {
    expect(evaluateCheckout(cart(5000), approved).paymentMethods).toEqual(['prepaid', 'cod']);
  });

  it('rejects a discount larger than the subtotal', () => {
    expect(() => evaluateCheckout(cart(100, { discountPaise: rupees(200) }), approved)).toThrow(RangeError);
  });
});

describe('COD eligibility', () => {
  it('allows COD at exactly ₹10,000 payable by default and blocks one paisa more', () => {
    // ₹9,950 subtotal + ₹50 delivery = ₹10,000 payable
    expect(evaluateCheckout(cart(9950), approved).codEligible).toBe(true);
    const over = evaluateCheckout(cart(9950.01), approved);
    expect(over.codEligible).toBe(false);
    expect(over.codBlockers).toEqual(['COD_ABOVE_LIMIT']);
    expect(over.paymentMethods).toEqual(['prepaid']);
  });

  it('can treat exactly ₹10,000 as blocked if the owner decides so', () => {
    const policy: CheckoutPolicy = { ...DEFAULT_CHECKOUT_POLICY, codLimitInclusive: false };
    expect(evaluateCheckout(cart(9950), approved, policy).codBlockers).toEqual(['COD_ABOVE_LIMIT']);
  });

  it('can apply the limit to subtotal instead of payable', () => {
    const policy: CheckoutPolicy = { ...DEFAULT_CHECKOUT_POLICY, codLimitBasis: 'subtotal' };
    expect(evaluateCheckout(cart(10000), approved, policy).codEligible).toBe(true);
    expect(evaluateCheckout(cart(10000.01), approved, policy).codEligible).toBe(false);
  });

  it('counts tax toward the payable limit', () => {
    const result = evaluateCheckout(cart(9000, { taxPaise: rupees(1000) }), approved);
    expect(result.payablePaise).toBe(rupees(10050));
    expect(result.codBlockers).toContain('COD_ABOVE_LIMIT');
  });

  it('respects service zone and admin restrictions', () => {
    expect(evaluateCheckout(cart(5000), { ...approved, inCodServiceZone: false }).codBlockers).toEqual([
      'COD_OUTSIDE_SERVICE_ZONE',
    ]);
    expect(evaluateCheckout(cart(5000), { ...approved, codAllowedByAdmin: false }).codBlockers).toEqual([
      'COD_DISABLED_BY_ADMIN',
    ]);
  });

  it('is never eligible when the order itself is blocked', () => {
    expect(evaluateCheckout(cart(1000), approved).codBlockers).toContain('ORDER_NOT_ALLOWED');
  });
});
