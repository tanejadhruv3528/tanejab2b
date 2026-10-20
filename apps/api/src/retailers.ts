import {
  canTransition,
  decisionNeedsReason,
  indiaToday,
  isEditableByRetailer,
  isPlausibleIndianCoordinate,
  isValidGstin,
  isValidPinCode,
  kycGaps,
  type RetailerStatus,
} from '@taneja/domain';
import type { PoolClient } from 'pg';
import { writeAudit } from './audit.js';
import type { Db } from './db.js';
import { AppError } from './errors.js';
import type { Actor } from './users.js';

export type DocumentKind = 'drug_license' | 'store_photo' | 'gst_certificate' | 'other';
export type LicenseType = 'form_20' | 'form_21' | 'form_20b' | 'form_21b' | 'form_20_21' | 'other';
export type VideoKycStatus = 'not_started' | 'scheduled' | 'completed' | 'failed' | 'waived';

type Queryable = Pick<Db, 'query'> | PoolClient;

export interface OnboardingInput {
  businessName?: string;
  ownerName?: string;
  email?: string | null;
  gstin?: string | null;
  store?: {
    addressLine1: string;
    addressLine2?: string | null;
    landmark?: string | null;
    city: string;
    district: string;
    state?: string;
    postalCode: string;
    latitude: number;
    longitude: number;
  };
  license?: { type: LicenseType; number: string; validUntil: string };
}

export async function findAccountIdForOwner(db: Queryable, userId: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM retailer_accounts WHERE owner_user_id = $1', [userId]);
  return rows[0]?.id ?? null;
}

/** Everything a retailer or reviewer needs to see about one account. Never includes storage keys. */
export async function loadOnboarding(db: Queryable, accountId: string) {
  const account = await db.query(
    `SELECT a.id, a.owner_user_id AS "ownerUserId", u.phone AS "ownerPhone", a.business_name AS "businessName",
            a.owner_name AS "ownerName", a.email, a.gstin, a.status, a.video_kyc_status AS "videoKycStatus",
            a.cod_allowed AS "codAllowed", a.submitted_at AS "submittedAt", a.approved_at AS "approvedAt",
            a.created_at AS "createdAt", a.updated_at AS "updatedAt"
     FROM retailer_accounts a JOIN users u ON u.id = a.owner_user_id
     WHERE a.id = $1`,
    [accountId],
  );
  if (!account.rows[0]) throw new AppError('NOT_FOUND', 'Retailer account not found');
  const [store, license, documents, review] = await Promise.all([
    db.query(
      `SELECT address_line1 AS "addressLine1", address_line2 AS "addressLine2", landmark, city, district, state,
              postal_code AS "postalCode", latitude::float AS latitude, longitude::float AS longitude,
              service_zone AS "serviceZone", verified, verified_at AS "verifiedAt"
       FROM store_locations WHERE retailer_account_id = $1`,
      [accountId],
    ),
    db.query(
      `SELECT license_type AS type, license_number AS number, to_char(valid_until, 'YYYY-MM-DD') AS "validUntil"
       FROM retailer_licenses WHERE retailer_account_id = $1`,
      [accountId],
    ),
    db.query(
      `SELECT id, kind, content_type AS "contentType", size_bytes AS "sizeBytes", created_at AS "uploadedAt"
       FROM kyc_documents WHERE retailer_account_id = $1 AND superseded_at IS NULL ORDER BY kind, created_at`,
      [accountId],
    ),
    db.query(
      `SELECT to_status AS status, reason, created_at AS "decidedAt"
       FROM kyc_reviews WHERE retailer_account_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [accountId],
    ),
  ]);
  const a = account.rows[0];
  const s = store.rows[0] ?? null;
  const l = license.rows[0] ?? null;
  const gaps = kycGaps({
    businessName: a.businessName,
    ownerName: a.ownerName,
    store: s,
    license: l,
    documentKinds: documents.rows.map((d) => d.kind as string),
    today: indiaToday(),
  });
  return { account: a, store: s, license: l, documents: documents.rows, latestDecision: review.rows[0] ?? null, gaps };
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function validate(input: OnboardingInput): void {
  const problems: Record<string, string> = {};
  if (input.gstin && !isValidGstin(input.gstin)) problems.gstin = 'GSTIN is not valid';
  if (input.store) {
    if (!isValidPinCode(input.store.postalCode)) problems['store.postalCode'] = 'PIN code must be 6 digits';
    if (!isPlausibleIndianCoordinate(input.store.latitude, input.store.longitude)) {
      problems['store.location'] = 'Map pin must be in India';
    }
  }
  if (input.license && !/^\d{4}-\d{2}-\d{2}$/.test(input.license.validUntil)) {
    problems['license.validUntil'] = 'Use YYYY-MM-DD';
  }
  if (Object.keys(problems).length > 0) {
    throw new AppError('VALIDATION_FAILED', 'Some details need fixing', problems);
  }
}

/** Creates or updates the caller's own onboarding details while the account is still editable. */
export async function saveOnboarding(client: PoolClient, actor: Actor, input: OnboardingInput): Promise<string> {
  validate(input);
  const userId = actor.userId!;
  await client.query(
    'INSERT INTO retailer_accounts (owner_user_id) VALUES ($1) ON CONFLICT (owner_user_id) DO NOTHING',
    [userId],
  );
  const { rows } = await client.query<{ id: string; status: RetailerStatus }>(
    'SELECT id, status FROM retailer_accounts WHERE owner_user_id = $1 FOR UPDATE',
    [userId],
  );
  const account = rows[0]!;
  if (!isEditableByRetailer(account.status)) {
    throw new AppError('CONFLICT', `Details cannot be changed while the account is ${account.status}`);
  }

  await client.query(
    `UPDATE retailer_accounts SET
       business_name = CASE WHEN $2::boolean THEN $3 ELSE business_name END,
       owner_name    = CASE WHEN $4::boolean THEN $5 ELSE owner_name END,
       email         = CASE WHEN $6::boolean THEN $7 ELSE email END,
       gstin         = CASE WHEN $8::boolean THEN $9 ELSE gstin END,
       updated_at    = now()
     WHERE id = $1`,
    [
      account.id,
      input.businessName !== undefined,
      clean(input.businessName),
      input.ownerName !== undefined,
      clean(input.ownerName),
      input.email !== undefined,
      clean(input.email),
      input.gstin !== undefined,
      clean(input.gstin)?.toUpperCase() ?? null,
    ],
  );

  if (input.store) {
    const s = input.store;
    // Any address change clears verification: a reviewer must re-check the new premises.
    await client.query(
      `INSERT INTO store_locations
         (retailer_account_id, address_line1, address_line2, landmark, city, district, state, postal_code, latitude, longitude)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (retailer_account_id) DO UPDATE SET
         address_line1 = EXCLUDED.address_line1, address_line2 = EXCLUDED.address_line2,
         landmark = EXCLUDED.landmark, city = EXCLUDED.city, district = EXCLUDED.district, state = EXCLUDED.state,
         postal_code = EXCLUDED.postal_code, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
         verified = false, verified_by = NULL, verified_at = NULL, updated_at = now()`,
      [
        account.id,
        s.addressLine1.trim(),
        clean(s.addressLine2),
        clean(s.landmark),
        s.city.trim(),
        s.district.trim(),
        clean(s.state) ?? 'Bihar',
        s.postalCode.trim(),
        s.latitude,
        s.longitude,
      ],
    );
  }

  if (input.license) {
    await client.query(
      `INSERT INTO retailer_licenses (retailer_account_id, license_type, license_number, valid_until)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (retailer_account_id) DO UPDATE SET
         license_type = EXCLUDED.license_type, license_number = EXCLUDED.license_number,
         valid_until = EXCLUDED.valid_until, updated_at = now()`,
      [account.id, input.license.type, input.license.number.trim(), input.license.validUntil],
    );
  }
  return account.id;
}

/** Records an uploaded document. drug_license and store_photo keep one current file; a new upload replaces the old. */
export async function recordDocument(
  client: PoolClient,
  accountId: string,
  userId: string,
  doc: { kind: DocumentKind; key: string; contentType: string; sizeBytes: number; sha256: string },
): Promise<string> {
  if (doc.kind === 'drug_license' || doc.kind === 'store_photo' || doc.kind === 'gst_certificate') {
    await client.query(
      'UPDATE kyc_documents SET superseded_at = now() WHERE retailer_account_id = $1 AND kind = $2 AND superseded_at IS NULL',
      [accountId, doc.kind],
    );
  }
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO kyc_documents (retailer_account_id, kind, storage_key, content_type, size_bytes, sha256, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [accountId, doc.kind, doc.key, doc.contentType, doc.sizeBytes, doc.sha256, userId],
  );
  return rows[0]!.id;
}

export async function lockEditableAccount(client: PoolClient, userId: string): Promise<string> {
  const { rows } = await client.query<{ id: string; status: RetailerStatus }>(
    'SELECT id, status FROM retailer_accounts WHERE owner_user_id = $1 FOR UPDATE',
    [userId],
  );
  const account = rows[0];
  if (!account) throw new AppError('NOT_FOUND', 'Start onboarding before uploading documents');
  if (!isEditableByRetailer(account.status)) {
    throw new AppError('CONFLICT', `Documents cannot be changed while the account is ${account.status}`);
  }
  return account.id;
}

export async function submitForReview(client: PoolClient, actor: Actor): Promise<string> {
  const accountId = await lockEditableAccount(client, actor.userId!);
  const { gaps, account } = await loadOnboarding(client, accountId);
  if (gaps.length > 0) {
    throw new AppError('VALIDATION_FAILED', 'Some details are still missing', { gaps });
  }
  if (!canTransition(account.status, 'submitted', 'retailer')) {
    throw new AppError('CONFLICT', `Cannot submit while the account is ${account.status}`);
  }
  await client.query(
    "UPDATE retailer_accounts SET status = 'submitted', submitted_at = now(), updated_at = now() WHERE id = $1",
    [accountId],
  );
  await writeAudit(client, {
    actorUserId: actor.userId,
    actorRole: 'retailer_applicant',
    action: 'retailer.kyc.submit',
    entityType: 'retailer_account',
    entityId: accountId,
    before: { status: account.status },
    after: { status: 'submitted' },
    requestId: actor.requestId ?? null,
    ipAddress: actor.ip ?? null,
  });
  return accountId;
}

export interface DecisionInput {
  status: RetailerStatus;
  reason?: string;
  storeVerified?: boolean;
  serviceZone?: string | null;
  videoKycStatus?: VideoKycStatus;
  codAllowed?: boolean;
}

/** Applies a reviewer decision, keeping the retailer role grant in step with the account status. */
export async function decideKyc(client: PoolClient, actor: Actor, accountId: string, input: DecisionInput) {
  const { rows } = await client.query<{ status: RetailerStatus; owner_user_id: string }>(
    'SELECT status, owner_user_id FROM retailer_accounts WHERE id = $1 FOR UPDATE',
    [accountId],
  );
  const current = rows[0];
  if (!current) throw new AppError('NOT_FOUND', 'Retailer account not found');
  if (current.owner_user_id === actor.userId) {
    throw new AppError('FORBIDDEN', 'You cannot review your own retailer account');
  }
  if (!canTransition(current.status, input.status, 'reviewer')) {
    throw new AppError('CONFLICT', `Cannot move an account from ${current.status} to ${input.status}`);
  }
  const reason = input.reason?.trim() || null;
  if (decisionNeedsReason(input.status) && !reason) {
    throw new AppError('VALIDATION_FAILED', 'A reason is required for this decision', { field: 'reason' });
  }

  const storeBefore = await client.query<{ verified: boolean; service_zone: string | null }>(
    'SELECT verified, service_zone FROM store_locations WHERE retailer_account_id = $1 FOR UPDATE',
    [accountId],
  );
  if (input.storeVerified !== undefined || input.serviceZone !== undefined) {
    if (!storeBefore.rows[0]) throw new AppError('CONFLICT', 'The retailer has not added a store address');
    await client.query(
      `UPDATE store_locations SET
         verified = coalesce($2, verified),
         verified_by = CASE WHEN $2 IS NULL THEN verified_by WHEN $2 THEN $4::uuid ELSE NULL END,
         verified_at = CASE WHEN $2 IS NULL THEN verified_at WHEN $2 THEN now() ELSE NULL END,
         service_zone = CASE WHEN $3::boolean THEN $5 ELSE service_zone END,
         updated_at = now()
       WHERE retailer_account_id = $1`,
      [accountId, input.storeVerified ?? null, input.serviceZone !== undefined, actor.userId, input.serviceZone ?? null],
    );
  }

  if (input.status === 'approved') {
    const check = await client.query<{ verified: boolean | null; valid_until: string | null }>(
      `SELECT s.verified, to_char(l.valid_until, 'YYYY-MM-DD') AS valid_until
       FROM retailer_accounts a
       LEFT JOIN store_locations s ON s.retailer_account_id = a.id
       LEFT JOIN retailer_licenses l ON l.retailer_account_id = a.id
       WHERE a.id = $1`,
      [accountId],
    );
    const c = check.rows[0]!;
    if (!c.verified) throw new AppError('CONFLICT', 'Verify the store address before approving');
    if (!c.valid_until || c.valid_until <= indiaToday()) {
      throw new AppError('CONFLICT', 'The drug licence is missing or expired');
    }
  }

  await client.query(
    `UPDATE retailer_accounts SET
       status = $2,
       approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE approved_at END,
       video_kyc_status = coalesce($3, video_kyc_status),
       cod_allowed = coalesce($4, cod_allowed),
       updated_at = now()
     WHERE id = $1`,
    [accountId, input.status, input.videoKycStatus ?? null, input.codAllowed ?? null],
  );

  if (input.status === 'approved') {
    await client.query(
      `INSERT INTO user_roles (user_id, role, scope_retailer_account_id, granted_by)
       VALUES ($1, 'retailer', $2, $3) ON CONFLICT DO NOTHING`,
      [current.owner_user_id, accountId, actor.userId],
    );
  } else if (input.status === 'suspended' || input.status === 'rejected') {
    await client.query(
      "DELETE FROM user_roles WHERE user_id = $1 AND role = 'retailer' AND scope_retailer_account_id = $2",
      [current.owner_user_id, accountId],
    );
  }

  await client.query(
    `INSERT INTO kyc_reviews (retailer_account_id, reviewer_user_id, from_status, to_status, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [accountId, actor.userId, current.status, input.status, reason],
  );
  await writeAudit(client, {
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: 'retailer.kyc.decision',
    entityType: 'retailer_account',
    entityId: accountId,
    before: { status: current.status, store: storeBefore.rows[0] ?? null },
    after: {
      status: input.status,
      storeVerified: input.storeVerified,
      serviceZone: input.serviceZone,
      videoKycStatus: input.videoKycStatus,
      codAllowed: input.codAllowed,
    },
    reason,
    requestId: actor.requestId ?? null,
    ipAddress: actor.ip ?? null,
  });
}
