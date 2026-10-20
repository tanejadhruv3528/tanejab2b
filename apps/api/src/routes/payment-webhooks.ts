import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { AppError } from '../errors.js';
import { applyPaymentEvent } from '../orders.js';
import type { PaymentProvider } from '../payments.js';

/**
 * Provider callbacks. Unauthenticated by design: trust comes only from the provider's signature
 * over the raw body, so this scope parses JSON as raw bytes.
 */
export async function paymentWebhookRoutes(app: FastifyInstance, opts: { db: Db; payments: PaymentProvider }): Promise<void> {
  const { db, payments } = opts;
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 64 * 1024 }, (_req, body, done) =>
    done(null, body),
  );

  app.post<{ Params: { provider: string }; Body: Buffer }>(
    '/payments/webhooks/:provider',
    { schema: { params: { type: 'object', properties: { provider: { type: 'string', maxLength: 40 } } } } },
    async (request) => {
      if (!payments.enabled || request.params.provider !== payments.name) {
        throw new AppError('NOT_FOUND', 'Unknown payment provider');
      }
      if (!Buffer.isBuffer(request.body)) throw new AppError('BAD_REQUEST', 'Expected a JSON body');
      const event = payments.parseWebhook(request.headers, request.body);
      const outcome = await applyPaymentEvent(db, payments.name, event);
      request.log.info({ provider: payments.name, eventId: event.eventId, outcome }, 'payment webhook');
      return { received: true, outcome };
    },
  );
}
