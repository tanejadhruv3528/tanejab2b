import type { FastifyInstance } from 'fastify';
import { requestOtp, verifyOtp } from '../auth/otp.js';
import { requireAuth } from '../auth/plugin.js';
import { createSessionForPhone, revokeSession } from '../auth/sessions.js';
import type { SmsSender } from '../auth/sms.js';
import type { Db } from '../db.js';

export interface AuthRouteOptions {
  db: Db;
  sms: SmsSender;
  otpPepper: string;
  sessionTtlDays: number;
}

const phoneBody = {
  type: 'object',
  required: ['phone'],
  additionalProperties: false,
  properties: { phone: { type: 'string', minLength: 10, maxLength: 20 } },
} as const;

export async function authRoutes(app: FastifyInstance, opts: AuthRouteOptions): Promise<void> {
  const otpDeps = { db: opts.db, sms: opts.sms, pepper: opts.otpPepper };

  app.post<{ Body: { phone: string } }>('/auth/otp/request', { schema: { body: phoneBody } }, async (request, reply) => {
    const result = await requestOtp(otpDeps, request.body.phone, request.ip ?? null);
    return reply.status(202).send(result);
  });

  app.post<{ Body: { phone: string; code: string } }>(
    '/auth/otp/verify',
    {
      schema: {
        body: {
          type: 'object',
          required: ['phone', 'code'],
          additionalProperties: false,
          properties: {
            phone: { type: 'string', minLength: 10, maxLength: 20 },
            code: { type: 'string', minLength: 6, maxLength: 6 },
          },
        },
      },
    },
    async (request) => {
      const phone = await verifyOtp(otpDeps, request.body.phone, request.body.code);
      const { token, expiresAt, auth } = await createSessionForPhone(opts.db, phone, {
        ttlDays: opts.sessionTtlDays,
        userAgent: request.headers['user-agent'] ?? null,
        ip: request.ip ?? null,
      });
      return { token, expiresAt: expiresAt.toISOString(), user: auth.user, roles: auth.roles };
    },
  );

  app.post('/auth/logout', async (request, reply) => {
    const auth = requireAuth(request);
    await revokeSession(opts.db, auth.sessionId);
    return reply.status(204).send();
  });

  app.get('/me', async (request) => {
    const auth = requireAuth(request);
    return { user: auth.user, roles: auth.roles };
  });

  app.patch<{ Body: { name?: string; language?: 'en' | 'hi' } }>(
    '/me',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            language: { type: 'string', enum: ['en', 'hi'] },
          },
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { rows } = await opts.db.query(
        `UPDATE users SET name = coalesce($2, name), language = coalesce($3, language), updated_at = now()
         WHERE id = $1
         RETURNING id, phone, name, email, language, status`,
        [auth.user.id, request.body.name?.trim() ?? null, request.body.language ?? null],
      );
      return { user: rows[0], roles: auth.roles };
    },
  );
}
