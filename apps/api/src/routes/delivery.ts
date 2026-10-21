import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit.js';
import { requireAuth, requireRole } from '../auth/plugin.js';
import type { SmsSender } from '../auth/sms.js';
import { withTransaction, type Db } from '../db.js';
import {
  assignRider,
  cancelAssignment,
  confirmDelivery,
  failDelivery,
  listAssignments,
  listCodCollections,
  listRiderAssignments,
  reconcileCod,
  redispatch,
  resendDeliveryOtp,
  startDelivery,
  type AssignmentStatus,
  type CodInput,
  type FailureReason,
} from '../delivery.js';
import { getOrder } from '../orders.js';
import { retailerAccountIdOf } from '../retailer-context.js';
import { loadDeliveryWindow } from '../settings.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const page = {
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  offset: { type: 'integer', minimum: 0, default: 0 },
} as const;

const reasonBody = {
  type: 'object',
  required: ['reason'],
  additionalProperties: false,
  properties: { reason: { type: 'string', minLength: 3, maxLength: 500 } },
} as const;

export async function deliveryRoutes(app: FastifyInstance, opts: { db: Db; sms: SmsSender; otpPepper: string }): Promise<void> {
  const { db } = opts;
  const otp = { sms: opts.sms, pepper: opts.otpPepper };
  const canDispatch = requireRole('dispatcher', 'super_admin');
  const isRider = requireRole('rider');
  const canReconcile = requireRole('finance_admin', 'super_admin');

  // ---- Dispatcher ----

  app.get<{ Querystring: { status?: AssignmentStatus; limit: number; offset: number } }>(
    '/dispatch/assignments',
    {
      preHandler: canDispatch,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['assigned', 'out_for_delivery', 'delivered', 'failed', 'cancelled'] },
            ...page,
          },
        },
      },
    },
    async (request) => {
      const { status, limit, offset } = request.query;
      return { items: await listAssignments(db, { ...(status ? { status } : {}), limit, offset }), limit, offset };
    },
  );

  app.get('/dispatch/riders', { preHandler: canDispatch }, async () => {
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.phone,
              (SELECT count(*)::int FROM delivery_assignments d
               WHERE d.rider_user_id = u.id AND d.status IN ('assigned', 'out_for_delivery')) AS "liveStops"
       FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'rider'
       WHERE u.status = 'active' ORDER BY u.name NULLS LAST, u.phone`,
    );
    return { items: rows };
  });

  app.post<{ Body: { orderId: string; riderUserId: string } }>(
    '/dispatch/assignments',
    {
      preHandler: canDispatch,
      schema: {
        body: {
          type: 'object',
          required: ['orderId', 'riderUserId'],
          additionalProperties: false,
          properties: { orderId: { type: 'string', format: 'uuid' }, riderUserId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const assignmentId = await withTransaction(db, async (client) => {
        const { order, assignmentId: id } = await assignRider(client, request.body.orderId, request.body.riderUserId, auth.user.id);
        await writeAudit(client, {
          actorUserId: auth.user.id,
          action: 'delivery.assign',
          entityType: 'order',
          entityId: order.id,
          before: { status: order.status },
          after: { status: 'assigned_to_rider', assignmentId: id, riderUserId: request.body.riderUserId },
          requestId: request.id,
          ipAddress: request.ip,
        });
        return id;
      });
      reply.code(201);
      return { assignmentId, order: await getOrder(db, request.body.orderId, { staff: true }) };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/dispatch/assignments/:id/cancel',
    { preHandler: canDispatch, schema: { params: idParams, body: reasonBody } },
    async (request) => {
      const auth = requireAuth(request);
      await withTransaction(db, async (client) => {
        const { assignment, order } = await cancelAssignment(client, request.params.id, auth.user.id, request.body.reason);
        await writeAudit(client, {
          actorUserId: auth.user.id,
          action: 'delivery.unassign',
          entityType: 'delivery_assignment',
          entityId: assignment.id,
          before: { status: assignment.status, orderStatus: order.status },
          after: { status: 'cancelled', orderStatus: 'ready_for_dispatch' },
          reason: request.body.reason,
          requestId: request.id,
          ipAddress: request.ip,
        });
      });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/dispatch/orders/:id/redispatch',
    { preHandler: canDispatch, schema: { params: idParams, body: reasonBody } },
    async (request) => {
      const auth = requireAuth(request);
      await withTransaction(db, async (client) => {
        const order = await redispatch(client, request.params.id, auth.user.id, request.body.reason);
        await writeAudit(client, {
          actorUserId: auth.user.id,
          action: 'delivery.redispatch',
          entityType: 'order',
          entityId: order.id,
          before: { status: order.status },
          after: { status: 'ready_for_dispatch' },
          reason: request.body.reason,
          requestId: request.id,
          ipAddress: request.ip,
        });
      });
      return { order: await getOrder(db, request.params.id, { staff: true }) };
    },
  );

  // ---- Rider: assigned stops only ----

  app.get('/delivery/assignments', { preHandler: isRider }, async (request) => {
    const window = await loadDeliveryWindow(db);
    return { items: await listRiderAssignments(db, requireAuth(request).user.id), deliveryWindow: window };
  });

  app.post<{ Params: { id: string } }>(
    '/delivery/assignments/:id/start',
    { preHandler: isRider, schema: { params: idParams } },
    async (request) => {
      const riderId = requireAuth(request).user.id;
      await withTransaction(db, (client) => startDelivery(client, otp, request.params.id, riderId));
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { otp: string; cod?: CodInput } }>(
    '/delivery/assignments/:id/confirm',
    {
      preHandler: isRider,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['otp'],
          additionalProperties: false,
          properties: {
            otp: { type: 'string', pattern: '^[0-9]{6}$' },
            cod: {
              type: 'object',
              required: ['method', 'amountPaise'],
              additionalProperties: false,
              properties: {
                method: { type: 'string', enum: ['cash', 'upi'] },
                amountPaise: { type: 'integer', minimum: 0, maximum: 100_000_000 },
                upiReference: { type: 'string', pattern: '^[A-Za-z0-9]{6,35}$' },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const riderId = requireAuth(request).user.id;
      const { collection } = await confirmDelivery(db, opts.otpPepper, request.params.id, riderId, request.body);
      return { delivered: true, collection };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: FailureReason; note?: string } }>(
    '/delivery/assignments/:id/fail',
    {
      preHandler: isRider,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['reason'],
          additionalProperties: false,
          properties: {
            reason: {
              type: 'string',
              enum: ['store_closed', 'retailer_refused', 'address_issue', 'payment_not_ready', 'otp_unavailable', 'other'],
            },
            note: { type: 'string', minLength: 1, maxLength: 300 },
          },
        },
      },
    },
    async (request) => {
      const riderId = requireAuth(request).user.id;
      await withTransaction(db, async (client) => {
        const { assignment, order } = await failDelivery(client, request.params.id, riderId, request.body);
        await writeAudit(client, {
          actorUserId: riderId,
          action: 'delivery.fail',
          entityType: 'delivery_assignment',
          entityId: assignment.id,
          before: { status: assignment.status, orderStatus: order.status },
          after: { status: 'failed', orderStatus: 'delivery_failed' },
          reason: request.body.note ? `${request.body.reason}: ${request.body.note}` : request.body.reason,
          requestId: request.id,
          ipAddress: request.ip,
        });
      });
      return { ok: true };
    },
  );

  // ---- Retailer: ask for the delivery code again ----

  app.post<{ Params: { id: string } }>(
    '/orders/:id/delivery-otp',
    { schema: { params: idParams } },
    async (request) => {
      const accountId = retailerAccountIdOf(request);
      await withTransaction(db, (client) => resendDeliveryOtp(client, otp, request.params.id, accountId));
      return { sent: true };
    },
  );

  // ---- Finance: COD reconciliation ----

  app.get<{ Querystring: { status?: string; limit: number; offset: number } }>(
    '/finance/cod-collections',
    {
      preHandler: canReconcile,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { status: { type: 'string', enum: ['collected', 'reconciled', 'discrepancy'] }, ...page },
        },
      },
    },
    async (request) => {
      const { status, limit, offset } = request.query;
      return { items: await listCodCollections(db, { ...(status ? { status } : {}), limit, offset }), limit, offset };
    },
  );

  app.post<{ Params: { id: string }; Body: { handedOverPaise: number; note?: string } }>(
    '/finance/cod-collections/:id/reconcile',
    {
      preHandler: canReconcile,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['handedOverPaise'],
          additionalProperties: false,
          properties: {
            handedOverPaise: { type: 'integer', minimum: 0, maximum: 100_000_000 },
            note: { type: 'string', minLength: 3, maxLength: 500 },
          },
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const result = await withTransaction(db, async (client) => {
        const r = await reconcileCod(client, request.params.id, auth.user.id, request.body);
        await writeAudit(client, {
          actorUserId: auth.user.id,
          action: 'finance.cod_reconcile',
          entityType: 'cod_collection',
          entityId: request.params.id,
          before: { status: r.before },
          after: { status: r.status, handedOverPaise: request.body.handedOverPaise },
          reason: request.body.note ?? null,
          requestId: request.id,
          ipAddress: request.ip,
        });
        return r;
      });
      return { status: result.status };
    },
  );
}
