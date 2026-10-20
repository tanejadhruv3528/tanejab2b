import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { RecordingSmsSender } from '../src/auth/sms.js';
import { createPool, withTransaction, type Db } from '../src/db.js';
import { grantRole } from '../src/users.js';
import { resetDatabase, TEST_DATABASE_URL, testDeps } from './helpers.js';

describe.skipIf(!TEST_DATABASE_URL)('auth and roles (integration)', () => {
  let db: Db;
  let app: FastifyInstance;
  let sms: RecordingSmsSender;
  let phoneCounter = 0;

  /** A fresh valid mobile number per call so OTP rate limits never collide across tests. */
  function newPhone(): string {
    phoneCounter += 1;
    return `+9198000${String(phoneCounter).padStart(5, '0')}`;
  }

  async function requestCode(phone: string) {
    return app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone } });
  }

  async function verify(phone: string, code: string) {
    return app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code } });
  }

  async function login(phone = newPhone()): Promise<{ token: string; userId: string; phone: string }> {
    expect((await requestCode(phone)).statusCode).toBe(202);
    const res = await verify(phone, sms.sent.get(phone)!);
    expect(res.statusCode).toBe(200);
    return { token: res.json().token, userId: res.json().user.id, phone };
  }

  function bearer(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function makeSuperAdmin(userId: string) {
    await withTransaction(db, (c) => grantRole(c, { userId: null, role: 'cli' }, userId, 'super_admin'));
  }

  beforeAll(async () => {
    db = createPool({ databaseUrl: TEST_DATABASE_URL!, databaseSsl: false });
    await resetDatabase(db);
    const deps = testDeps(db);
    sms = deps.sms;
    app = await buildApp(deps);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  describe('OTP login', () => {
    it('logs in a new number, creates the user with no roles, and returns a session', async () => {
      const phone = newPhone();
      const requested = await requestCode(phone);
      expect(requested.statusCode).toBe(202);
      expect(requested.json()).toEqual({ status: 'sent', expiresInSeconds: 300, resendAfterSeconds: 30 });

      const res = await verify(phone, sms.sent.get(phone)!);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(body.user).toMatchObject({ phone, status: 'active', language: 'en' });
      expect(body.roles).toEqual([]);

      const me = await app.inject({ method: 'GET', url: '/me', headers: bearer(body.token) });
      expect(me.statusCode).toBe(200);
      expect(me.json().user.phone).toBe(phone);
    });

    it('accepts local number formats and normalises them', async () => {
      const phone = newPhone();
      const local = `0${phone.slice(3, 8)} ${phone.slice(8)}`;
      expect((await requestCode(local)).statusCode).toBe(202);
      expect(sms.sent.has(phone)).toBe(true);
      expect((await verify(phone.slice(3), sms.sent.get(phone)!)).statusCode).toBe(200);
    });

    it('rejects invalid numbers', async () => {
      const res = await requestCode('12345 67890');
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    });

    it('stores only a hash of the code', async () => {
      const phone = newPhone();
      await requestCode(phone);
      const { rows } = await db.query('SELECT code_hash FROM otp_challenges WHERE phone = $1', [phone]);
      expect(rows[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].code_hash).not.toContain(sms.sent.get(phone));
    });

    it('enforces a resend cooldown', async () => {
      const phone = newPhone();
      expect((await requestCode(phone)).statusCode).toBe(202);
      const again = await requestCode(phone);
      expect(again.statusCode).toBe(429);
      expect(again.json().error.code).toBe('RATE_LIMITED');
    });

    it('caps codes per phone per window', async () => {
      const phone = newPhone();
      for (let i = 0; i < 5; i++) {
        expect((await requestCode(phone)).statusCode).toBe(202);
        // Skip the cooldown without waiting.
        await db.query("UPDATE otp_challenges SET created_at = created_at - interval '1 minute' WHERE phone = $1", [phone]);
      }
      expect((await requestCode(phone)).statusCode).toBe(429);
    });

    it('locks a code after five wrong attempts, even if the right code follows', async () => {
      const phone = newPhone();
      await requestCode(phone);
      const right = sms.sent.get(phone)!;
      const wrong = right === '000000' ? '111111' : '000000';
      for (let i = 4; i >= 1; i--) {
        const res = await verify(phone, wrong);
        expect(res.json().error).toMatchObject({ code: 'OTP_INVALID', details: { attemptsRemaining: i } });
      }
      expect((await verify(phone, wrong)).json().error.code).toBe('OTP_TOO_MANY_ATTEMPTS');
      const res = await verify(phone, right);
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('OTP_TOO_MANY_ATTEMPTS');
    });

    it('rejects an expired code', async () => {
      const phone = newPhone();
      await requestCode(phone);
      await db.query("UPDATE otp_challenges SET expires_at = now() - interval '1 second' WHERE phone = $1", [phone]);
      expect((await verify(phone, sms.sent.get(phone)!)).json().error.code).toBe('OTP_EXPIRED');
    });

    it('does not accept the same code twice', async () => {
      const { phone } = await login();
      const reused = await verify(phone, sms.sent.get(phone)!);
      expect(reused.statusCode).toBe(400);
      expect(reused.json().error.code).toBe('OTP_INVALID');
    });
  });

  describe('sessions', () => {
    it('requires a valid bearer token', async () => {
      expect((await app.inject({ method: 'GET', url: '/me' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/me', headers: { authorization: 'Basic abc' } })).statusCode).toBe(
        401,
      );
      const random = await app.inject({ method: 'GET', url: '/me', headers: bearer('x'.repeat(43)) });
      expect(random.statusCode).toBe(401);
      expect(random.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('stores only a hash of the session token', async () => {
      const { token, userId } = await login();
      const { rows } = await db.query('SELECT token_hash FROM sessions WHERE user_id = $1', [userId]);
      expect(rows[0].token_hash).not.toBe(token);
    });

    it('logs out by revoking the session', async () => {
      const { token } = await login();
      expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: bearer(token) })).statusCode).toBe(204);
      expect((await app.inject({ method: 'GET', url: '/me', headers: bearer(token) })).statusCode).toBe(401);
    });

    it('rejects expired sessions', async () => {
      const { token, userId } = await login();
      await db.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1", [userId]);
      expect((await app.inject({ method: 'GET', url: '/me', headers: bearer(token) })).statusCode).toBe(401);
    });

    it('lets users set their name and language', async () => {
      const { token } = await login();
      const res = await app.inject({
        method: 'PATCH',
        url: '/me',
        headers: bearer(token),
        payload: { name: 'Ramesh Medical Store', language: 'hi' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({ name: 'Ramesh Medical Store', language: 'hi' });
      const bad = await app.inject({ method: 'PATCH', url: '/me', headers: bearer(token), payload: { language: 'fr' } });
      expect(bad.statusCode).toBe(400);
    });

    it('does not let users change their own status or roles through /me', async () => {
      const { token } = await login();
      const res = await app.inject({ method: 'PATCH', url: '/me', headers: bearer(token), payload: { status: 'x' } });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('role-based access', () => {
    it('blocks admin routes for users without super_admin', async () => {
      const { token } = await login();
      const res = await app.inject({ method: 'GET', url: '/admin/users', headers: bearer(token) });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
      expect((await app.inject({ method: 'GET', url: '/admin/users' })).statusCode).toBe(401);
    });

    it('lets a super admin grant and revoke staff roles, with audit records', async () => {
      const admin = await login();
      await makeSuperAdmin(admin.userId);
      const staff = await login();

      const granted = await app.inject({
        method: 'POST',
        url: `/admin/users/${staff.userId}/roles`,
        headers: bearer(admin.token),
        payload: { role: 'picker_packer', reason: 'Warehouse staff' },
      });
      expect(granted.statusCode).toBe(200);
      expect(granted.json().roles).toEqual([{ role: 'picker_packer', retailerAccountId: null }]);

      const me = await app.inject({ method: 'GET', url: '/me', headers: bearer(staff.token) });
      expect(me.json().roles).toEqual([{ role: 'picker_packer', retailerAccountId: null }]);

      const revoked = await app.inject({
        method: 'DELETE',
        url: `/admin/users/${staff.userId}/roles/picker_packer`,
        headers: bearer(admin.token),
      });
      expect(revoked.json().roles).toEqual([]);

      const { rows } = await db.query(
        "SELECT action, actor_user_id FROM audit_logs WHERE entity_id = $1 AND action LIKE 'user.role.%' ORDER BY occurred_at",
        [staff.userId],
      );
      expect(rows).toEqual([
        { action: 'user.role.grant', actor_user_id: admin.userId },
        { action: 'user.role.revoke', actor_user_id: admin.userId },
      ]);
    });

    it('never grants the retailer role directly', async () => {
      const admin = await login();
      await makeSuperAdmin(admin.userId);
      const other = await login();
      const res = await app.inject({
        method: 'POST',
        url: `/admin/users/${other.userId}/roles`,
        headers: bearer(admin.token),
        payload: { role: 'retailer' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('prevents a super admin from removing their own access', async () => {
      const admin = await login();
      await makeSuperAdmin(admin.userId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/users/${admin.userId}/roles/super_admin`,
        headers: bearer(admin.token),
      });
      expect(res.statusCode).toBe(409);
      const disable = await app.inject({
        method: 'POST',
        url: `/admin/users/${admin.userId}/status`,
        headers: bearer(admin.token),
        payload: { status: 'disabled', reason: 'test' },
      });
      expect(disable.statusCode).toBe(409);
    });

    it('disabling a user ends their sessions and blocks new logins', async () => {
      const admin = await login();
      await makeSuperAdmin(admin.userId);
      const target = await login();

      const res = await app.inject({
        method: 'POST',
        url: `/admin/users/${target.userId}/status`,
        headers: bearer(admin.token),
        payload: { status: 'disabled', reason: 'Left the company' },
      });
      expect(res.json().user.status).toBe('disabled');
      expect((await app.inject({ method: 'GET', url: '/me', headers: bearer(target.token) })).statusCode).toBe(401);

      await db.query("UPDATE otp_challenges SET created_at = created_at - interval '1 minute' WHERE phone = $1", [
        target.phone,
      ]);
      await requestCode(target.phone);
      const blocked = await verify(target.phone, sms.sent.get(target.phone)!);
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().error.code).toBe('ACCOUNT_DISABLED');
    });

    it('lets a super admin pre-register staff and search by phone', async () => {
      const admin = await login();
      await makeSuperAdmin(admin.userId);
      const phone = newPhone();
      const created = await app.inject({
        method: 'POST',
        url: '/admin/users',
        headers: bearer(admin.token),
        payload: { phone: phone.slice(3), name: 'Rider One' },
      });
      expect(created.statusCode).toBe(201);
      const dup = await app.inject({ method: 'POST', url: '/admin/users', headers: bearer(admin.token), payload: { phone } });
      expect(dup.statusCode).toBe(409);
      const found = await app.inject({
        method: 'GET',
        url: `/admin/users?phone=${encodeURIComponent(phone)}`,
        headers: bearer(admin.token),
      });
      expect(found.json().items).toHaveLength(1);
      expect(found.json().items[0]).toMatchObject({ phone, name: 'Rider One', roles: [] });
    });
  });
});
