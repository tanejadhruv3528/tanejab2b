import type { Pool, PoolClient } from 'pg';

export interface AuditEntry {
  actorUserId?: string | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
}

/**
 * Records a privileged change. Pass the transaction's client so the audit row commits or
 * rolls back together with the change it describes. Never put KYC documents or secrets in before/after.
 */
export async function writeAudit(db: Pool | PoolClient, entry: AuditEntry): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO audit_logs
       (actor_user_id, actor_role, action, entity_type, entity_id, before_state, after_state, reason, request_id, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      entry.actorUserId ?? null,
      entry.actorRole ?? null,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.reason ?? null,
      entry.requestId ?? null,
      entry.ipAddress ?? null,
    ],
  );
  return rows[0]!.id;
}
