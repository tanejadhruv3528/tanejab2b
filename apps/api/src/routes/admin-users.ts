import type { FastifyInstance, FastifyRequest } from 'fastify';
import { writeAudit } from '../audit.js';
import { parsePhone } from '../auth/otp.js';
import { requireAuth, requireRole } from '../auth/plugin.js';
import { loadRoles, type Role } from '../auth/sessions.js';
import { withTransaction, type Db } from '../db.js';
import { AppError } from '../errors.js';
import { GRANTABLE_ROLES, grantRole, revokeRole, setUserStatus, type Actor } from '../users.js';

const uuidParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

function actorFrom(request: FastifyRequest): Actor {
  const auth = requireAuth(request);
  return { userId: auth.user.id, role: 'super_admin', requestId: request.id, ip: request.ip ?? null };
}

async function userWithRoles(db: Db, id: string) {
  const { rows } = await db.query(
    'SELECT id, phone, name, email, language, status, created_at, last_login_at FROM users WHERE id = $1',
    [id],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND', 'User not found');
  return { user: rows[0], roles: await loadRoles(db, id) };
}

export async function adminUserRoutes(app: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;
  app.addHook('preHandler', requireRole('super_admin'));

  app.get<{ Querystring: { phone?: string; role?: Role; limit: number; offset: number } }>(
    '/admin/users',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            phone: { type: 'string', maxLength: 20 },
            role: { type: 'string', maxLength: 40 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
      },
    },
    async (request) => {
      const { phone, role, limit, offset } = request.query;
      const normalized = phone ? parsePhone(phone) : null;
      const { rows } = await db.query(
        `SELECT u.id, u.phone, u.name, u.status, u.last_login_at,
                coalesce(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
         FROM users u LEFT JOIN user_roles r ON r.user_id = u.id
         WHERE ($1::text IS NULL OR u.phone = $1)
           AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM user_roles x WHERE x.user_id = u.id AND x.role = $2))
         GROUP BY u.id
         ORDER BY u.created_at DESC
         LIMIT $3 OFFSET $4`,
        [normalized, role ?? null, limit, offset],
      );
      return { items: rows, limit, offset };
    },
  );

  // Pre-registers a staff member so roles can be granted before their first login.
  app.post<{ Body: { phone: string; name?: string } }>(
    '/admin/users',
    {
      schema: {
        body: {
          type: 'object',
          required: ['phone'],
          additionalProperties: false,
          properties: {
            phone: { type: 'string', minLength: 10, maxLength: 20 },
            name: { type: 'string', minLength: 1, maxLength: 120 },
          },
        },
      },
    },
    async (request, reply) => {
      const phone = parsePhone(request.body.phone);
      const actor = actorFrom(request);
      const id = await withTransaction(db, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          'INSERT INTO users (phone, name) VALUES ($1, $2) ON CONFLICT (phone) DO NOTHING RETURNING id',
          [phone, request.body.name ?? null],
        );
        if (!rows[0]) throw new AppError('CONFLICT', 'A user with this phone already exists');
        await writeAudit(client, {
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: 'user.create',
          entityType: 'user',
          entityId: rows[0].id,
          after: { phone, name: request.body.name ?? null },
          requestId: actor.requestId ?? null,
          ipAddress: actor.ip ?? null,
        });
        return rows[0].id;
      });
      return reply.status(201).send(await userWithRoles(db, id));
    },
  );

  app.get<{ Params: { id: string } }>('/admin/users/:id', { schema: { params: uuidParam } }, async (request) =>
    userWithRoles(db, request.params.id),
  );

  app.post<{ Params: { id: string }; Body: { role: Role; reason?: string } }>(
    '/admin/users/:id/roles',
    {
      schema: {
        params: uuidParam,
        body: {
          type: 'object',
          required: ['role'],
          additionalProperties: false,
          properties: {
            role: { type: 'string', enum: [...GRANTABLE_ROLES] },
            reason: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request) => {
      const actor = actorFrom(request);
      await withTransaction(db, (client) =>
        grantRole(client, actor, request.params.id, request.body.role, request.body.reason),
      );
      return userWithRoles(db, request.params.id);
    },
  );

  app.delete<{ Params: { id: string; role: Role } }>(
    '/admin/users/:id/roles/:role',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'role'],
          properties: { id: { type: 'string', format: 'uuid' }, role: { type: 'string', enum: [...GRANTABLE_ROLES] } },
        },
      },
    },
    async (request) => {
      const actor = actorFrom(request);
      await withTransaction(db, (client) => revokeRole(client, actor, request.params.id, request.params.role));
      return userWithRoles(db, request.params.id);
    },
  );

  app.post<{ Params: { id: string }; Body: { status: 'active' | 'disabled'; reason: string } }>(
    '/admin/users/:id/status',
    {
      schema: {
        params: uuidParam,
        body: {
          type: 'object',
          required: ['status', 'reason'],
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['active', 'disabled'] },
            reason: { type: 'string', minLength: 3, maxLength: 500 },
          },
        },
      },
    },
    async (request) => {
      const actor = actorFrom(request);
      await withTransaction(db, (client) =>
        setUserStatus(client, actor, request.params.id, request.body.status, request.body.reason),
      );
      return userWithRoles(db, request.params.id);
    },
  );
}
