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
    });
  });

  it('parses explicit values', () => {
    const config = loadConfig({ ...base, NODE_ENV: 'production', PORT: '8080', DATABASE_SSL: 'true', LOG_LEVEL: 'warn' });
    expect(config).toMatchObject({ env: 'production', port: 8080, databaseSsl: true, logLevel: 'warn' });
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
