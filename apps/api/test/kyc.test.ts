import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { RecordingSmsSender } from '../src/auth/sms.js';
import { createPool, withTransaction, type Db } from '../src/db.js';
import { grantRole } from '../src/users.js';
import {
  resetDatabase,
  SAMPLE_JPEG,
  SAMPLE_PDF,
  SAMPLE_PNG,
  TEST_DATABASE_URL,
  testDeps,
} from './helpers.js';

const DETAILS = {
  businessName: 'Ramesh Medical Hall',
  ownerName: 'Ramesh Kumar',
  gstin: '27AAPFU0939F1ZV',
  store: {
    addressLine1: 'Station Road, Near Kali Mandir',
    city: 'Samastipur',
    district: 'Samastipur',
    postalCode: '848101',
    latitude: 25.8629,
    longitude: 85.7811,
  },
  license: { type: 'form_20_21', number: 'BR/SAM/20B-21B/1234', validUntil: '2029-03-31' },
};

describe.skipIf(!TEST_DATABASE_URL)('retailer onboarding and KYC (integration)', () => {
  let db: Db;
  let app: FastifyInstance;
  let sms: RecordingSmsSender;
  let counter = 0;

  async function login(): Promise<{ token: string; userId: string }> {
    counter += 1;
    const phone = `+9197000${String(counter).padStart(5, '0')}`;
    await app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone } });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: sms.sent.get(phone) },
    });
    return { token: res.json().token, userId: res.json().user.id };
  }

  async function staff(role: 'kyc_reviewer' | 'super_admin') {
    const user = await login();
    await withTransaction(db, (c) => grantRole(c, { userId: null, role: 'cli' }, user.userId, role));
    return user;
  }

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  function call(token: string, method: 'GET' | 'PUT' | 'POST', url: string, payload?: object) {
    return app.inject({ method, url, headers: auth(token), ...(payload ? { payload } : {}) });
  }

  function upload(token: string, kind: string, bytes: Buffer, contentType: string) {
    return app.inject({
      method: 'POST',
      url: `/retailer/kyc/documents/${kind}`,
      headers: { ...auth(token), 'content-type': contentType },
      payload: bytes,
    });
  }

  /** A retailer with complete details and documents, submitted for review. */
  async function submittedRetailer() {
    const retailer = await login();
    expect((await call(retailer.token, 'PUT', '/retailer/onboarding', DETAILS)).statusCode).toBe(200);
    expect((await upload(retailer.token, 'drug_license', SAMPLE_PDF, 'application/pdf')).statusCode).toBe(201);
    expect((await upload(retailer.token, 'store_photo', SAMPLE_JPEG, 'image/jpeg')).statusCode).toBe(201);
    const submitted = await call(retailer.token, 'POST', '/retailer/kyc/submit');
    expect(submitted.statusCode).toBe(200);
    return { ...retailer, accountId: submitted.json().account.id as string };
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

  describe('retailer side', () => {
    it('starts with no account and reports what is missing', async () => {
      const { token } = await login();
      expect((await call(token, 'GET', '/retailer/onboarding')).json()).toEqual({ account: null });
      expect((await call(token, 'GET', '/retailer/kyc/status')).json().status).toBe('not_started');

      const saved = await call(token, 'PUT', '/retailer/onboarding', { businessName: 'Shop' });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().account.status).toBe('draft');
      expect(saved.json().gaps).toEqual([
        'OWNER_NAME_MISSING',
        'STORE_ADDRESS_MISSING',
        'STORE_LOCATION_MISSING',
        'LICENSE_MISSING',
        'LICENSE_DOCUMENT_MISSING',
        'STORE_PHOTO_MISSING',
      ]);

      const submit = await call(token, 'POST', '/retailer/kyc/submit');
      expect(submit.statusCode).toBe(400);
      expect(submit.json().error.details.gaps).toContain('LICENSE_MISSING');
    });

    it('validates GSTIN, PIN code and map pin', async () => {
      const { token } = await login();
      const res = await call(token, 'PUT', '/retailer/onboarding', {
        gstin: '27AAPFU0939F1ZW',
        store: { ...DETAILS.store, postalCode: '048101', latitude: 51.5, longitude: -0.1 },
      });
      expect(res.statusCode).toBe(400);
      expect(Object.keys(res.json().error.details)).toEqual(['gstin', 'store.postalCode', 'store.location']);
    });

    it('rejects an expired licence at submission', async () => {
      const { token } = await login();
      await call(token, 'PUT', '/retailer/onboarding', {
        ...DETAILS,
        license: { ...DETAILS.license, validUntil: '2020-01-01' },
      });
      await upload(token, 'drug_license', SAMPLE_PDF, 'application/pdf');
      await upload(token, 'store_photo', SAMPLE_JPEG, 'image/jpeg');
      const res = await call(token, 'POST', '/retailer/kyc/submit');
      expect(res.json().error.details.gaps).toEqual(['LICENSE_EXPIRED']);
    });

    it('accepts only real JPEG, PNG or PDF files', async () => {
      const { token } = await login();
      expect((await upload(token, 'drug_license', SAMPLE_PDF, 'application/pdf')).statusCode).toBe(404); // no account yet
      await call(token, 'PUT', '/retailer/onboarding', { businessName: 'Shop' });

      expect((await upload(token, 'store_photo', SAMPLE_PNG, 'image/png')).statusCode).toBe(201);
      const disguised = await upload(token, 'drug_license', SAMPLE_PNG, 'application/pdf');
      expect(disguised.statusCode).toBe(400);
      const exe = await upload(token, 'drug_license', Buffer.from('MZ\x90\x00 not a document'), 'application/pdf');
      expect(exe.statusCode).toBe(400);
      expect((await upload(token, 'drug_license', Buffer.from('hello'), 'text/plain')).statusCode).toBe(400);
      const big = Buffer.concat([SAMPLE_PDF, Buffer.alloc(5 * 1024 * 1024)]);
      expect((await upload(token, 'drug_license', big, 'application/pdf')).statusCode).toBe(413);
      expect((await upload(token, 'passport', SAMPLE_PDF, 'application/pdf')).statusCode).toBe(400);
    });

    it('keeps one current licence scan and never exposes storage keys', async () => {
      const { token } = await login();
      await call(token, 'PUT', '/retailer/onboarding', { businessName: 'Shop' });
      await upload(token, 'drug_license', SAMPLE_PDF, 'application/pdf');
      await upload(token, 'drug_license', SAMPLE_JPEG, 'image/jpeg');
      const res = await call(token, 'GET', '/retailer/onboarding');
      expect(res.json().documents).toHaveLength(1);
      expect(res.json().documents[0]).toMatchObject({ kind: 'drug_license', contentType: 'image/jpeg' });
      expect(res.body).not.toContain('kyc/');
    });

    it('locks details once submitted', async () => {
      const retailer = await submittedRetailer();
      expect((await call(retailer.token, 'GET', '/retailer/kyc/status')).json()).toMatchObject({
        status: 'submitted',
        gaps: [],
      });
      expect((await call(retailer.token, 'PUT', '/retailer/onboarding', { businessName: 'X' })).statusCode).toBe(409);
      expect((await upload(retailer.token, 'other', SAMPLE_PDF, 'application/pdf')).statusCode).toBe(409);
      expect((await call(retailer.token, 'POST', '/retailer/kyc/submit')).statusCode).toBe(409);
    });
  });

  describe('reviewer side', () => {
    it('keeps retailers and other staff out of the review console', async () => {
      const retailer = await login();
      expect((await call(retailer.token, 'GET', '/admin/kyc/queue')).statusCode).toBe(403);
      const picker = await login();
      await withTransaction(db, (c) => grantRole(c, { userId: null, role: 'cli' }, picker.userId, 'picker_packer'));
      expect((await call(picker.token, 'GET', '/admin/kyc/queue')).statusCode).toBe(403);
    });

    it('approves a retailer end to end and grants the scoped retailer role', async () => {
      const retailer = await submittedRetailer();
      const reviewer = await staff('kyc_reviewer');

      const queue = await call(reviewer.token, 'GET', '/admin/kyc/queue');
      expect(queue.json().items.map((i: { id: string }) => i.id)).toContain(retailer.accountId);

      const detail = await call(reviewer.token, 'GET', `/admin/kyc/${retailer.accountId}`);
      expect(detail.json().account).toMatchObject({ businessName: 'Ramesh Medical Hall', status: 'submitted' });
      const licenceDoc = detail.json().documents.find((d: { kind: string }) => d.kind === 'drug_license');

      const file = await call(reviewer.token, 'GET', `/admin/kyc/${retailer.accountId}/documents/${licenceDoc.id}`);
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-type']).toBe('application/pdf');
      expect(file.rawPayload.equals(SAMPLE_PDF)).toBe(true);
      const views = await db.query(
        "SELECT actor_user_id FROM audit_logs WHERE action = 'retailer.kyc.document.view' AND entity_id = $1",
        [licenceDoc.id],
      );
      expect(views.rows).toEqual([{ actor_user_id: reviewer.userId }]);

      expect(
        (await call(reviewer.token, 'POST', `/admin/kyc/${retailer.accountId}/decision`, { status: 'under_review' }))
          .statusCode,
      ).toBe(200);

      const unverified = await call(reviewer.token, 'POST', `/admin/kyc/${retailer.accountId}/decision`, {
        status: 'approved',
      });
      expect(unverified.statusCode).toBe(409);

      const approved = await call(reviewer.token, 'POST', `/admin/kyc/${retailer.accountId}/decision`, {
        status: 'approved',
        storeVerified: true,
        serviceZone: 'samastipur-town',
        videoKycStatus: 'completed',
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json().account.status).toBe('approved');
      expect(approved.json().store).toMatchObject({ verified: true, serviceZone: 'samastipur-town' });

      const me = await call(retailer.token, 'GET', '/me');
      expect(me.json().roles).toEqual([{ role: 'retailer', retailerAccountId: retailer.accountId }]);

      const history = await call(reviewer.token, 'GET', `/admin/kyc/${retailer.accountId}`);
      expect(history.json().history.map((h: { toStatus: string }) => h.toStatus)).toEqual(['approved', 'under_review']);
    });

    it('requires a reason to send back for resubmission and resets store verification on address change', async () => {
      const retailer = await submittedRetailer();
      const reviewer = await staff('kyc_reviewer');
      const url = `/admin/kyc/${retailer.accountId}/decision`;

      expect((await call(reviewer.token, 'POST', url, { status: 'needs_resubmission' })).statusCode).toBe(400);
      await call(reviewer.token, 'POST', url, { status: 'needs_resubmission', reason: 'Licence photo is blurry', storeVerified: true });

      const status = await call(retailer.token, 'GET', '/retailer/kyc/status');
      expect(status.json()).toMatchObject({
        status: 'needs_resubmission',
        latestDecision: { status: 'needs_resubmission', reason: 'Licence photo is blurry' },
      });

      const moved = await call(retailer.token, 'PUT', '/retailer/onboarding', {
        store: { ...DETAILS.store, addressLine1: 'New Market Road' },
      });
      expect(moved.json().store.verified).toBe(false);
      await upload(retailer.token, 'drug_license', SAMPLE_JPEG, 'image/jpeg');
      expect((await call(retailer.token, 'POST', '/retailer/kyc/submit')).json().account.status).toBe('submitted');
    });

    it('rejection is final and suspension removes ordering access until reinstated', async () => {
      const reviewer = await staff('kyc_reviewer');

      const rejected = await submittedRetailer();
      await call(reviewer.token, 'POST', `/admin/kyc/${rejected.accountId}/decision`, {
        status: 'rejected',
        reason: 'Licence number does not match state register',
      });
      expect((await call(rejected.token, 'PUT', '/retailer/onboarding', { businessName: 'Again' })).statusCode).toBe(409);
      expect(
        (await call(reviewer.token, 'POST', `/admin/kyc/${rejected.accountId}/decision`, { status: 'approved' })).statusCode,
      ).toBe(409);

      const retailer = await submittedRetailer();
      const url = `/admin/kyc/${retailer.accountId}/decision`;
      await call(reviewer.token, 'POST', url, { status: 'approved', storeVerified: true });
      expect((await call(reviewer.token, 'POST', url, { status: 'suspended' })).statusCode).toBe(400);
      await call(reviewer.token, 'POST', url, { status: 'suspended', reason: 'Licence under suspension by drug controller' });
      expect((await call(retailer.token, 'GET', '/me')).json().roles).toEqual([]);
      await call(reviewer.token, 'POST', url, { status: 'approved' });
      expect((await call(retailer.token, 'GET', '/me')).json().roles).toEqual([
        { role: 'retailer', retailerAccountId: retailer.accountId },
      ]);
    });

    it('stops a reviewer approving their own retailer account', async () => {
      const reviewer = await staff('kyc_reviewer');
      await call(reviewer.token, 'PUT', '/retailer/onboarding', DETAILS);
      await upload(reviewer.token, 'drug_license', SAMPLE_PDF, 'application/pdf');
      await upload(reviewer.token, 'store_photo', SAMPLE_JPEG, 'image/jpeg');
      const own = (await call(reviewer.token, 'POST', '/retailer/kyc/submit')).json().account.id;
      const res = await call(reviewer.token, 'POST', `/admin/kyc/${own}/decision`, {
        status: 'approved',
        storeVerified: true,
      });
      expect(res.statusCode).toBe(403);
    });

    it('audits every decision with before and after state', async () => {
      const retailer = await submittedRetailer();
      const admin = await staff('super_admin');
      await call(admin.token, 'POST', `/admin/kyc/${retailer.accountId}/decision`, {
        status: 'approved',
        storeVerified: true,
        codAllowed: false,
      });
      const { rows } = await db.query(
        `SELECT actor_role, before_state->>'status' AS before, after_state->>'status' AS after,
                after_state->>'codAllowed' AS cod
         FROM audit_logs WHERE action = 'retailer.kyc.decision' AND entity_id = $1`,
        [retailer.accountId],
      );
      expect(rows).toEqual([{ actor_role: 'super_admin', before: 'submitted', after: 'approved', cod: 'false' }]);
    });
  });
});
