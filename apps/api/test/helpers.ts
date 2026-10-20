import { RecordingSmsSender } from '../src/auth/sms.js';
import type { AppDeps } from '../src/app.js';
import type { Db } from '../src/db.js';
import { migrate } from '../src/migrate.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export function testDeps(db: Db, sms = new RecordingSmsSender()): AppDeps & { sms: RecordingSmsSender } {
  return { db, sms, otpPepper: 'test-pepper-test-pepper-test-pepper-1234', sessionTtlDays: 30 };
}

/** Drops everything in the test database and re-applies all migrations. */
export async function resetDatabase(db: Db): Promise<void> {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
}
