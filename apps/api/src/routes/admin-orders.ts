import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit.js';
import { requireAuth, requireRole } from '../auth/plugin.js';
import { withTransaction, type Db } from '../db.js';
import { acceptOrder, declineCancelRequest, getOrder, listOrders, staffCancel } from '../orders.js';
import { reallocateShortPick } from '../warehouse.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const reasonBody = {
  type: 'object',
  required: ['reason'],
  additionalProperties: false,
  properties: { reason: { type: 'string', minLength: 3, maxLength: 500 } },
} as const;

const STATUSES = [
  'placed', 'accepted', 'picking', 'short_pick_review', 'packed', 'ready_for_dispatch', 'assigned_to_rider',
  'out_for_delivery', 'delivered', 'cancel_requested', 'cancelled', 'delivery_failed', 'returned', 'closed',
];

export async function adminOrderRoutes(app: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;
  const canView = requireRole(
    'super_admin', 'support_operator', 'picker_packer', 'dispatcher', 'billing_operator', 'finance_admin',
  );
  const canManage = requireRole('super_admin', 'support_operator');

  app.get<{ Querystring: { status?: string; limit: number; offset: number } }>(
    '/admin/orders',
    {
      preHandler: canView,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: STATUSES },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
      },
    },
    async (request) => {
      const { status, limit, offset } = request.query;
      return { items: await listOrders(db, { ...(status ? { status } : {}), limit, offset }), limit, offset };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/admin/orders/:id',
    { preHandler: canView, schema: { params: idParams } },
    async (request) => ({ order: await getOrder(db, request.params.id, { staff: true }) }),
  );

  app.post<{ Params: { id: string } }>(
    '/admin/orders/:id/accept',
    { preHandler: canManage, schema: { params: idParams } },
    async (request) => {
      const auth = requireAuth(request);
      await withTransaction(db, async (client) => {
        const before = await acceptOrder(client, request.params.id, auth.user.id);
        await writeAudit(client, {
          actorUserId: auth.user.id,
          action: 'order.accept',
          entityType: 'order',
          entityId: before.id,
          before: { status: before.status },
          after: { status: 'accepted' },
          requestId: request.id,
          ipAddress: request.ip,
        });
      });
      return { order: await getOrder(db, request.params.id, { staff: true }) };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/admin/orders/:id/cancel',
    {
      preHandler: canManage,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['reason'],
          additionalProperties: false,
          properties: { reason: { type: 'string', minLength: 3, maxLength: 500 } },
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await withTransaction(db, async (client) => {
        const before = await staffCancel(client, request.params.id, auth.user.id, request.body.reason);
        await writeAudit(client, {
          actorUserId: auth.user.id,
          action: 'order.cancel',
          entityType: 'order',
          entityId: before.id,
          before: { status: before.status, paymentStatus: before.payment_status },
          after: { status: 'cancelled' },
          reason: request.body.reason,
          requestId: request.id,
          ipAddress: request.ip,
        });
      });
      return { order: await getOrder(db, request.params.id, { staff: true }) };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/admin/orders/:id/cancel-request/decline',
    { preHandler: canManage, schema: { params: idParams, body: reasonBody } },
    async (request) => {
      const auth = requireAuth(request);
      await withTransaction(db, async (client) => {
        const { order, restored } = await declineCancelRequest(client, request.params.id, auth.user.id, request.body.reason);
        await writeAudit(client, {
          actorUserId: auth.user.id,
          action: 'order.cancel_request_decline',
          entityType: 'order',
          entityId: order.id,
          before: { status: order.status },
          after: { status: restored },
          reason: request.body.reason,
          requestId: request.id,
          ipAddress: request.ip,
        });
      });
      return { order: await getOrder(db, request.params.id, { staff: true }) };
    },
  );

  // Short pick: cover the missing units from other batches of the same product, or cancel via /cancel.
  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/admin/orders/:id/short-pick/reallocate',
    { preHandler: canManage, schema: { params: idParams, body: reasonBody } },
    async (request) => {
      const auth = requireAuth(request);
      await withTransaction(db, async (client) => {
        const { order, added } = await reallocateShortPick(client, request.params.id, auth.user.id, request.body.reason);
        await writeAudit(client, {
          actorUserId: auth.user.id,
          action: 'order.short_pick_reallocate',
          entityType: 'order',
          entityId: order.id,
          before: { status: order.status },
          after: { status: 'picking', added },
          reason: request.body.reason,
          requestId: request.id,
          ipAddress: request.ip,
        });
      });
      return { order: await getOrder(db, request.params.id, { staff: true }) };
    },
  );
}
