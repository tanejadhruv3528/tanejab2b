import type { RetailerContext } from '@taneja/domain';
import type { FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { requireAuth } from './auth/plugin.js';
import type { Db } from './db.js';
import { AppError } from './errors.js';

type Queryable = Pick<Db, 'query'> | PoolClient;

/** The approved retailer account the caller is acting for. Ordering endpoints must use this, never a client-sent id. */
export function retailerAccountIdOf(request: FastifyRequest): string {
  const auth = requireAuth(request);
  const grant = auth.roles.find((r) => r.role === 'retailer' && r.retailerAccountId);
  if (!grant) throw new AppError('FORBIDDEN', 'Only approved retailers can do this');
  return grant.retailerAccountId!;
}

export async function loadRetailerContext(db: Queryable, accountId: string): Promise<RetailerContext> {
  const { rows } = await db.query<{
    status: RetailerContext['status'];
    cod_allowed: boolean;
    verified: boolean | null;
    service_zone: string | null;
    zones: string[];
  }>(
    `SELECT a.status, a.cod_allowed, s.verified, s.service_zone,
            coalesce((SELECT array(SELECT jsonb_array_elements_text(value)) FROM app_settings WHERE key = 'cod.service_zones'), '{}') AS zones
     FROM retailer_accounts a LEFT JOIN store_locations s ON s.retailer_account_id = a.id
     WHERE a.id = $1`,
    [accountId],
  );
  const r = rows[0];
  if (!r) throw new AppError('NOT_FOUND', 'Retailer account not found');
  const inZone = r.service_zone !== null && (r.zones.length === 0 || r.zones.includes(r.service_zone));
  return {
    status: r.status,
    storeVerified: r.verified === true,
    inCodServiceZone: inZone,
    codAllowedByAdmin: r.cod_allowed,
  };
}
