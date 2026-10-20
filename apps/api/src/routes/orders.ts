import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/plugin.js';
import type { Db } from '../db.js';
import { AppError } from '../errors.js';
import { getOrder, listOrders, placeOrder, retailerCancel, startPayment } from '../orders.js';
import type { PaymentProvider } from '../payments.js';
import { retailerAccountIdOf } from '../retailer-context.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

export async function orderRoutes(app: FastifyInstance, opts: { db: Db; payments: PaymentProvider }): Promise<void> {
  const { db, payments } = opts;

  app.post<{ Body: { quoteId: string; paymentMethod: 'prepaid' | 'cod' } }>(
    '/orders',
    {
      schema: {
        body: {
          type: 'object',
          required: ['quoteId', 'paymentMethod'],
          additionalProperties: false,
          properties: {
            quoteId: { type: 'string', format: 'uuid' },
            paymentMethod: { type: 'string', enum: ['prepaid', 'cod'] },
          },
        },
      },
    },
    async (request, reply) => {
      const accountId = retailerAccountIdOf(request);
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(key)) {
        throw new AppError('BAD_REQUEST', 'Send a unique Idempotency-Key header (8-100 letters, digits, - or _)');
      }
      const { orderId, replayed } = await placeOrder(db, payments, {
        accountId,
        userId: requireAuth(request).user.id,
        quoteId: request.body.quoteId,
        paymentMethod: request.body.paymentMethod,
        idempotencyKey: key,
      });
      const order = await getOrder(db, orderId, { accountId, staff: false });
      return reply.status(replayed ? 200 : 201).send({ order, replayed });
    },
  );

  app.get<{ Querystring: { limit: number; offset: number } }>(
    '/orders',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
      },
    },
    async (request) => {
      const accountId = retailerAccountIdOf(request);
      const { limit, offset } = request.query;
      return { items: await listOrders(db, { accountId, limit, offset }), limit, offset };
    },
  );

  app.get<{ Params: { id: string } }>('/orders/:id', { schema: { params: idParams } }, async (request) => {
    const accountId = retailerAccountIdOf(request);
    return { order: await getOrder(db, request.params.id, { accountId, staff: false }) };
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } | undefined }>(
    '/orders/:id/cancel-request',
    {
      schema: {
        params: idParams,
        body: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: { reason: { type: 'string', maxLength: 500 } },
        },
      },
    },
    async (request) => {
      const accountId = retailerAccountIdOf(request);
      const result = await retailerCancel(
        db,
        request.params.id,
        accountId,
        requireAuth(request).user.id,
        request.body?.reason?.trim() || null,
      );
      return { result, order: await getOrder(db, request.params.id, { accountId, staff: false }) };
    },
  );

  app.post<{ Body: { orderId: string } }>(
    '/payments/session',
    {
      schema: {
        body: {
          type: 'object',
          required: ['orderId'],
          additionalProperties: false,
          properties: { orderId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const accountId = retailerAccountIdOf(request);
      return reply.status(201).send(await startPayment(db, payments, request.body.orderId, accountId));
    },
  );

  app.get<{ Params: { id: string } }>('/payments/:id/status', { schema: { params: idParams } }, async (request) => {
    const accountId = retailerAccountIdOf(request);
    const { rows } = await db.query(
      `SELECT p.id, p.status, p.amount_paise::int AS "amountPaise", o.id AS "orderId", o.payment_status AS "orderPaymentStatus"
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.id = $1 AND o.retailer_account_id = $2`,
      [request.params.id, accountId],
    );
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Payment not found');
    return rows[0];
  });
}
