import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit.js';
import { requireAuth, requireRole } from '../auth/plugin.js';
import { withTransaction, type Db } from '../db.js';
import { AppError } from '../errors.js';

interface RuleRow {
  id: string;
  kind: string;
  min_subtotal_paise: string;
  discount_bps: number;
  status: string;
  note: string | null;
  created_at: Date;
}

function toView(r: RuleRow) {
  return {
    id: r.id,
    kind: r.kind,
    minSubtotalPaise: Number(r.min_subtotal_paise),
    discountBps: r.discount_bps,
    status: r.status,
    note: r.note,
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * Discount slab rules. Catalogue operators can draft a rule, but only a super admin can activate one,
 * and active rules still have no effect while the pricing.discounts_enabled setting is off.
 */
export async function adminPricingRoutes(app: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;
  const canView = requireRole('super_admin', 'catalog_operator', 'finance_admin');
  const canDraft = requireRole('super_admin', 'catalog_operator');
  const canActivate = requireRole('super_admin');

  app.get('/admin/pricing/rules', { preHandler: canView }, async () => {
    const { rows } = await db.query<RuleRow>('SELECT * FROM pricing_rules ORDER BY status, min_subtotal_paise');
    const enabled = await db.query<{ value: unknown }>(
      "SELECT value FROM app_settings WHERE key = 'pricing.discounts_enabled'",
    );
    return { discountsEnabled: enabled.rows[0]?.value === true, rules: rows.map(toView) };
  });

  app.post<{ Body: { minSubtotalPaise: number; discountBps: number; note?: string } }>(
    '/admin/pricing/rules',
    {
      preHandler: canDraft,
      schema: {
        body: {
          type: 'object',
          required: ['minSubtotalPaise', 'discountBps'],
          additionalProperties: false,
          properties: {
            minSubtotalPaise: { type: 'integer', minimum: 0, maximum: 100_000_000_00 },
            discountBps: { type: 'integer', minimum: 0, maximum: 5000 },
            note: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { minSubtotalPaise, discountBps, note } = request.body;
      const rule = await withTransaction(db, async (client) => {
        const { rows } = await client.query<RuleRow>(
          `INSERT INTO pricing_rules (kind, min_subtotal_paise, discount_bps, note, created_by)
           VALUES ('order_value_slab', $1, $2, $3, $4) RETURNING *`,
          [minSubtotalPaise, discountBps, note ?? null, auth.user.id],
        );
        const view = toView(rows[0]!);
        await writeAudit(client, {
          actorUserId: auth.user.id,
          action: 'pricing_rule.create',
          entityType: 'pricing_rule',
          entityId: view.id,
          after: view,
          requestId: request.id,
          ipAddress: request.ip,
        });
        return view;
      });
      return reply.status(201).send({ rule });
    },
  );

  app.post<{ Params: { id: string }; Body: { status: 'active' | 'retired'; reason: string } }>(
    '/admin/pricing/rules/:id/status',
    {
      preHandler: canActivate,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          required: ['status', 'reason'],
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['active', 'retired'] },
            reason: { type: 'string', minLength: 3, maxLength: 500 },
          },
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { status, reason } = request.body;
      const rule = await withTransaction(db, async (client) => {
        const { rows } = await client.query<RuleRow>('SELECT * FROM pricing_rules WHERE id = $1 FOR UPDATE', [
          request.params.id,
        ]);
        const before = rows[0];
        if (!before) throw new AppError('NOT_FOUND', 'Pricing rule not found');
        if (before.status === 'retired') throw new AppError('CONFLICT', 'A retired rule cannot be changed');
        if (before.status === status) throw new AppError('CONFLICT', `Rule is already ${status}`);
        if (status === 'active') {
          const clash = await client.query(
            `SELECT 1 FROM pricing_rules WHERE status = 'active' AND kind = $1 AND min_subtotal_paise = $2`,
            [before.kind, before.min_subtotal_paise],
          );
          if (clash.rowCount) throw new AppError('CONFLICT', 'Another active rule already uses this threshold');
        }
        const updated = await client.query<RuleRow>(
          'UPDATE pricing_rules SET status = $2, updated_at = now() WHERE id = $1 RETURNING *',
          [before.id, status],
        );
        const after = toView(updated.rows[0]!);
        await writeAudit(client, {
          actorUserId: auth.user.id,
          action: `pricing_rule.${status === 'active' ? 'activate' : 'retire'}`,
          entityType: 'pricing_rule',
          entityId: before.id,
          before: toView(before),
          after,
          reason,
          requestId: request.id,
          ipAddress: request.ip,
        });
        return after;
      });
      return { rule };
    },
  );
}
