import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { registerAuth } from './auth/plugin.js';
import type { SmsSender } from './auth/sms.js';
import type { Db } from './db.js';
import { registerErrorHandling } from './errors.js';
import { adminKycRoutes } from './routes/admin-kyc.js';
import { adminOrderRoutes } from './routes/admin-orders.js';
import { adminPricingRoutes } from './routes/admin-pricing.js';
import { adminUserRoutes } from './routes/admin-users.js';
import { authRoutes } from './routes/auth.js';
import { cartRoutes } from './routes/cart.js';
import { catalogRoutes } from './routes/catalog.js';
import { deliveryRoutes } from './routes/delivery.js';
import { healthRoutes } from './routes/health.js';
import { inventoryRoutes } from './routes/inventory.js';
import { orderRoutes } from './routes/orders.js';
import { paymentWebhookRoutes } from './routes/payment-webhooks.js';
import { procurementRoutes } from './routes/procurement.js';
import { retailerRoutes } from './routes/retailer.js';
import { returnRoutes } from './routes/returns.js';
import { warehouseRoutes } from './routes/warehouse.js';
import { NoPaymentProvider, type PaymentProvider } from './payments.js';
import type { DocumentStore } from './storage.js';

export interface AppDeps {
  db: Db;
  sms: SmsSender;
  documents: DocumentStore;
  otpPepper: string;
  sessionTtlDays: number;
  /** Defaults to no provider: prepaid checkout is refused until one is chosen. */
  payments?: PaymentProvider;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    },
    bodyLimit: 1_048_576,
    // Reject unknown fields instead of silently dropping them.
    ajv: { customOptions: { removeAdditional: false } },
    trustProxy: true,
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'no-store');
  });

  registerErrorHandling(app);
  registerAuth(app, deps.db);
  await app.register(healthRoutes, { db: deps.db });
  await app.register(authRoutes, {
    db: deps.db,
    sms: deps.sms,
    otpPepper: deps.otpPepper,
    sessionTtlDays: deps.sessionTtlDays,
  });
  await app.register(adminUserRoutes, { db: deps.db });
  await app.register(retailerRoutes, { db: deps.db, documents: deps.documents });
  await app.register(adminKycRoutes, { db: deps.db, documents: deps.documents });
  await app.register(catalogRoutes, { db: deps.db });
  await app.register(inventoryRoutes, { db: deps.db });
  await app.register(adminPricingRoutes, { db: deps.db });
  const payments = deps.payments ?? new NoPaymentProvider();
  await app.register(cartRoutes, { db: deps.db, payments });
  await app.register(orderRoutes, { db: deps.db, payments });
  await app.register(paymentWebhookRoutes, { db: deps.db, payments });
  await app.register(adminOrderRoutes, { db: deps.db });
  await app.register(warehouseRoutes, { db: deps.db });
  await app.register(procurementRoutes, { db: deps.db });
  await app.register(returnRoutes, { db: deps.db, documents: deps.documents });
  await app.register(deliveryRoutes, { db: deps.db, sms: deps.sms, otpPepper: deps.otpPepper });

  return app;
}
