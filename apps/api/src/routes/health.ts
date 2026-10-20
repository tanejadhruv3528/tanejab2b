import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';

// src/routes and dist/routes are both two levels below package.json.
const VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

export async function healthRoutes(app: FastifyInstance, opts: { db: Db }): Promise<void> {
  // Liveness: the process is up. Never touches dependencies.
  app.get('/health', async () => ({ status: 'ok', version: VERSION }));

  // Readiness: dependencies are reachable and migrations have been applied.
  app.get('/health/ready', async (request, reply) => {
    const started = Date.now();
    try {
      const result = await opts.db.query<{ latest: string | null }>(
        'SELECT max(name) AS latest FROM schema_migrations',
      );
      return {
        status: 'ok',
        checks: {
          database: { status: 'ok', latencyMs: Date.now() - started, latestMigration: result.rows[0]?.latest ?? null },
        },
      };
    } catch (error) {
      request.log.warn({ err: error }, 'readiness check failed');
      return reply.status(503).send({ status: 'unavailable', checks: { database: { status: 'error' } } });
    }
  });
}
