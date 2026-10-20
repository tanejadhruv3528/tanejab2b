import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CHECKOUT_POLICY } from '@taneja/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit } from '../src/audit.js';
import { createPool, withTransaction, type Db } from '../src/db.js';
import { migrate, MigrationError } from '../src/migrate.js';
import { discountsEnabled, loadCheckoutPolicy } from '../src/settings.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('database (integration)', () => {
  let db: Db;

  beforeAll(async () => {
    db = createPool({ databaseUrl: url!, databaseSsl: false });
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  });

  afterAll(async () => {
    await db?.end();
  });

  it('applies migrations once and is idempotent', async () => {
    const first = await migrate(db);
    expect(first.applied).toContain('0001_foundation.sql');
    const second = await migrate(db);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('0001_foundation.sql');
  });

  it('refuses an applied migration whose contents changed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mig-'));
    await writeFile(path.join(dir, '0001_foundation.sql'), 'SELECT 1;');
    await expect(migrate(db, dir)).rejects.toThrow(MigrationError);
  });

  it('rolls back a failing migration completely', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mig-'));
    await writeFile(path.join(dir, '0900_broken.sql'), 'CREATE TABLE half_done (id int); SELECT * FROM missing_table;');
    await expect(migrate(db, dir)).rejects.toThrow(/0900_broken/);
    const { rows } = await db.query("SELECT to_regclass('public.half_done') AS t");
    expect(rows[0].t).toBeNull();
  });

  it('seeds the owner-proposed checkout policy with discounts disabled', async () => {
    expect(await loadCheckoutPolicy(db)).toEqual(DEFAULT_CHECKOUT_POLICY);
    expect(await discountsEnabled(db)).toBe(false);
  });

  it('keeps audit logs append-only', async () => {
    const id = await writeAudit(db, {
      action: 'settings.update',
      entityType: 'app_settings',
      entityId: 'checkout.policy',
      before: { a: 1 },
      after: { a: 2 },
      ipAddress: '10.0.0.1',
    });
    await expect(db.query('UPDATE audit_logs SET action = $1 WHERE id = $2', ['x', id])).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM audit_logs WHERE id = $1', [id])).rejects.toThrow(/append-only/);
  });

  it('rolls back the change and its audit row together', async () => {
    await expect(
      withTransaction(db, async (client) => {
        await writeAudit(client, { action: 'test.rollback', entityType: 'test' });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    const { rows } = await db.query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'test.rollback'");
    expect(rows[0].n).toBe(0);
  });
});
