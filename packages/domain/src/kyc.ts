import type { RetailerStatus } from './checkout.js';

export type KycActor = 'retailer' | 'reviewer';

/** Allowed retailer-account status changes and who may make them. Anything not listed is rejected. */
const TRANSITIONS: Record<RetailerStatus, Partial<Record<RetailerStatus, KycActor>>> = {
  draft: { submitted: 'retailer' },
  needs_resubmission: { submitted: 'retailer' },
  submitted: { under_review: 'reviewer', approved: 'reviewer', rejected: 'reviewer', needs_resubmission: 'reviewer' },
  under_review: { approved: 'reviewer', rejected: 'reviewer', needs_resubmission: 'reviewer' },
  approved: { suspended: 'reviewer' },
  suspended: { approved: 'reviewer' },
  rejected: {},
};

export function canTransition(from: RetailerStatus, to: RetailerStatus, actor: KycActor): boolean {
  return TRANSITIONS[from][to] === actor;
}

/** Decisions that must carry a written reason so the retailer and auditors know why. */
export function decisionNeedsReason(to: RetailerStatus): boolean {
  return to === 'rejected' || to === 'needs_resubmission' || to === 'suspended';
}

/** States in which the retailer may still edit their onboarding details and documents. */
export function isEditableByRetailer(status: RetailerStatus): boolean {
  return status === 'draft' || status === 'needs_resubmission';
}

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Validates a 15-character GSTIN, including its check digit. */
export function isValidGstin(input: string): boolean {
  const gstin = input.trim().toUpperCase();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = GSTIN_CHARS.indexOf(gstin[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36] === gstin[14];
}

export function isValidPinCode(input: string): boolean {
  return /^[1-9]\d{5}$/.test(input.trim());
}

/** Bihar is the launch state; coordinates must at least fall inside India's bounding box. */
export function isPlausibleIndianCoordinate(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= 6 && lat <= 37.5 && lng >= 68 && lng <= 97.5;
}

export interface KycCompletenessInput {
  businessName: string | null;
  ownerName: string | null;
  store: { addressLine1: string; postalCode: string; latitude: number | null; longitude: number | null } | null;
  license: { number: string; validUntil: string } | null;
  documentKinds: string[];
  /** ISO date (YYYY-MM-DD) of "today" in India. */
  today: string;
}

export type KycGap =
  | 'BUSINESS_NAME_MISSING'
  | 'OWNER_NAME_MISSING'
  | 'STORE_ADDRESS_MISSING'
  | 'STORE_LOCATION_MISSING'
  | 'LICENSE_MISSING'
  | 'LICENSE_EXPIRED'
  | 'LICENSE_DOCUMENT_MISSING'
  | 'STORE_PHOTO_MISSING';

/** Lists everything still needed before a retailer can submit for review. Empty means ready. */
export function kycGaps(input: KycCompletenessInput): KycGap[] {
  const gaps: KycGap[] = [];
  if (!input.businessName?.trim()) gaps.push('BUSINESS_NAME_MISSING');
  if (!input.ownerName?.trim()) gaps.push('OWNER_NAME_MISSING');
  if (!input.store?.addressLine1.trim() || !input.store.postalCode) gaps.push('STORE_ADDRESS_MISSING');
  if (input.store?.latitude == null || input.store.longitude == null) gaps.push('STORE_LOCATION_MISSING');
  if (!input.license?.number.trim()) gaps.push('LICENSE_MISSING');
  else if (input.license.validUntil <= input.today) gaps.push('LICENSE_EXPIRED');
  if (!input.documentKinds.includes('drug_license')) gaps.push('LICENSE_DOCUMENT_MISSING');
  if (!input.documentKinds.includes('store_photo')) gaps.push('STORE_PHOTO_MISSING');
  return gaps;
}

/** Today's date in India (Asia/Kolkata) as YYYY-MM-DD. */
export function indiaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
}
