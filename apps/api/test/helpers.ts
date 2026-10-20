import { RecordingSmsSender } from '../src/auth/sms.js';
import type { AppDeps } from '../src/app.js';
import type { Db } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { MemoryDocumentStore } from '../src/storage.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export function testDeps(
  db: Db,
  sms = new RecordingSmsSender(),
): AppDeps & { sms: RecordingSmsSender; documents: MemoryDocumentStore } {
  return { db, sms, documents: new MemoryDocumentStore(), otpPepper: 'test-pepper-test-pepper-test-pepper-1234', sessionTtlDays: 30 };
}

/** Drops everything in the test database and re-applies all migrations. */
export async function resetDatabase(db: Db): Promise<void> {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
}

export const SAMPLE_PDF = Buffer.from('%PDF-1.4\n% sample licence scan\n%%EOF\n');
export const SAMPLE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
export const SAMPLE_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 2),
]);
