import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { registerAuth } from './auth/plugin.js';
import type { SmsSender } from './auth/sms.js';
import type { Db } from './db.js';
import { registerErrorHandling } from './errors.js';
import { adminUserRoutes } from './routes/admin-users.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';

export interface AppDeps {
  db: Db;
  sms: SmsSender;
  otpPepper: string;
  sessionTtlDays: number;
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

  return app;
}
