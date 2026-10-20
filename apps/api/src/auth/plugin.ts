import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Db } from '../db.js';
import { AppError } from '../errors.js';
import { authenticateToken, type AuthContext, type Role } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

/** Resolves `Authorization: Bearer <token>` on every request. Routes opt in to requiring it. */
export function registerAuth(app: FastifyInstance, db: Db): void {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    const header = request.headers.authorization;
    if (!header) return;
    const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header);
    if (!match) throw new AppError('UNAUTHENTICATED', 'Malformed authorization header');
    request.auth = await authenticateToken(db, match[1]!);
    if (!request.auth) throw new AppError('UNAUTHENTICATED', 'Session expired. Please log in again.');
  });
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new AppError('UNAUTHENTICATED', 'Please log in');
  return request.auth;
}

export function hasRole(auth: AuthContext, ...roles: Role[]): boolean {
  return auth.roles.some((grant) => roles.includes(grant.role));
}

/** preHandler that allows the request only if the user holds at least one of `roles`. */
export function requireRole(...roles: Role[]): preHandlerAsyncHookHandler {
  return async (request) => {
    const auth = requireAuth(request);
    if (!hasRole(auth, ...roles)) {
      throw new AppError('FORBIDDEN', 'You do not have permission to do this');
    }
  };
}
