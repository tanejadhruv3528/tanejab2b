import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(base)).toEqual({
      env: 'development',
      host: '0.0.0.0',
      port: 3000,
      logLevel: 'info',
      databaseUrl: base.DATABASE_URL,
      databaseSsl: false,
      otpPepper: expect.any(String),
      smsProvider: 'dev_console',
      sessionTtlDays: 30,
      documentStorage: 'local_disk',
      documentStorageDir: '.data/documents',
    });
  });

  it('parses explicit values', () => {
    const config = loadConfig({ ...base, NODE_ENV: 'test', PORT: '8080', DATABASE_SSL: 'true', LOG_LEVEL: 'warn' });
    expect(config).toMatchObject({ env: 'test', port: 8080, databaseSsl: true, logLevel: 'warn' });
  });

  it('requires a real OTP pepper and refuses the dev SMS sender in staging and production', () => {
    for (const NODE_ENV of ['staging', 'production']) {
      expect(() => loadConfig({ ...base, NODE_ENV })).toThrow(/OTP_PEPPER: required/);
      expect(() => loadConfig({ ...base, NODE_ENV, OTP_PEPPER: 'x'.repeat(40) })).toThrow(/dev_console/);
      expect(() => loadConfig({ ...base, NODE_ENV, OTP_PEPPER: 'x'.repeat(40) })).toThrow(/local_disk/);
    }
  });

  it('rejects a short OTP pepper', () => {
    expect(() => loadConfig({ ...base, OTP_PEPPER: 'short' })).toThrow(/at least 32/);
  });

  it('fails fast listing every problem', () => {
    expect(() => loadConfig({ PORT: 'abc', NODE_ENV: 'prod' })).toThrow(ConfigError);
    try {
      loadConfig({ PORT: 'abc', NODE_ENV: 'prod' });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('PORT');
      expect(message).toContain('NODE_ENV');
    }
  });

  it('rejects non-postgres database URLs', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://localhost/db' })).toThrow(/postgres/);
  });
});
