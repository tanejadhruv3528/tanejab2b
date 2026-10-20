import { describe, expect, it } from 'vitest';
import { add, applyBasisPoints, formatINR, MoneyError, multiply, paise, rupeesToPaise } from '../src/money.js';

describe('rupeesToPaise', () => {
  it.each([
    ['0', 0],
    ['1', 100],
    ['1.5', 150],
    ['1.05', 105],
    ['3000', 300000],
    ['1,00,000.99', 10000099],
    ['-12.30', -1230],
  ])('parses %s', (input, expected) => {
    expect(rupeesToPaise(input)).toBe(expected);
  });

  it.each(['', 'abc', '1.234', '1e3', '₹100'])('rejects %s', (input) => {
    expect(() => rupeesToPaise(input)).toThrow(MoneyError);
  });

  it('avoids float drift', () => {
    expect(add(rupeesToPaise('0.1'), rupeesToPaise('0.2'))).toBe(30);
  });
});

describe('arithmetic', () => {
  it('multiplies by integer quantities only', () => {
    expect(multiply(paise(1999), 3)).toBe(5997);
    expect(() => multiply(paise(1999), 1.5)).toThrow(MoneyError);
  });

  it('rejects non-integer paise', () => {
    expect(() => paise(10.5)).toThrow(MoneyError);
  });

  it('applies basis points with half-up rounding', () => {
    expect(applyBasisPoints(paise(10000), 500)).toBe(500); // 5% of ₹100
    expect(applyBasisPoints(paise(333), 300)).toBe(10); // 9.99 -> 10
    expect(applyBasisPoints(paise(150), 100)).toBe(2); // 1.5 -> 2
    expect(applyBasisPoints(paise(149), 100)).toBe(1); // 1.49 -> 1
  });
});

describe('formatINR', () => {
  it.each([
    [0, '₹0.00'],
    [5, '₹0.05'],
    [300000, '₹3,000.00'],
    [10000000, '₹1,00,000.00'],
    [2500000000, '₹2,50,00,000.00'],
    [-5050, '-₹50.50'],
  ])('formats %i', (value, expected) => {
    expect(formatINR(paise(value))).toBe(expected);
  });
});
