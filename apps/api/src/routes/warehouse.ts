import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit.js';
import { requireAuth, requireRole } from '../auth/plugin.js';
import { withTransaction, type Db } from '../db.js';
import { getOrder } from '../orders.js';
import {
  ACTIVE_TASK_STATUSES,
  confirmPack,
  confirmPick,
  getTask,
  listTasks,
  recordInvoice,
  startPicking,
  type InvoiceInput,
  type PackInput,
  type PickConfirmation,
  type TaskStatus,
} from '../warehouse.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const TASK_STATUSES = ['open', 'picking', 'short_pick', 'picked', 'packed', 'cancelled'];

export async function warehouseRoutes(app: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;
  const canPick = requireRole('picker_packer', 'super_admin');
  const canBill = requireRole('billing_operator', 'super_admin');

  app.get<{ Querystring: { status?: TaskStatus; limit: number; offset: number } }>(
    '/warehouse/tasks',
    {
      preHandler: canPick,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: TASK_STATUSES },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
      },
    },
    async (request) => {
      const { status, limit, offset } = request.query;
      const statuses = status ? [status] : ACTIVE_TASK_STATUSES;
      return { items: await listTasks(db, { statuses, limit, offset }), limit, offset };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/warehouse/tasks/:id',
    { preHandler: canPick, schema: { params: idParams } },
    async (request) => ({ task: await getTask(db, request.params.id) }),
  );

  app.post<{ Params: { id: string } }>(
    '/warehouse/tasks/:id/start',
    { preHandler: canPick, schema: { params: idParams } },
    async (request) => {
      const auth = requireAuth(request);
      await withTransaction(db, async (client) => {
        const { task, order } = await startPicking(client, request.params.id, auth.user.id);
        await writeAudit(client, {
          actorUserId: auth.user.id,
          action: 'warehouse.pick_start',
          entityType: 'warehouse_task',
          entityId: task.id,
          before: { taskStatus: task.status, orderStatus: order.status },
          after: { taskStatus: 'picking', orderStatus: 'picking' },
          requestId: request.id,
          ipAddress: request.ip,
        });
      });
      return { task: await getTask(db, request.params.id) };
    },
  );

  app.post<{ Params: { id: string }; Body: { lines: PickConfirmation[] } }>(
    '/warehouse/tasks/:id/pick-confirmation',
    {
      preHandler: canPick,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['lines'],
          additionalProperties: false,
          properties: {
            lines: {
              type: 'array',
              minItems: 1,
              maxItems: 500,
              items: {
                type: 'object',
                required: ['lineId', 'pickedQty'],
                additionalProperties: false,
                properties: {
                  lineId: { type: 'string', format: 'uuid' },
                  pickedQty: { type: 'integer', minimum: 0, maximum: 100_000 },
                  shortReason: { type: 'string', enum: ['not_found', 'damaged', 'expiry_mismatch', 'other'] },
                  shortNote: { type: 'string', minLength: 1, maxLength: 300 },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await withTransaction(db, async (client) => {
        const { task, order, shorts } = await confirmPick(client, request.params.id, auth.user.id, request.body.lines);
        await writeAudit(client, {
          actorUserId: auth.user.id,
          action: shorts.length > 0 ? 'warehouse.short_pick' : 'warehouse.pick_confirm',
          entityType: 'warehouse_task',
          entityId: task.id,
          before: { taskStatus: task.status, orderStatus: order.status },
          after: {
            taskStatus: shorts.length > 0 ? 'short_pick' : 'picked',
            orderStatus: shorts.length > 0 ? 'short_pick_review' : order.status,
            shorts,
          },
          requestId: request.id,
          ipAddress: request.ip,
        });
      });
      return { task: await getTask(db, request.params.id) };
    },
  );

  app.post<{ Params: { id: string }; Body: PackInput }>(
    '/warehouse/tasks/:id/pack-confirmation',
    {
      preHandler: canPick,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['packageCount', 'checklist'],
          additionalProperties: false,
          properties: {
            packageCount: { type: 'integer', minimum: 1, maximum: 50 },
            // Every check must be ticked; the packer cannot skip one.
            checklist: {
              type: 'object',
              required: ['quantitiesMatch', 'batchAndExpiryChecked', 'sealedAndLabelled'],
              additionalProperties: false,
              properties: {
                quantitiesMatch: { const: true },
                batchAndExpiryChecked: { const: true },
                sealedAndLabelled: { const: true },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await withTransaction(db, async (client) => {
        const { task, order } = await confirmPack(client, request.params.id, auth.user.id, request.body);
        await writeAudit(client, {
          actorUserId: auth.user.id,
          action: 'warehouse.pack_confirm',
          entityType: 'warehouse_task',
          entityId: task.id,
          before: { taskStatus: task.status, orderStatus: order.status },
          after: { taskStatus: 'packed', orderStatus: 'packed', packageCount: request.body.packageCount },
          requestId: request.id,
          ipAddress: request.ip,
        });
      });
      return { task: await getTask(db, request.params.id) };
    },
  );

  app.post<{ Params: { id: string }; Body: InvoiceInput }>(
    '/billing/orders/:id/invoice',
    {
      preHandler: canBill,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['invoiceNumber', 'amountPaise'],
          additionalProperties: false,
          properties: {
            invoiceNumber: { type: 'string', pattern: '^[A-Za-z0-9/_-]{1,40}$' },
            amountPaise: { type: 'integer', minimum: 1, maximum: 100_000_000_00 },
            mismatchReason: { type: 'string', minLength: 3, maxLength: 300 },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await withTransaction(db, async (client) => {
        const { order, payablePaise, mismatch } = await recordInvoice(client, request.params.id, auth.user.id, request.body);
        await writeAudit(client, {
          actorUserId: auth.user.id,
          action: 'order.invoice_record',
          entityType: 'order',
          entityId: order.id,
          before: { status: order.status },
          after: {
            status: 'ready_for_dispatch',
            invoiceNumber: request.body.invoiceNumber,
            amountPaise: request.body.amountPaise,
            payablePaise,
            mismatch,
          },
          reason: mismatch ? request.body.mismatchReason : null,
          requestId: request.id,
          ipAddress: request.ip,
        });
      });
      reply.code(201);
      return { order: await getOrder(db, request.params.id, { staff: true }) };
    },
  );
}
