import type { FastifyError, FastifyInstance } from 'fastify';

/** Stable, client-facing error codes. Add new codes here; never rename existing ones. */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | 'OTP_INVALID'
  | 'OTP_EXPIRED'
  | 'OTP_TOO_MANY_ATTEMPTS'
  | 'ACCOUNT_DISABLED';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
  OTP_INVALID: 400,
  OTP_EXPIRED: 400,
  OTP_TOO_MANY_ATTEMPTS: 429,
  ACCOUNT_DISABLED: 403,
};

export class AppError extends Error {
  override name = 'AppError';
  readonly statusCode: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.statusCode = STATUS_BY_CODE[code];
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; requestId: string; details?: unknown };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const body: ErrorBody = {
      error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found`, requestId: request.id },
    };
    return reply.status(404).send(body);
  });

  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    let code: ErrorCode;
    let message: string;
    let details: unknown;

    if (error instanceof AppError) {
      ({ code, message, details } = error);
    } else if ('validation' in error && error.validation) {
      code = 'VALIDATION_FAILED';
      message = 'Request validation failed';
      details = error.validation;
    } else if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      code = error.statusCode === 404 ? 'NOT_FOUND' : error.statusCode === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST';
      message = error.message;
    } else {
      code = 'INTERNAL_ERROR';
      // Never leak internal error messages or stack traces to clients.
      message = 'Something went wrong. Please try again.';
    }

    const status = error instanceof AppError ? error.statusCode : code === 'INTERNAL_ERROR' ? 500 : (error.statusCode ?? 400);
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
    } else {
      request.log.info({ code, status }, 'request rejected');
    }

    const body: ErrorBody = { error: { code, message, requestId: request.id } };
    if (details !== undefined) body.error.details = details;
    return reply.status(status).send(body);
  });
}
