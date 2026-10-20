/**
 * Money is always held as an integer number of paise (1 rupee = 100 paise).
 * Never use floating-point rupees for arithmetic.
 */
export type Paise = number & { readonly __brand: 'Paise' };

export class MoneyError extends Error {
  override name = 'MoneyError';
}

export function paise(value: number): Paise {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`Paise must be a safe integer, got ${value}`);
  }
  return value as Paise;
}

export const ZERO = paise(0);

/** Parses a rupee amount such as "1234", "1234.5" or "1,234.50" into paise without float maths. */
export function rupeesToPaise(input: string | number): Paise {
  const text = typeof input === 'number' ? String(input) : input.trim().replace(/,/g, '');
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new MoneyError(`Invalid rupee amount: "${String(input)}"`);
  }
  const [, sign, whole, fraction = ''] = match;
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return paise(sign ? -value : value);
}

export function rupees(amount: number): Paise {
  return rupeesToPaise(amount);
}

export function add(...amounts: Paise[]): Paise {
  return paise(amounts.reduce<number>((sum, a) => sum + a, 0));
}

export function subtract(a: Paise, b: Paise): Paise {
  return paise(a - b);
}

export function multiply(amount: Paise, quantity: number): Paise {
  if (!Number.isSafeInteger(quantity)) {
    throw new MoneyError(`Quantity must be an integer, got ${quantity}`);
  }
  return paise(amount * quantity);
}

/**
 * Applies a percentage expressed in basis points (1% = 100 bps), rounding half up to the nearest paisa.
 * Integer-only so results are deterministic.
 */
export function applyBasisPoints(amount: Paise, basisPoints: number): Paise {
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0) {
    throw new MoneyError(`Basis points must be a non-negative integer, got ${basisPoints}`);
  }
  const product = amount * basisPoints;
  const sign = product < 0 ? -1 : 1;
  return paise(sign * Math.floor((Math.abs(product) + 5000) / 10000));
}

export function formatINR(amount: Paise): string {
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const whole = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, '0');
  // Indian digit grouping: last three digits, then groups of two (1,00,000).
  const digits = String(whole);
  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${lastThree}` : lastThree;
  return `${negative ? '-' : ''}₹${grouped}.${fraction}`;
}
