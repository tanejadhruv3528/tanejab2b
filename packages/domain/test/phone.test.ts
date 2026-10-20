import { describe, expect, it } from 'vitest';
import { maskPhone, normalizeIndianMobile } from '../src/phone.js';

describe('normalizeIndianMobile', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['98765 43210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['+91-98765-43210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['00919876543210', '+919876543210'],
    ['6000000000', '+916000000000'],
  ])('normalises %s', (input, expected) => {
    expect(normalizeIndianMobile(input)).toBe(expected);
  });

  it.each(['', '12345', '5876543210', '98765432101', '+1 415 555 0100', 'abcdefghij', '+9198765432'])(
    'rejects %s',
    (input) => {
      expect(normalizeIndianMobile(input)).toBeNull();
    },
  );
});

describe('maskPhone', () => {
  it('keeps only the country code and last four digits', () => {
    expect(maskPhone('+919876543210')).toBe('+91******3210');
  });
});
