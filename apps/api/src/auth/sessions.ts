import type { Db } from '../db.js';
import { withTransaction } from '../db.js';
import { AppError } from '../errors.js';
import { generateSessionToken, hashSessionToken } from './tokens.js';

export type Role =
  | 'retailer'
  | 'kyc_reviewer'
  | 'support_operator'
  | 'catalog_operator'
  | 'picker_packer'
  | 'billing_operator'
  | 'procurement'
  | 'dispatcher'
  | 'rider'
  | 'finance_admin'
  | 'super_admin';

export interface RoleGrant {
  role: Role;
  retailerAccountId: string | null;
}

export interface AuthUser {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  language: 'en' | 'hi';
  status: 'active' | 'disabled';
}

export interface AuthContext {
  user: AuthUser;
  roles: RoleGrant[];
  sessionId: string;
}

const USER_COLUMNS = 'u.id, u.phone, u.name, u.email, u.language, u.status';

export async function loadRoles(db: Pick<Db, 'query'>, userId: string): Promise<RoleGrant[]> {
  const { rows } = await db.query<{ role: Role; scope_retailer_account_id: string | null }>(
    'SELECT role, scope_retailer_account_id FROM user_roles WHERE user_id = $1 ORDER BY role',
    [userId],
  );
  return rows.map((r) => ({ role: r.role, retailerAccountId: r.scope_retailer_account_id }));
}

/** Finds or creates the user for a verified phone and opens a session. Returns the raw token once. */
export async function createSessionForPhone(
  db: Db,
  phone: string,
  opts: { ttlDays: number; userAgent: string | null; ip: string | null },
): Promise<{ token: string; expiresAt: Date; auth: AuthContext }> {
  return withTransaction(db, async (client) => {
    await client.query('INSERT INTO users (phone) VALUES ($1) ON CONFLICT (phone) DO NOTHING', [phone]);
    const { rows } = await client.query<AuthUser>(`SELECT ${USER_COLUMNS} FROM users u WHERE u.phone = $1`, [phone]);
    const user = rows[0]!;
    if (user.status !== 'active') {
      throw new AppError('ACCOUNT_DISABLED', 'This account is disabled. Please contact Taneja Drug Agency.');
    }
    const token = generateSessionToken();
    const session = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip_address)
       VALUES ($1, $2, now() + make_interval(days => $3), $4, $5)
       RETURNING id, expires_at`,
      [user.id, hashSessionToken(token), opts.ttlDays, opts.userAgent?.slice(0, 500) ?? null, opts.ip],
    );
    await client.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    const roles = await loadRoles(client, user.id);
    return {
      token,
      expiresAt: session.rows[0]!.expires_at,
      auth: { user, roles, sessionId: session.rows[0]!.id },
    };
  });
}

/** Resolves a bearer token to an active session for an active user, or null. */
export async function authenticateToken(db: Db, token: string): Promise<AuthContext | null> {
  const { rows } = await db.query<AuthUser & { session_id: string; stale: boolean }>(
    `SELECT ${USER_COLUMNS}, s.id AS session_id, s.last_seen_at < now() - interval '5 minutes' AS stale
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`,
    [hashSessionToken(token)],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.stale) {
    await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]);
  }
  const { session_id: sessionId, stale: _stale, ...user } = row;
  return { user, roles: await loadRoles(db, user.id), sessionId };
}

export async function revokeSession(db: Pick<Db, 'query'>, sessionId: string): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

export async function revokeAllSessions(db: Pick<Db, 'query'>, userId: string): Promise<number> {
  const result = await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
    userId,
  ]);
  return result.rowCount ?? 0;
}
