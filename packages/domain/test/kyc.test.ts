import { describe, expect, it } from 'vitest';
import type { RetailerStatus } from '../src/checkout.js';
import {
  canTransition,
  decisionNeedsReason,
  indiaToday,
  isEditableByRetailer,
  isPlausibleIndianCoordinate,
  isValidGstin,
  isValidPinCode,
  kycGaps,
  type KycCompletenessInput,
} from '../src/kyc.js';

describe('KYC status transitions', () => {
  it.each<[RetailerStatus, RetailerStatus, 'retailer' | 'reviewer']>([
    ['draft', 'submitted', 'retailer'],
    ['needs_resubmission', 'submitted', 'retailer'],
    ['submitted', 'under_review', 'reviewer'],
    ['submitted', 'approved', 'reviewer'],
    ['under_review', 'approved', 'reviewer'],
    ['under_review', 'rejected', 'reviewer'],
    ['under_review', 'needs_resubmission', 'reviewer'],
    ['approved', 'suspended', 'reviewer'],
    ['suspended', 'approved', 'reviewer'],
  ])('allows %s -> %s by %s', (from, to, actor) => {
    expect(canTransition(from, to, actor)).toBe(true);
  });

  it.each<[RetailerStatus, RetailerStatus, 'retailer' | 'reviewer']>([
    ['draft', 'approved', 'reviewer'],
    ['draft', 'submitted', 'reviewer'],
    ['submitted', 'approved', 'retailer'],
    ['rejected', 'submitted', 'retailer'],
    ['rejected', 'approved', 'reviewer'],
    ['approved', 'rejected', 'reviewer'],
    ['needs_resubmission', 'approved', 'reviewer'],
  ])('blocks %s -> %s by %s', (from, to, actor) => {
    expect(canTransition(from, to, actor)).toBe(false);
  });

  it('requires reasons for negative decisions only', () => {
    expect(decisionNeedsReason('rejected')).toBe(true);
    expect(decisionNeedsReason('needs_resubmission')).toBe(true);
    expect(decisionNeedsReason('suspended')).toBe(true);
    expect(decisionNeedsReason('approved')).toBe(false);
  });

  it('lets retailers edit only drafts and resubmissions', () => {
    expect(isEditableByRetailer('draft')).toBe(true);
    expect(isEditableByRetailer('needs_resubmission')).toBe(true);
    expect(isEditableByRetailer('submitted')).toBe(false);
    expect(isEditableByRetailer('approved')).toBe(false);
  });
});

describe('field validation', () => {
  it('checks GSTIN format and check digit', () => {
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
    expect(isValidGstin('27aapfu0939f1zv')).toBe(true);
    expect(isValidGstin('27AAPFU0939F1ZW')).toBe(false);
    expect(isValidGstin('27AAPFU0939F1Z')).toBe(false);
    expect(isValidGstin('')).toBe(false);
  });

  it('checks PIN codes', () => {
    expect(isValidPinCode('848101')).toBe(true);
    expect(isValidPinCode('048101')).toBe(false);
    expect(isValidPinCode('84810')).toBe(false);
  });

  it('checks coordinates fall in India', () => {
    expect(isPlausibleIndianCoordinate(25.86, 85.78)).toBe(true); // Samastipur
    expect(isPlausibleIndianCoordinate(51.5, -0.12)).toBe(false);
  });

  it('computes the Indian calendar date', () => {
    expect(indiaToday(new Date('2026-10-20T19:00:00Z'))).toBe('2026-10-21');
    expect(indiaToday(new Date('2026-10-20T10:00:00Z'))).toBe('2026-10-20');
  });
});

describe('kycGaps', () => {
  const complete: KycCompletenessInput = {
    businessName: 'Ramesh Medical',
    ownerName: 'Ramesh Kumar',
    store: { addressLine1: 'Main Road', postalCode: '848101', latitude: 25.86, longitude: 85.78 },
    license: { number: 'BR-SAM-20B-1234', validUntil: '2028-03-31' },
    documentKinds: ['drug_license', 'store_photo'],
    today: '2026-10-20',
  };

  it('is empty when everything is present', () => {
    expect(kycGaps(complete)).toEqual([]);
  });

  it('lists every missing item', () => {
    expect(
      kycGaps({ ...complete, businessName: ' ', ownerName: null, store: null, license: null, documentKinds: [] }),
    ).toEqual([
      'BUSINESS_NAME_MISSING',
      'OWNER_NAME_MISSING',
      'STORE_ADDRESS_MISSING',
      'STORE_LOCATION_MISSING',
      'LICENSE_MISSING',
      'LICENSE_DOCUMENT_MISSING',
      'STORE_PHOTO_MISSING',
    ]);
  });

  it('treats a licence expiring today as expired', () => {
    expect(kycGaps({ ...complete, license: { number: 'X', validUntil: '2026-10-20' } })).toEqual(['LICENSE_EXPIRED']);
  });

  it('requires a map pin', () => {
    expect(
      kycGaps({ ...complete, store: { addressLine1: 'Main Road', postalCode: '848101', latitude: null, longitude: 85 } }),
    ).toEqual(['STORE_LOCATION_MISSING']);
  });
});
