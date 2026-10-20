import { parseStockCsv } from '@taneja/domain';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit.js';
import { hasRole, requireAuth, requireRole } from '../auth/plugin.js';
import { withTransaction, type Db } from '../db.js';
import { AppError } from '../errors.js';
import { applyStockSnapshot, type SnapshotResult } from '../inventory.js';

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

export async function inventoryRoutes(app: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;

  // text/csv is registered by the catalogue routes in their own scope, so register it here too.
  app.addContentTypeParser(['text/csv'], { parseAs: 'string', bodyLimit: MAX_IMPORT_BYTES }, (_req, body, done) =>
    done(null, body),
  );

  const canSync = requireRole('catalog_operator', 'super_admin');
  const canView = requireRole('catalog_operator', 'super_admin', 'picker_packer', 'procurement', 'support_operator');

  app.post<{ Querystring: { source: 'marg_export' | 'manual_count'; asOf: string; dryRun: boolean; filename?: string }; Body: string }>(
    '/admin/inventory/imports',
    {
      preHandler: canSync,
      bodyLimit: MAX_IMPORT_BYTES,
      schema: {
        querystring: {
          type: 'object',
          required: ['source', 'asOf'],
          additionalProperties: false,
          properties: {
            source: { type: 'string', enum: ['marg_export', 'manual_count'] },
            asOf: { type: 'string', format: 'date-time' },
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
      const asOf = new Date(request.query.asOf);
      if (asOf.getTime() > Date.now() + 5 * 60_000) {
        throw new AppError('VALIDATION_FAILED', 'asOf cannot be in the future');
      }
      let parsed: ReturnType<typeof parseStockCsv>;
      try {
        parsed = parseStockCsv(request.body);
      } catch (error) {
        throw new AppError('VALIDATION_FAILED', (error as Error).message);
      }
      const { source, dryRun, filename } = request.query;
      const total = parsed.rows.length + new Set(parsed.errors.filter((e) => e.line > 1).map((e) => e.line)).size;
      const rejected = parsed.errors.length > 0;

      const outcome = await withTransaction(db, async (client) => {
        // An older export must never overwrite newer stock.
        const latest = await client.query<{ as_of: Date | null }>(
          "SELECT max(as_of) AS as_of FROM inventory_sync_runs WHERE status = 'applied'",
        );
        const newer = latest.rows[0]?.as_of && latest.rows[0].as_of > asOf;
        const status = rejected || newer ? 'rejected' : dryRun ? 'validated' : 'applied';
        const errors = newer
          ? [{ line: 0, field: 'asOf', message: `A newer stock snapshot (${latest.rows[0]!.as_of!.toISOString()}) is already applied` }]
          : parsed.errors.slice(0, 500);

        const run = await client.query<{ id: string }>(
          `INSERT INTO inventory_sync_runs (source, filename, uploaded_by, as_of, dry_run, status, total_rows, errors)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [source, filename ?? null, auth.user.id, asOf, dryRun, status, total, JSON.stringify(errors)],
        );
        const runId = run.rows[0]!.id;
        let result: SnapshotResult = { applied: 0, unknownSkus: [], oversold: [] };
        if (status === 'applied') {
          result = await applyStockSnapshot(client, parsed.rows, { runId, asOf, actorUserId: auth.user.id });
          await client.query(
            'UPDATE inventory_sync_runs SET applied_rows = $2, unknown_skus = $3, oversold = $4 WHERE id = $1',
            [runId, result.applied, result.unknownSkus, JSON.stringify(result.oversold)],
          );
          await writeAudit(client, {
            actorUserId: auth.user.id,
            actorRole: hasRole(auth, 'catalog_operator') ? 'catalog_operator' : 'super_admin',
            action: 'inventory.sync.apply',
            entityType: 'inventory_sync_run',
            entityId: runId,
            after: { source, asOf: asOf.toISOString(), applied: result.applied, oversold: result.oversold.length },
            requestId: request.id,
            ipAddress: request.ip ?? null,
          });
        } else if (status === 'validated') {
          const known = await client.query<{ sku: string }>('SELECT sku FROM products WHERE sku = ANY($1::text[])', [
            [...new Set(parsed.rows.map((r) => r.sku))],
          ]);
          const knownSet = new Set(known.rows.map((r) => r.sku));
          result.unknownSkus = [...new Set(parsed.rows.map((r) => r.sku))].filter((s) => !knownSet.has(s));
        }
        return { runId, status, errors, ...result };
      });

      return reply.status(outcome.status === 'applied' ? 201 : 200).send({
        id: outcome.runId,
        status: outcome.status,
        dryRun,
        totalRows: total,
        validRows: parsed.rows.length,
        appliedRows: outcome.applied,
        unknownSkus: outcome.unknownSkus,
        oversold: outcome.oversold,
        errors: outcome.errors,
        errorCount: rejected ? parsed.errors.length : outcome.errors.length,
      });
    },
  );

  app.get('/admin/inventory/imports', { preHandler: canSync }, async () => {
    const { rows } = await db.query(
      `SELECT id, source, filename, as_of AS "asOf", dry_run AS "dryRun", status, total_rows AS "totalRows",
              applied_rows AS "appliedRows", cardinality(unknown_skus) AS "unknownSkuCount",
              jsonb_array_length(oversold) AS "oversoldCount", jsonb_array_length(errors) AS "errorCount",
              created_at AS "createdAt"
       FROM inventory_sync_runs ORDER BY created_at DESC LIMIT 50`,
    );
    return { items: rows };
  });

  app.get<{ Params: { productId: string } }>(
    '/admin/inventory/products/:productId',
    {
      preHandler: canView,
      schema: {
        params: { type: 'object', required: ['productId'], properties: { productId: { type: 'string', format: 'uuid' } } },
      },
    },
    async (request) => {
      const { rows } = await db.query(
        `SELECT id, batch_number AS "batchNumber", to_char(expiry_date, 'YYYY-MM-DD') AS "expiryDate",
                mrp_paise::int AS "mrpPaise", rate_paise::int AS "ratePaise", on_hand_qty AS "onHand",
                reserved_qty AS reserved, quarantined_qty AS quarantined, location, synced_at AS "syncedAt"
         FROM inventory_batches WHERE product_id = $1 ORDER BY expiry_date, batch_number`,
        [request.params.productId],
      );
      return { productId: request.params.productId, batches: rows };
    },
  );
}
