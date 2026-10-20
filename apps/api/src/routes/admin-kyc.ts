import type { FastifyInstance, FastifyRequest } from 'fastify';
import { writeAudit } from '../audit.js';
import { hasRole, requireAuth, requireRole } from '../auth/plugin.js';
import { withTransaction, type Db } from '../db.js';
import { AppError } from '../errors.js';
import { decideKyc, loadOnboarding, type DecisionInput } from '../retailers.js';
import type { DocumentStore } from '../storage.js';
import type { Actor } from '../users.js';

const accountParams = {
  type: 'object',
  required: ['accountId'],
  properties: { accountId: { type: 'string', format: 'uuid' } },
} as const;

function reviewerActor(request: FastifyRequest): Actor {
  const auth = requireAuth(request);
  return {
    userId: auth.user.id,
    role: hasRole(auth, 'kyc_reviewer') ? 'kyc_reviewer' : 'super_admin',
    requestId: request.id,
    ip: request.ip ?? null,
  };
}

export async function adminKycRoutes(app: FastifyInstance, opts: { db: Db; documents: DocumentStore }): Promise<void> {
  const { db, documents } = opts;
  app.addHook('preHandler', requireRole('kyc_reviewer', 'super_admin'));

  app.get<{ Querystring: { status: string; limit: number; offset: number } }>(
    '/admin/kyc/queue',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', pattern: '^[a-z_]+(,[a-z_]+)*$', default: 'submitted,under_review' },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
      },
    },
    async (request) => {
      const { limit, offset } = request.query;
      const statuses = request.query.status.split(',');
      // Oldest submissions first so nobody waits indefinitely.
      const { rows } = await db.query(
        `SELECT a.id, a.business_name AS "businessName", a.owner_name AS "ownerName", u.phone AS "ownerPhone",
                a.status, a.submitted_at AS "submittedAt", s.district, s.postal_code AS "postalCode",
                s.verified AS "storeVerified"
         FROM retailer_accounts a
         JOIN users u ON u.id = a.owner_user_id
         LEFT JOIN store_locations s ON s.retailer_account_id = a.id
         WHERE a.status = ANY($1::text[])
         ORDER BY a.submitted_at ASC NULLS LAST, a.created_at ASC
         LIMIT $2 OFFSET $3`,
        [statuses, limit, offset],
      );
      return { items: rows, limit, offset };
    },
  );

  app.get<{ Params: { accountId: string } }>('/admin/kyc/:accountId', { schema: { params: accountParams } }, async (request) => {
    const detail = await loadOnboarding(db, request.params.accountId);
    const history = await db.query(
      `SELECT r.from_status AS "fromStatus", r.to_status AS "toStatus", r.reason, r.created_at AS "decidedAt",
              u.name AS "reviewerName"
       FROM kyc_reviews r JOIN users u ON u.id = r.reviewer_user_id
       WHERE r.retailer_account_id = $1 ORDER BY r.created_at DESC`,
      [request.params.accountId],
    );
    return { ...detail, history: history.rows };
  });

  // Every view of a KYC document is audited.
  app.get<{ Params: { accountId: string; documentId: string } }>(
    '/admin/kyc/:accountId/documents/:documentId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['accountId', 'documentId'],
          properties: { accountId: { type: 'string', format: 'uuid' }, documentId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const actor = reviewerActor(request);
      const { rows } = await db.query<{ storage_key: string; content_type: string; kind: string }>(
        'SELECT storage_key, content_type, kind FROM kyc_documents WHERE id = $1 AND retailer_account_id = $2',
        [request.params.documentId, request.params.accountId],
      );
      const doc = rows[0];
      if (!doc) throw new AppError('NOT_FOUND', 'Document not found');
      const bytes = await documents.get(doc.storage_key);
      await writeAudit(db, {
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'retailer.kyc.document.view',
        entityType: 'kyc_document',
        entityId: request.params.documentId,
        after: { kind: doc.kind, retailerAccountId: request.params.accountId },
        requestId: actor.requestId ?? null,
        ipAddress: actor.ip ?? null,
      });
      return reply
        .header('content-type', doc.content_type)
        .header('content-disposition', 'inline')
        .header('x-frame-options', 'DENY')
        .send(bytes);
    },
  );

  app.post<{ Params: { accountId: string }; Body: DecisionInput }>(
    '/admin/kyc/:accountId/decision',
    {
      schema: {
        params: accountParams,
        body: {
          type: 'object',
          required: ['status'],
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['under_review', 'approved', 'rejected', 'needs_resubmission', 'suspended'] },
            reason: { type: 'string', maxLength: 1000 },
            storeVerified: { type: 'boolean' },
            serviceZone: { type: ['string', 'null'], maxLength: 100 },
            videoKycStatus: { type: 'string', enum: ['not_started', 'scheduled', 'completed', 'failed', 'waived'] },
            codAllowed: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      const actor = reviewerActor(request);
      await withTransaction(db, (client) => decideKyc(client, actor, request.params.accountId, request.body));
      return loadOnboarding(db, request.params.accountId);
    },
  );
}
