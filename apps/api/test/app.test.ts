import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db.js';
import { AppError } from '../src/errors.js';

function fakeDb(query: () => Promise<unknown>): Db {
  return { query } as unknown as Db;
}

const healthyDb = fakeDb(async () => ({ rows: [{ latest: '0001_foundation.sql' }] }));

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('health', () => {
  it('reports liveness without touching the database', async () => {
    app = await buildApp({ db: fakeDb(async () => { throw new Error('should not be called'); }) });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('reports readiness with the latest migration', async () => {
    app = await buildApp({ db: healthyDb });
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.database).toMatchObject({ status: 'ok', latestMigration: '0001_foundation.sql' });
  });

  it('returns 503 when the database is unreachable', async () => {
    app = await buildApp({ db: fakeDb(async () => { throw new Error('connection refused'); }) });
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('connection refused');
  });
});

describe('errors and headers', () => {
  it('returns a stable error shape for unknown routes', async () => {
    app = await buildApp({ db: healthyDb });
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: 'NOT_FOUND', requestId: res.headers['x-request-id'] });
  });

  it('echoes a well-formed incoming request id and replaces a malformed one', async () => {
    app = await buildApp({ db: healthyDb });
    const good = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'abc12345-req' } });
    expect(good.headers['x-request-id']).toBe('abc12345-req');
    const bad = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': '<script>' } });
    expect(bad.headers['x-request-id']).not.toBe('<script>');
  });

  it('sets defensive headers', async () => {
    app = await buildApp({ db: healthyDb });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('maps AppError to its status and code', async () => {
    app = await buildApp({ db: healthyDb });
    app.get('/forbidden', async () => {
      throw new AppError('FORBIDDEN', 'Not allowed');
    });
    const res = await app.inject({ method: 'GET', url: '/forbidden' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({ code: 'FORBIDDEN', message: 'Not allowed' });
  });

  it('hides internal error details', async () => {
    app = await buildApp({ db: healthyDb });
    app.get('/boom', async () => {
      throw new Error('secret connection string leaked');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL_ERROR');
    expect(res.body).not.toContain('secret');
  });

  it('reports schema validation failures as VALIDATION_FAILED', async () => {
    app = await buildApp({ db: healthyDb });
    app.post(
      '/echo',
      { schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } },
      async (request) => request.body,
    );
    const res = await app.inject({ method: 'POST', url: '/echo', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });
});
