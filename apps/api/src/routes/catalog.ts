import { parseCatalogCsv } from '@taneja/domain';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit.js';
import { hasRole, requireAuth, requireRole } from '../auth/plugin.js';
import type { Role } from '../auth/sessions.js';
import { getProduct, searchProducts, upsertProducts } from '../catalog.js';
import { withTransaction, type Db } from '../db.js';
import { loadAvailabilityPolicy } from '../inventory.js';
import { AppError } from '../errors.js';

const STAFF_CATALOG_READERS: Role[] = [
  'super_admin',
  'catalog_operator',
  'support_operator',
  'picker_packer',
  'billing_operator',
  'procurement',
  'kyc_reviewer',
  'dispatcher',
  'finance_admin',
];

/** Authorised data sources only. There is deliberately no option for scraped third-party sites. */
export const CATALOG_SOURCES = ['marg_export', 'manufacturer_list', 'distributor_list', 'manual_entry'] as const;

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const MAX_IMPORT_ROWS = 50_000;

export async function catalogRoutes(app: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;

  app.addContentTypeParser(['text/csv'], { parseAs: 'string', bodyLimit: MAX_IMPORT_BYTES }, (_req, body, done) =>
    done(null, body),
  );

  const canRead = requireRole('retailer', ...STAFF_CATALOG_READERS);

  app.get<{ Querystring: { q: string; limit: number; offset: number } }>(
    '/catalog/search',
    {
      preHandler: canRead,
      schema: {
        querystring: {
          type: 'object',
          required: ['q'],
          additionalProperties: false,
          properties: {
            q: { type: 'string', minLength: 2, maxLength: 100 },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
            offset: { type: 'integer', minimum: 0, maximum: 1000, default: 0 },
          },
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { q, limit, offset } = request.query;
      const staff = hasRole(auth, ...STAFF_CATALOG_READERS);
      const items = await searchProducts(db, {
        query: q,
        limit,
        offset,
        includeDiscontinued: staff,
        includeQuantities: staff,
        policy: await loadAvailabilityPolicy(db),
      });
      return { items, limit, offset };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/catalog/products/:id',
    {
      preHandler: canRead,
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
    },
    async (request) => {
      const auth = requireAuth(request);
      const staff = hasRole(auth, ...STAFF_CATALOG_READERS);
      const product = await getProduct(db, request.params.id, {
        policy: await loadAvailabilityPolicy(db),
        includeQuantities: staff,
      });
      if (!product || (product.status === 'discontinued' && !staff)) {
        throw new AppError('NOT_FOUND', 'Product not found');
      }
      return product;
    },
  );

  const canManage = requireRole('catalog_operator', 'super_admin');

  app.post<{ Querystring: { source: string; dryRun: boolean; filename?: string }; Body: string }>(
    '/admin/catalog/imports',
    {
      preHandler: canManage,
      bodyLimit: MAX_IMPORT_BYTES,
      schema: {
        querystring: {
          type: 'object',
          required: ['source'],
          additionalProperties: false,
          properties: {
            source: { type: 'string', enum: [...CATALOG_SOURCES] },
            dryRun: { type: 'boolean', default: true },
            filename: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      if (typeof request.body !== 'string' || request.body.trim() === '') {
        throw new AppError('BAD_REQUEST', 'Send the CSV file as the request body with Content-Type text/csv');
      }
      let parsed: ReturnType<typeof parseCatalogCsv>;
      try {
        parsed = parseCatalogCsv(request.body);
      } catch (error) {
        throw new AppError('VALIDATION_FAILED', (error as Error).message);
      }
      const total = parsed.rows.length + new Set(parsed.errors.filter((e) => e.line > 1).map((e) => e.line)).size;
      if (total > MAX_IMPORT_ROWS) {
        throw new AppError('VALIDATION_FAILED', `Split the file: at most ${MAX_IMPORT_ROWS} rows per import`);
      }
      const { source, dryRun, filename } = request.query;
      // A file with any error is never partly applied.
      const status = parsed.errors.length > 0 ? 'rejected' : dryRun ? 'validated' : 'applied';

      const result = await withTransaction(db, async (client) => {
        const run = await client.query<{ id: string }>(
          `INSERT INTO catalog_import_runs (source, filename, uploaded_by, dry_run, status, total_rows, valid_rows, errors)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [source, filename ?? null, auth.user.id, dryRun, status, total, parsed.rows.length, JSON.stringify(parsed.errors.slice(0, 500))],
        );
        const runId = run.rows[0]!.id;
        let counts = { created: 0, updated: 0 };
        if (status === 'applied') {
          counts = await upsertProducts(client, parsed.rows, source, runId);
          await client.query('UPDATE catalog_import_runs SET created_count = $2, updated_count = $3 WHERE id = $1', [
            runId,
            counts.created,
            counts.updated,
          ]);
          await writeAudit(client, {
            actorUserId: auth.user.id,
            actorRole: hasRole(auth, 'catalog_operator') ? 'catalog_operator' : 'super_admin',
            action: 'catalog.import.apply',
            entityType: 'catalog_import_run',
            entityId: runId,
            after: { source, filename: filename ?? null, ...counts },
            requestId: request.id,
            ipAddress: request.ip ?? null,
          });
        }
        return { runId, ...counts };
      });

      return reply.status(status === 'applied' ? 201 : 200).send({
        id: result.runId,
        status,
        dryRun,
        totalRows: total,
        validRows: parsed.rows.length,
        created: result.created,
        updated: result.updated,
        errors: parsed.errors.slice(0, 500),
        errorCount: parsed.errors.length,
      });
    },
  );

  app.get('/admin/catalog/imports', { preHandler: canManage }, async () => {
    const { rows } = await db.query(
      `SELECT r.id, r.source, r.filename, r.dry_run AS "dryRun", r.status, r.total_rows AS "totalRows",
              r.valid_rows AS "validRows", r.created_count AS created, r.updated_count AS updated,
              jsonb_array_length(r.errors) AS "errorCount", r.created_at AS "createdAt", u.name AS "uploadedBy"
       FROM catalog_import_runs r JOIN users u ON u.id = r.uploaded_by
       ORDER BY r.created_at DESC LIMIT 50`,
    );
    return { items: rows };
  });

  app.patch<{ Params: { id: string }; Body: { status: 'active' | 'restricted' | 'discontinued'; reason: string } }>(
    '/admin/catalog/products/:id',
    {
      preHandler: canManage,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          required: ['status', 'reason'],
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['active', 'restricted', 'discontinued'] },
            reason: { type: 'string', minLength: 3, maxLength: 500 },
          },
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await withTransaction(db, async (client) => {
        const { rows } = await client.query<{ status: string }>('SELECT status FROM products WHERE id = $1 FOR UPDATE', [
          request.params.id,
        ]);
        if (!rows[0]) throw new AppError('NOT_FOUND', 'Product not found');
        await client.query('UPDATE products SET status = $2, updated_at = now() WHERE id = $1', [
          request.params.id,
          request.body.status,
        ]);
        await writeAudit(client, {
          actorUserId: auth.user.id,
          actorRole: hasRole(auth, 'catalog_operator') ? 'catalog_operator' : 'super_admin',
          action: 'catalog.product.status',
          entityType: 'product',
          entityId: request.params.id,
          before: { status: rows[0].status },
          after: { status: request.body.status },
          reason: request.body.reason,
          requestId: request.id,
          ipAddress: request.ip ?? null,
        });
      });
      return getProduct(db, request.params.id, { policy: await loadAvailabilityPolicy(db), includeQuantities: true });
    },
  );
}
