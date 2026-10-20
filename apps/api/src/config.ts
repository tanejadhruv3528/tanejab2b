import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((value) => value === 'true' || value === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((value) => /^postgres(ql)?:\/\//.test(value), 'DATABASE_URL must be a postgres:// URL'),
  DATABASE_SSL: booleanFromString,
  // Secret used to hash OTP codes. Must be long and random outside development/test.
  OTP_PEPPER: z.string().min(32, 'OTP_PEPPER must be at least 32 characters').optional(),
  // Only the clearly labelled development sender exists until a real SMS/DLT provider is chosen.
  SMS_PROVIDER: z.enum(['dev_console']).default('dev_console'),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  // Only local disk exists until a private object-storage bucket is chosen.
  DOCUMENT_STORAGE: z.enum(['local_disk']).default('local_disk'),
  DOCUMENT_STORAGE_DIR: z.string().min(1).default('.data/documents'),
});

// Fixed value so development and tests work without setup. Never valid outside development/test.
const DEV_OTP_PEPPER = 'dev-only-otp-pepper-not-for-production-use';

export type Config = {
  env: z.infer<typeof envSchema>['NODE_ENV'];
  host: string;
  port: number;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  databaseUrl: string;
  databaseSsl: boolean;
  otpPepper: string;
  smsProvider: 'dev_console';
  sessionTtlDays: number;
  documentStorage: 'local_disk';
  documentStorageDir: string;
};

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Validates environment variables once at startup and fails fast with every problem listed. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`Invalid environment configuration:\n  ${problems.join('\n  ')}`);
  }
  const e = parsed.data;
  const deployed = e.NODE_ENV === 'staging' || e.NODE_ENV === 'production';
  const problems: string[] = [];
  if (deployed && !e.OTP_PEPPER) problems.push('OTP_PEPPER: required in staging and production');
  if (deployed && e.SMS_PROVIDER === 'dev_console') {
    problems.push('SMS_PROVIDER: dev_console only prints OTPs to logs and cannot be used in staging or production');
  }
  if (deployed && e.DOCUMENT_STORAGE === 'local_disk') {
    problems.push('DOCUMENT_STORAGE: local_disk is for development only; KYC files need private object storage');
  }
  if (problems.length > 0) {
    throw new ConfigError(`Invalid environment configuration:\n  ${problems.join('\n  ')}`);
  }
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    databaseSsl: e.DATABASE_SSL,
    otpPepper: e.OTP_PEPPER ?? DEV_OTP_PEPPER,
    smsProvider: e.SMS_PROVIDER,
    sessionTtlDays: e.SESSION_TTL_DAYS,
    documentStorage: e.DOCUMENT_STORAGE,
    documentStorageDir: e.DOCUMENT_STORAGE_DIR,
  };
}
