/**
 * Bootstraps staff access from the command line, e.g. the first super admin:
 *   npm run user:grant -w @taneja/api -- 9876543210 super_admin
 * Creates the user if needed. The grant is audited with no actor and reason "cli".
 */
import { normalizeIndianMobile } from '@taneja/domain';
import type { Role } from '../auth/sessions.js';
import { loadConfig } from '../config.js';
import { createPool, withTransaction } from '../db.js';
import { loadDotEnv } from '../env-file.js';
import { GRANTABLE_ROLES, grantRole } from '../users.js';

loadDotEnv();
const [rawPhone, role] = process.argv.slice(2);
const phone = rawPhone ? normalizeIndianMobile(rawPhone) : null;
if (!phone || !role || !GRANTABLE_ROLES.includes(role as Role)) {
  console.error(`Usage: user:grant <indian-mobile> <role>\nRoles: ${GRANTABLE_ROLES.join(', ')}`);
  process.exit(1);
}

const pool = createPool(loadConfig());
try {
  const changed = await withTransaction(pool, async (client) => {
    await client.query('INSERT INTO users (phone) VALUES ($1) ON CONFLICT (phone) DO NOTHING', [phone]);
    const { rows } = await client.query<{ id: string }>('SELECT id FROM users WHERE phone = $1', [phone]);
    return grantRole(client, { userId: null, role: 'cli' }, rows[0]!.id, role as Role, 'cli');
  });
  console.log(changed.changed ? `Granted ${role} to ${phone}` : `${phone} already has ${role}`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
