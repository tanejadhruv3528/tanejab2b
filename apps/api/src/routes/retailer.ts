import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAuth } from '../auth/plugin.js';
import { withTransaction, type Db } from '../db.js';
import { AppError } from '../errors.js';
import {
  findAccountIdForOwner,
  loadOnboarding,
  lockEditableAccount,
  recordDocument,
  saveOnboarding,
  submitForReview,
  type DocumentKind,
  type OnboardingInput,
} from '../retailers.js';
import { sniffContentType, type DocumentStore } from '../storage.js';
import type { Actor } from '../users.js';

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const DOCUMENT_KINDS: DocumentKind[] = ['drug_license', 'store_photo', 'gst_certificate', 'other'];
const UPLOAD_CONTENT_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

const nullableString = (maxLength: number) => ({ type: ['string', 'null'], maxLength }) as const;

const onboardingBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    businessName: { type: 'string', minLength: 1, maxLength: 200 },
    ownerName: { type: 'string', minLength: 1, maxLength: 120 },
    email: { ...nullableString(200), format: 'email' },
    gstin: nullableString(15),
    store: {
      type: 'object',
      additionalProperties: false,
      required: ['addressLine1', 'city', 'district', 'postalCode', 'latitude', 'longitude'],
      properties: {
        addressLine1: { type: 'string', minLength: 3, maxLength: 300 },
        addressLine2: nullableString(300),
        landmark: nullableString(200),
        city: { type: 'string', minLength: 2, maxLength: 100 },
        district: { type: 'string', minLength: 2, maxLength: 100 },
        state: { type: 'string', minLength: 2, maxLength: 100 },
        postalCode: { type: 'string', minLength: 6, maxLength: 6 },
        latitude: { type: 'number' },
        longitude: { type: 'number' },
      },
    },
    license: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'number', 'validUntil'],
      properties: {
        type: { type: 'string', enum: ['form_20', 'form_21', 'form_20b', 'form_21b', 'form_20_21', 'other'] },
        number: { type: 'string', minLength: 3, maxLength: 100 },
        validUntil: { type: 'string', format: 'date' },
      },
    },
  },
} as const;

function actorFrom(request: FastifyRequest): Actor {
  const auth = requireAuth(request);
  return { userId: auth.user.id, role: 'retailer_applicant', requestId: request.id, ip: request.ip ?? null };
}

export async function retailerRoutes(app: FastifyInstance, opts: { db: Db; documents: DocumentStore }): Promise<void> {
  const { db, documents } = opts;

  // Raw file uploads: the body is the file itself, so no multipart parsing is needed.
  app.addContentTypeParser(UPLOAD_CONTENT_TYPES, { parseAs: 'buffer', bodyLimit: MAX_DOCUMENT_BYTES }, (_req, body, done) =>
    done(null, body),
  );

  app.get('/retailer/onboarding', async (request) => {
    const auth = requireAuth(request);
    const accountId = await findAccountIdForOwner(db, auth.user.id);
    return accountId ? loadOnboarding(db, accountId) : { account: null };
  });

  app.put<{ Body: OnboardingInput }>('/retailer/onboarding', { schema: { body: onboardingBody } }, async (request) => {
    const actor = actorFrom(request);
    const accountId = await withTransaction(db, (client) => saveOnboarding(client, actor, request.body));
    return loadOnboarding(db, accountId);
  });

  app.post<{ Params: { kind: DocumentKind }; Body: Buffer }>(
    '/retailer/kyc/documents/:kind',
    {
      bodyLimit: MAX_DOCUMENT_BYTES,
      schema: {
        params: {
          type: 'object',
          required: ['kind'],
          properties: { kind: { type: 'string', enum: DOCUMENT_KINDS } },
        },
      },
    },
    async (request, reply) => {
      const actor = actorFrom(request);
      const bytes = request.body;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        throw new AppError('BAD_REQUEST', 'Send the file as the request body with Content-Type image/jpeg, image/png or application/pdf');
      }
      const contentType = sniffContentType(bytes);
      if (!contentType || contentType !== request.headers['content-type']?.split(';')[0]?.trim()) {
        throw new AppError('VALIDATION_FAILED', 'File must be a JPEG, PNG or PDF matching its Content-Type');
      }
      // Check the account is editable before writing the file, then record it in one transaction.
      const accountId = await withTransaction(db, (client) => lockEditableAccount(client, actor.userId!));
      const stored = await documents.put(`kyc/${accountId}`, bytes, contentType);
      const id = await withTransaction(db, async (client) => {
        await lockEditableAccount(client, actor.userId!);
        return recordDocument(client, accountId, actor.userId!, {
          kind: request.params.kind,
          key: stored.key,
          contentType,
          sizeBytes: bytes.length,
          sha256: stored.sha256,
        });
      });
      return reply.status(201).send({ id, kind: request.params.kind, contentType, sizeBytes: bytes.length });
    },
  );

  app.post('/retailer/kyc/submit', async (request) => {
    const actor = actorFrom(request);
    const accountId = await withTransaction(db, (client) => submitForReview(client, actor));
    return loadOnboarding(db, accountId);
  });

  app.get('/retailer/kyc/status', async (request) => {
    const auth = requireAuth(request);
    const accountId = await findAccountIdForOwner(db, auth.user.id);
    if (!accountId) return { status: 'not_started', gaps: [], latestDecision: null };
    const { account, gaps, latestDecision } = await loadOnboarding(db, accountId);
    return { status: account.status, gaps, latestDecision };
  });
}
