import type { FastifyServerOptions } from 'fastify';
import type { Config } from './config.js';

/**
 * Paths that must never reach logs: auth tokens, OTPs, KYC/licence documents and payment data.
 * Extend this list whenever a new sensitive field is introduced.
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.otp',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.licenseDocument',
  '*.documentBase64',
  '*.cardNumber',
  '*.cvv',
];

export function loggerOptions(config: Pick<Config, 'env' | 'logLevel'>): FastifyServerOptions['logger'] {
  return {
    level: config.logLevel,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    ...(config.env === 'development'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:standard', ignore: 'pid,hostname' } } }
      : {}),
  };
}
