import type { PoolClient } from 'pg';
import { writeAudit } from './audit.js';
import { revokeAllSessions, type Role } from './auth/sessions.js';
import { AppError } from './errors.js';

/** Roles that staff can grant directly. `retailer` is only granted by KYC approval. */
export const GRANTABLE_ROLES: readonly Role[] = [
  'kyc_reviewer',
  'support_operator',
  'catalog_operator',
  'picker_packer',
  'billing_operator',
  'procurement',
  'dispatcher',
  'rider',
  'finance_admin',
  'super_admin',
];

export interface Actor {
  userId: string | null;
  role: string | null;
  requestId?: string | null;
  ip?: string | null;
}

export async function grantRole(client: PoolClient, actor: Actor, userId: string, role: Role, reason?: string) {
  if (!GRANTABLE_ROLES.includes(role)) {
    throw new AppError('BAD_REQUEST', `Role ${role} cannot be granted directly`);
  }
  const user = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (user.rowCount === 0) throw new AppError('NOT_FOUND', 'User not found');
  const inserted = await client.query(
    `INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING RETURNING id`,
    [userId, role, actor.userId],
  );
  if (inserted.rowCount === 0) return { changed: false };
  await writeAudit(client, {
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: 'user.role.grant',
    entityType: 'user',
    entityId: userId,
    after: { role },
    reason: reason ?? null,
    requestId: actor.requestId ?? null,
    ipAddress: actor.ip ?? null,
  });
  return { changed: true };
}

export async function revokeRole(client: PoolClient, actor: Actor, userId: string, role: Role, reason?: string) {
  if (role === 'super_admin' && actor.userId === userId) {
    throw new AppError('CONFLICT', 'You cannot remove your own super_admin role');
  }
  if (role === 'super_admin') {
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM user_roles WHERE role = 'super_admin'",
    );
    if ((rows[0]?.n ?? 0) <= 1) throw new AppError('CONFLICT', 'At least one super_admin must remain');
  }
  const deleted = await client.query(
    'DELETE FROM user_roles WHERE user_id = $1 AND role = $2 AND scope_retailer_account_id IS NULL RETURNING id',
    [userId, role],
  );
  if (deleted.rowCount === 0) return { changed: false };
  await writeAudit(client, {
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: 'user.role.revoke',
    entityType: 'user',
    entityId: userId,
    before: { role },
    reason: reason ?? null,
    requestId: actor.requestId ?? null,
    ipAddress: actor.ip ?? null,
  });
  return { changed: true };
}

export async function setUserStatus(
  client: PoolClient,
  actor: Actor,
  userId: string,
  status: 'active' | 'disabled',
  reason: string,
) {
  if (status === 'disabled' && actor.userId === userId) {
    throw new AppError('CONFLICT', 'You cannot disable your own account');
  }
  const { rows } = await client.query<{ status: string }>('SELECT status FROM users WHERE id = $1 FOR UPDATE', [userId]);
  const current = rows[0];
  if (!current) throw new AppError('NOT_FOUND', 'User not found');
  if (current.status === status) return { changed: false };
  await client.query('UPDATE users SET status = $2, updated_at = now() WHERE id = $1', [userId, status]);
  if (status === 'disabled') await revokeAllSessions(client, userId);
  await writeAudit(client, {
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: status === 'disabled' ? 'user.disable' : 'user.enable',
    entityType: 'user',
    entityId: userId,
    before: { status: current.status },
    after: { status },
    reason,
    requestId: actor.requestId ?? null,
    ipAddress: actor.ip ?? null,
  });
  return { changed: true };
}
