import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit.js';
import { requireAuth, requireRole } from '../auth/plugin.js';
import { withTransaction, type Db } from '../db.js';
import { AppError } from '../errors.js';
import { retailerAccountIdOf } from '../retailer-context.js';
import {
  cancelReturn,
  createReturn,
  decideReturn,
  getReturn,
  inspectReturn,
  listReturns,
  lockReturnForEvidence,
  receiveReturn,
  recordEvidence,
  schedulePickup,
  type InspectionInput,
  type ReturnRequestInput,
  type ReturnStatus,
} from '../returns.js';
import { sniffContentType, type DocumentStore } from '../storage.js';

const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
const UPLOAD_CONTENT_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const STATUSES = ['requested', 'approved', 'rejected', 'cancelled', 'pickup_scheduled', 'received', 'closed'];

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const page = {
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  offset: { type: 'integer', minimum: 0, default: 0 },
} as const;

const REF = { type: 'string', pattern: '^[A-Za-z0-9/_-]{1,40}$' } as const;

export async function returnRoutes(app: FastifyInstance, opts: { db: Db; documents: DocumentStore }): Promise<void> {
  const { db, documents } = opts;
  const canReview = requireRole('support_operator', 'super_admin');
  const canView = requireRole('support_operator', 'dispatcher', 'picker_packer', 'finance_admin', 'super_admin');
  const canSchedule = requireRole('dispatcher', 'super_admin');
  const canInspect = requireRole('picker_packer', 'super_admin');

  app.addContentTypeParser(UPLOAD_CONTENT_TYPES, { parseAs: 'buffer', bodyLimit: MAX_EVIDENCE_BYTES }, (_req, body, done) =>
    done(null, body),
  );

  // ---- Retailer ----

  app.post<{ Body: ReturnRequestInput }>(
    '/returns',
    {
      schema: {
        body: {
          type: 'object',
          required: ['orderId', 'items'],
          additionalProperties: false,
          properties: {
            orderId: { type: 'string', format: 'uuid' },
            note: { type: 'string', minLength: 1, maxLength: 500 },
            items: {
              type: 'array',
              minItems: 1,
              maxItems: 100,
              items: {
                type: 'object',
                required: ['productId', 'quantity', 'reason'],
                additionalProperties: false,
                properties: {
                  productId: { type: 'string', format: 'uuid' },
                  quantity: { type: 'integer', minimum: 1, maximum: 100_000 },
                  reason: { type: 'string', enum: ['damaged', 'expired', 'near_expiry', 'wrong_item', 'excess_supply', 'other'] },
                  batchNumber: REF,
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const accountId = retailerAccountIdOf(request);
      const id = await withTransaction(db, (c) => createReturn(c, accountId, requireAuth(request).user.id, request.body));
      reply.code(201);
      return { return: await getReturn(db, id, { accountId, staff: false }) };
    },
  );

  app.get<{ Querystring: { limit: number; offset: number } }>(
    '/returns',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: page } } },
    async (request) => {
      const accountId = retailerAccountIdOf(request);
      const { limit, offset } = request.query;
      return { items: await listReturns(db, { accountId, limit, offset, staff: false }), limit, offset };
    },
  );

  app.get<{ Params: { id: string } }>('/returns/:id', { schema: { params: idParams } }, async (request) => {
    const accountId = retailerAccountIdOf(request);
    return { return: await getReturn(db, request.params.id, { accountId, staff: false }) };
  });

  app.post<{ Params: { id: string } }>(
    '/returns/:id/evidence',
    { bodyLimit: MAX_EVIDENCE_BYTES, schema: { params: idParams } },
    async (request, reply) => {
      const accountId = retailerAccountIdOf(request);
      const userId = requireAuth(request).user.id;
      const bytes = request.body;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        throw new AppError('BAD_REQUEST', 'Send the photo as the request body with Content-Type image/jpeg, image/png or application/pdf');
      }
      const contentType = sniffContentType(bytes);
      if (!contentType || contentType !== request.headers['content-type']?.split(';')[0]?.trim()) {
        throw new AppError('VALIDATION_FAILED', 'File must be a JPEG, PNG or PDF matching its Content-Type');
      }
      // Check before writing the file, then record it under the same check.
      await withTransaction(db, (c) => lockReturnForEvidence(c, request.params.id, accountId));
      const stored = await documents.put(`returns/${accountId}`, bytes, contentType);
      const id = await withTransaction(db, async (c) => {
        await lockReturnForEvidence(c, request.params.id, accountId);
        return recordEvidence(c, request.params.id, userId, {
          key: stored.key,
          contentType,
          sizeBytes: bytes.length,
          sha256: stored.sha256,
        });
      });
      return reply.status(201).send({ id, contentType, sizeBytes: bytes.length });
    },
  );

  app.post<{ Params: { id: string } }>('/returns/:id/cancel', { schema: { params: idParams } }, async (request) => {
    const accountId = retailerAccountIdOf(request);
    await withTransaction(db, (c) => cancelReturn(c, request.params.id, accountId));
    return { return: await getReturn(db, request.params.id, { accountId, staff: false }) };
  });

  // ---- Staff ----

  app.get<{ Querystring: { status?: ReturnStatus; limit: number; offset: number } }>(
    '/admin/returns',
    {
      preHandler: canView,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { status: { type: 'string', enum: STATUSES }, ...page },
        },
      },
    },
    async (request) => {
      const { status, limit, offset } = request.query;
      return { items: await listReturns(db, { ...(status ? { status } : {}), limit, offset, staff: true }), limit, offset };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/admin/returns/:id',
    { preHandler: canView, schema: { params: idParams } },
    async (request) => ({ return: await getReturn(db, request.params.id, { staff: true }) }),
  );

  app.get<{ Params: { id: string; evidenceId: string } }>(
    '/admin/returns/:id/evidence/:evidenceId',
    {
      preHandler: canReview,
      schema: {
        params: {
          type: 'object',
          required: ['id', 'evidenceId'],
          properties: { id: { type: 'string', format: 'uuid' }, evidenceId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const { rows } = await db.query<{ storage_key: string; content_type: string }>(
        'SELECT storage_key, content_type FROM return_evidence WHERE id = $1 AND return_id = $2',
        [request.params.evidenceId, request.params.id],
      );
      if (!rows[0]) throw new AppError('NOT_FOUND', 'File not found');
      const bytes = await documents.get(rows[0].storage_key);
      await writeAudit(db, {
        actorUserId: requireAuth(request).user.id,
        action: 'return.evidence_view',
        entityType: 'return_evidence',
        entityId: request.params.evidenceId,
        after: { returnId: request.params.id },
        requestId: request.id,
        ipAddress: request.ip,
      });
      return reply
        .header('content-type', rows[0].content_type)
        .header('content-disposition', 'inline')
        .header('x-frame-options', 'DENY')
        .send(bytes);
    },
  );

  app.post<{ Params: { id: string }; Body: { decision: 'approve' | 'reject'; reason: string } }>(
    '/returns/:id/decision',
    {
      preHandler: canReview,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['decision', 'reason'],
          additionalProperties: false,
          properties: {
            decision: { type: 'string', enum: ['approve', 'reject'] },
            reason: { type: 'string', minLength: 3, maxLength: 500 },
          },
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await withTransaction(db, async (c) => {
        const { before, status } = await decideReturn(c, request.params.id, auth.user.id, request.body);
        await writeAudit(c, {
          actorUserId: auth.user.id,
          action: 'return.decision',
          entityType: 'return_request',
          entityId: before.id,
          before: { status: before.status },
          after: { status },
          reason: request.body.reason,
          requestId: request.id,
          ipAddress: request.ip,
        });
      });
      return { return: await getReturn(db, request.params.id, { staff: true }) };
    },
  );

  app.post<{ Params: { id: string }; Body: { riderUserId: string; pickupDate: string } }>(
    '/admin/returns/:id/pickup',
    {
      preHandler: canSchedule,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['riderUserId', 'pickupDate'],
          additionalProperties: false,
          properties: {
            riderUserId: { type: 'string', format: 'uuid' },
            pickupDate: { type: 'string', format: 'date' },
          },
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await withTransaction(db, async (c) => {
        const before = await schedulePickup(c, request.params.id, request.body);
        await writeAudit(c, {
          actorUserId: auth.user.id,
          action: 'return.pickup_schedule',
          entityType: 'return_request',
          entityId: before.id,
          before: { status: before.status },
          after: { status: 'pickup_scheduled', ...request.body },
          requestId: request.id,
          ipAddress: request.ip,
        });
      });
      return { return: await getReturn(db, request.params.id, { staff: true }) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/returns/:id/receive',
    { preHandler: canInspect, schema: { params: idParams } },
    async (request) => {
      const auth = requireAuth(request);
      await withTransaction(db, async (c) => {
        const before = await receiveReturn(c, request.params.id, auth.user.id);
        await writeAudit(c, {
          actorUserId: auth.user.id,
          action: 'return.receive',
          entityType: 'return_request',
          entityId: before.id,
          before: { status: before.status },
          after: { status: 'received' },
          requestId: request.id,
          ipAddress: request.ip,
        });
      });
      return { return: await getReturn(db, request.params.id, { staff: true }) };
    },
  );

  app.post<{ Params: { id: string }; Body: InspectionInput }>(
    '/admin/returns/:id/inspection',
    {
      preHandler: canInspect,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['grReference', 'resolution', 'items'],
          additionalProperties: false,
          properties: {
            grReference: REF,
            resolution: { type: 'string', enum: ['credit_note', 'replacement', 'no_action'] },
            resolutionReference: REF,
            items: {
              type: 'array',
              minItems: 1,
              maxItems: 100,
              items: {
                type: 'object',
                required: ['itemId', 'acceptedQty', 'disposition'],
                additionalProperties: false,
                properties: {
                  itemId: { type: 'string', format: 'uuid' },
                  acceptedQty: { type: 'integer', minimum: 0, maximum: 100_000 },
                  disposition: { type: 'string', enum: ['restock', 'return_to_supplier', 'destroy'] },
                  batchNumber: REF,
                  note: { type: 'string', minLength: 1, maxLength: 300 },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await withTransaction(db, async (c) => {
        const { before, restocked } = await inspectReturn(c, request.params.id, auth.user.id, request.body);
        await writeAudit(c, {
          actorUserId: auth.user.id,
          action: 'return.inspect_close',
          entityType: 'return_request',
          entityId: before.id,
          before: { status: before.status },
          after: {
            status: 'closed',
            grReference: request.body.grReference,
            resolution: request.body.resolution,
            resolutionReference: request.body.resolutionReference ?? null,
            items: request.body.items.map((i) => ({ itemId: i.itemId, acceptedQty: i.acceptedQty, disposition: i.disposition })),
            restocked,
          },
          requestId: request.id,
          ipAddress: request.ip,
        });
      });
      return { return: await getReturn(db, request.params.id, { staff: true }) };
    },
  );
}
