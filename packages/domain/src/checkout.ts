import { add, paise, subtract, type Paise } from './money.js';

/**
 * Checkout policy. All values are configurable proposals from the owner and must be
 * loaded from settings, not hard-coded at call sites. See docs/spec/ROADMAP_OPEN_DECISIONS.md.
 */
export interface CheckoutPolicy {
  minimumOrderPaise: Paise;
  /** Which amount the minimum-order check applies to. Unconfirmed by owner; defaults to subtotal. */
  minimumOrderBasis: 'subtotal' | 'payable';
  deliveryFeePaise: Paise;
  codLimitPaise: Paise;
  /** Whether an amount exactly equal to the COD limit is allowed. Open decision #4. */
  codLimitInclusive: boolean;
  /** Which amount the COD limit applies to. PRD default is final payable. Open decision #4. */
  codLimitBasis: 'payable' | 'subtotal';
}

export type RetailerStatus =
  | 'draft'
  | 'submitted'
  | 'under_review'
  | 'needs_resubmission'
  | 'approved'
  | 'rejected'
  | 'suspended';

export interface RetailerContext {
  status: RetailerStatus;
  storeVerified: boolean;
  inCodServiceZone: boolean;
  codAllowedByAdmin: boolean;
}

export interface CartAmounts {
  subtotalPaise: Paise;
  /** Total discount and scheme benefit. Discounts are not active until the owner confirms rates. */
  discountPaise: Paise;
  taxPaise: Paise;
}

export type OrderBlocker = 'RETAILER_NOT_APPROVED' | 'STORE_NOT_VERIFIED' | 'BELOW_MINIMUM_ORDER' | 'EMPTY_CART';

export type CodBlocker =
  | 'ORDER_NOT_ALLOWED'
  | 'COD_ABOVE_LIMIT'
  | 'COD_OUTSIDE_SERVICE_ZONE'
  | 'COD_DISABLED_BY_ADMIN';

export type PaymentMethod = 'prepaid' | 'cod';

export interface CheckoutEvaluation {
  subtotalPaise: Paise;
  discountPaise: Paise;
  taxPaise: Paise;
  deliveryFeePaise: Paise;
  payablePaise: Paise;
  canOrder: boolean;
  orderBlockers: OrderBlocker[];
  codEligible: boolean;
  codBlockers: CodBlocker[];
  /** There is no credit option in the MVP. */
  paymentMethods: PaymentMethod[];
}

export const DEFAULT_CHECKOUT_POLICY: CheckoutPolicy = {
  minimumOrderPaise: paise(3_000_00),
  minimumOrderBasis: 'subtotal',
  deliveryFeePaise: paise(50_00),
  codLimitPaise: paise(10_000_00),
  codLimitInclusive: true,
  codLimitBasis: 'payable',
};

export function evaluateCheckout(
  cart: CartAmounts,
  retailer: RetailerContext,
  policy: CheckoutPolicy = DEFAULT_CHECKOUT_POLICY,
): CheckoutEvaluation {
  if (cart.subtotalPaise < 0 || cart.discountPaise < 0 || cart.taxPaise < 0) {
    throw new RangeError('Cart amounts must not be negative');
  }
  if (cart.discountPaise > cart.subtotalPaise) {
    throw new RangeError('Discount cannot exceed subtotal');
  }

  const deliveryFeePaise = policy.deliveryFeePaise;
  const payablePaise = add(subtract(cart.subtotalPaise, cart.discountPaise), cart.taxPaise, deliveryFeePaise);

  const orderBlockers: OrderBlocker[] = [];
  if (retailer.status !== 'approved') orderBlockers.push('RETAILER_NOT_APPROVED');
  if (!retailer.storeVerified) orderBlockers.push('STORE_NOT_VERIFIED');
  if (cart.subtotalPaise === 0) {
    orderBlockers.push('EMPTY_CART');
  } else {
    const minimumBase = policy.minimumOrderBasis === 'payable' ? payablePaise : cart.subtotalPaise;
    if (minimumBase < policy.minimumOrderPaise) orderBlockers.push('BELOW_MINIMUM_ORDER');
  }
  const canOrder = orderBlockers.length === 0;

  const codBlockers: CodBlocker[] = [];
  if (!canOrder) codBlockers.push('ORDER_NOT_ALLOWED');
  const codBase = policy.codLimitBasis === 'payable' ? payablePaise : cart.subtotalPaise;
  const overLimit = policy.codLimitInclusive ? codBase > policy.codLimitPaise : codBase >= policy.codLimitPaise;
  if (overLimit) codBlockers.push('COD_ABOVE_LIMIT');
  if (!retailer.inCodServiceZone) codBlockers.push('COD_OUTSIDE_SERVICE_ZONE');
  if (!retailer.codAllowedByAdmin) codBlockers.push('COD_DISABLED_BY_ADMIN');
  const codEligible = codBlockers.length === 0;

  const paymentMethods: PaymentMethod[] = canOrder ? (codEligible ? ['prepaid', 'cod'] : ['prepaid']) : [];

  return {
    subtotalPaise: cart.subtotalPaise,
    discountPaise: cart.discountPaise,
    taxPaise: cart.taxPaise,
    deliveryFeePaise,
    payablePaise,
    canOrder,
    orderBlockers,
    codEligible,
    codBlockers,
    paymentMethods,
  };
}
