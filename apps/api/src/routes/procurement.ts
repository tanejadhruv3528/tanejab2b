import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { writeAudit, type AuditEntry } from '../audit.js';
import { requireAuth, requireRole } from '../auth/plugin.js';
import { withTransaction, type Db } from '../db.js';
import {
  cancelPurchaseOrder,
  cancelSpecialOrder,
  closeRequest,
  confirmEta,
  createPurchaseOrder,
  createRestockRequest,
  createSpecialOrder,
  createSupplier,
  getPurchaseOrder,
  listPurchaseOrders,
  listRequests,
  listSpecialOrders,
  listSuppliers,
  markPurchaseOrderSent,
  receiveGoods,
  type PurchaseOrderInput,
  type ReceiptLine,
  type RequestStatus,
  type SpecialOrderInput,
} from '../procurement.js';
import { retailerAccountIdOf } from '../retailer-context.js';

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

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', format: 'date' } as const;

function audited(request: FastifyRequest, entry: Omit<AuditEntry, 'actorUserId' | 'requestId' | 'ipAddress'>) {
  return (client: PoolClient) =>
    writeAudit(client, { ...entry, actorUserId: requireAuth(request).user.id, requestId: request.id, ipAddress: request.ip });
}

export async function procurementRoutes(app: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;
  const canProcure = requireRole('procurement', 'super_admin');
  // Warehouse staff check deliveries in; only procurement manages suppliers and purchase orders.
  const canReceive = requireRole('procurement', 'picker_packer', 'super_admin');

  // ---- Retailer special orders: no supplier, cost or internal notes in any response. ----

  app.post<{ Body: SpecialOrderInput }>(
    '/special-orders',
    {
      schema: {
        body: {
          type: 'object',
          required: ['quantity'],
          additionalProperties: false,
          properties: {
            productId: { type: 'string', format: 'uuid' },
            requestedName: { type: 'string', minLength: 2, maxLength: 200 },
            quantity: { type: 'integer', minimum: 1, maximum: 10_000 },
            note: { type: 'string', minLength: 1, maxLength: 300 },
          },
        },
      },
    },
    async (request, reply) => {
      const accountId = retailerAccountIdOf(request);
      const id = await withTransaction(db, (c) => createSpecialOrder(c, accountId, requireAuth(request).user.id, request.body));
      const mine = await listSpecialOrders(db, accountId, { limit: 100, offset: 0 });
      reply.code(201);
      return { request: mine.find((r) => r.id === id) };
    },
  );

  app.get<{ Querystring: { limit: number; offset: number } }>(
    '/special-orders',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: page } } },
    async (request) => {
      const accountId = retailerAccountIdOf(request);
      const { limit, offset } = request.query;
      return { items: await listSpecialOrders(db, accountId, { limit, offset }), limit, offset };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/special-orders/:id/cancel',
    { schema: { params: idParams } },
    async (request) => {
      const accountId = retailerAccountIdOf(request);
      await withTransaction(db, (c) => cancelSpecialOrder(c, request.params.id, accountId));
      return { ok: true };
    },
  );

  // ---- Procurement desk ----

  app.get<{ Querystring: { status?: RequestStatus; limit: number; offset: number } }>(
    '/procurement/requests',
    {
      preHandler: canProcure,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { status: { type: 'string', enum: ['open', 'ordered', 'received', 'unavailable', 'cancelled'] }, ...page },
        },
      },
    },
    async (request) => {
      const { status, limit, offset } = request.query;
      return { items: await listRequests(db, { ...(status ? { status } : {}), limit, offset }), limit, offset };
    },
  );

  app.post<{ Body: { productId: string; quantity: number; note?: string } }>(
    '/procurement/requests',
    {
      preHandler: canProcure,
      schema: {
        body: {
          type: 'object',
          required: ['productId', 'quantity'],
          additionalProperties: false,
          properties: {
            productId: { type: 'string', format: 'uuid' },
            quantity: { type: 'integer', minimum: 1, maximum: 100_000 },
            note: { type: 'string', minLength: 1, maxLength: 300 },
          },
        },
      },
    },
    async (request, reply) => {
      const id = await withTransaction(db, (c) => createRestockRequest(c, requireAuth(request).user.id, request.body));
      reply.code(201);
      return { id };
    },
  );

  app.post<{ Params: { id: string }; Body: { etaDate: string } }>(
    '/procurement/requests/:id/eta',
    {
      preHandler: canProcure,
      schema: {
        params: idParams,
        body: { type: 'object', required: ['etaDate'], additionalProperties: false, properties: { etaDate: DATE } },
      },
    },
    async (request) => {
      await withTransaction(db, async (c) => {
        const before = await confirmEta(c, request.params.id, request.body.etaDate);
        await audited(request, {
          action: 'procurement.eta_confirm',
          entityType: 'procurement_request',
          entityId: before.id,
          before: { etaDate: before.eta_date },
          after: { etaDate: request.body.etaDate },
        })(c);
      });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { outcome: 'unavailable' | 'cancelled'; reason: string } }>(
    '/procurement/requests/:id/close',
    {
      preHandler: canProcure,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['outcome', 'reason'],
          additionalProperties: false,
          properties: {
            outcome: { type: 'string', enum: ['unavailable', 'cancelled'] },
            reason: { type: 'string', minLength: 3, maxLength: 500 },
          },
        },
      },
    },
    async (request) => {
      await withTransaction(db, async (c) => {
        const before = await closeRequest(c, request.params.id, request.body.outcome, request.body.reason);
        await audited(request, {
          action: 'procurement.request_close',
          entityType: 'procurement_request',
          entityId: before.id,
          before: { status: before.status },
          after: { status: request.body.outcome },
          reason: request.body.reason,
        })(c);
      });
      return { ok: true };
    },
  );

  app.get('/procurement/suppliers', { preHandler: canProcure }, async () => ({ items: await listSuppliers(db) }));

  app.post<{ Body: { name: string; gstin?: string; phone?: string } }>(
    '/procurement/suppliers',
    {
      preHandler: canProcure,
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 200 },
            gstin: { type: 'string', pattern: '^[0-9]{2}[A-Z0-9]{13}$' },
            phone: { type: 'string', pattern: '^\\+?[0-9]{10,13}$' },
          },
        },
      },
    },
    async (request, reply) => {
      const id = await withTransaction(db, async (c) => {
        const created = await createSupplier(c, requireAuth(request).user.id, request.body);
        await audited(request, {
          action: 'procurement.supplier_create',
          entityType: 'supplier',
          entityId: created,
          after: { name: request.body.name },
        })(c);
        return created;
      });
      reply.code(201);
      return { id };
    },
  );

  app.get<{ Querystring: { status?: string; limit: number; offset: number } }>(
    '/procurement/purchase-orders',
    {
      preHandler: canReceive,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['draft', 'sent', 'partially_received', 'received', 'cancelled'] },
            ...page,
          },
        },
      },
    },
    async (request) => {
      const { status, limit, offset } = request.query;
      return { items: await listPurchaseOrders(db, { ...(status ? { status } : {}), limit, offset }), limit, offset };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/procurement/purchase-orders/:id',
    { preHandler: canReceive, schema: { params: idParams } },
    async (request) => ({ purchaseOrder: await getPurchaseOrder(db, request.params.id) }),
  );

  app.post<{ Body: PurchaseOrderInput }>(
    '/procurement/purchase-orders',
    {
      preHandler: canProcure,
      schema: {
        body: {
          type: 'object',
          required: ['supplierId', 'items'],
          additionalProperties: false,
          properties: {
            supplierId: { type: 'string', format: 'uuid' },
            note: { type: 'string', minLength: 1, maxLength: 500 },
            items: {
              type: 'array',
              minItems: 1,
              maxItems: 200,
              items: {
                type: 'object',
                required: ['productId', 'quantity', 'unitCostPaise'],
                additionalProperties: false,
                properties: {
                  productId: { type: 'string', format: 'uuid' },
                  quantity: { type: 'integer', minimum: 1, maximum: 100_000 },
                  unitCostPaise: { type: 'integer', minimum: 1, maximum: 10_000_000 },
                  requestId: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const id = await withTransaction(db, async (c) => {
        const created = await createPurchaseOrder(c, requireAuth(request).user.id, request.body);
        await audited(request, {
          action: 'procurement.po_create',
          entityType: 'purchase_order',
          entityId: created,
          after: { supplierId: request.body.supplierId, lines: request.body.items.length },
        })(c);
        return created;
      });
      reply.code(201);
      return { purchaseOrder: await getPurchaseOrder(db, id) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/procurement/purchase-orders/:id/send',
    { preHandler: canProcure, schema: { params: idParams } },
    async (request) => {
      await withTransaction(db, async (c) => {
        const po = await markPurchaseOrderSent(c, request.params.id);
        await audited(request, {
          action: 'procurement.po_send',
          entityType: 'purchase_order',
          entityId: po.id,
          before: { status: po.status },
          after: { status: 'sent' },
        })(c);
      });
      return { purchaseOrder: await getPurchaseOrder(db, request.params.id) };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/procurement/purchase-orders/:id/cancel',
    { preHandler: canProcure, schema: { params: idParams, body: reasonBody } },
    async (request) => {
      await withTransaction(db, async (c) => {
        const po = await cancelPurchaseOrder(c, request.params.id, request.body.reason);
        await audited(request, {
          action: 'procurement.po_cancel',
          entityType: 'purchase_order',
          entityId: po.id,
          before: { status: po.status },
          after: { status: 'cancelled' },
          reason: request.body.reason,
        })(c);
      });
      return { purchaseOrder: await getPurchaseOrder(db, request.params.id) };
    },
  );

  app.post<{ Params: { id: string }; Body: { supplierInvoiceRef?: string; items: ReceiptLine[] } }>(
    '/procurement/purchase-orders/:id/receive',
    {
      preHandler: canReceive,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['items'],
          additionalProperties: false,
          properties: {
            supplierInvoiceRef: { type: 'string', pattern: '^[A-Za-z0-9/_-]{1,40}$' },
            items: {
              type: 'array',
              minItems: 1,
              maxItems: 200,
              items: {
                type: 'object',
                required: ['itemId', 'batchNumber', 'expiryDate', 'acceptedQty', 'rejectedQty'],
                additionalProperties: false,
                properties: {
                  itemId: { type: 'string', format: 'uuid' },
                  batchNumber: { type: 'string', pattern: '^[A-Za-z0-9/_-]{1,40}$' },
                  expiryDate: DATE,
                  acceptedQty: { type: 'integer', minimum: 0, maximum: 100_000 },
                  rejectedQty: { type: 'integer', minimum: 0, maximum: 100_000 },
                  rejectReason: { type: 'string', enum: ['damaged', 'short_expiry', 'wrong_item', 'other'] },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      await withTransaction(db, async (c) => {
        const { po, status, received } = await receiveGoods(c, request.params.id, requireAuth(request).user.id, request.body);
        await audited(request, {
          action: 'procurement.goods_receive',
          entityType: 'purchase_order',
          entityId: po.id,
          before: { status: po.status },
          after: { status, received, supplierInvoiceRef: request.body.supplierInvoiceRef ?? null },
        })(c);
      });
      return { purchaseOrder: await getPurchaseOrder(db, request.params.id) };
    },
  );
}
