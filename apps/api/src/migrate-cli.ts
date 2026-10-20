import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { loadDotEnv } from './env-file.js';
import { migrate } from './migrate.js';

loadDotEnv();
const pool = createPool(loadConfig());
try {
  const { applied, skipped } = await migrate(pool);
  console.log(`Migrations applied: ${applied.length ? applied.join(', ') : 'none'} (${skipped.length} already applied)`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
