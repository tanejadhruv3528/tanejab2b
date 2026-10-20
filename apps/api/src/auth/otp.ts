import { normalizeIndianMobile } from '@taneja/domain';
import type { Db } from '../db.js';
import { withTransaction } from '../db.js';
import { AppError } from '../errors.js';
import type { SmsSender } from './sms.js';
import { generateOtpCode, hashOtp, safeEqualHex } from './tokens.js';

export const OTP_POLICY = {
  ttlSeconds: 300,
  maxAttempts: 5,
  resendCooldownSeconds: 30,
  windowMinutes: 15,
  maxPerPhonePerWindow: 5,
  maxPerIpPerWindow: 30,
} as const;

export interface OtpDeps {
  db: Db;
  sms: SmsSender;
  pepper: string;
}

export function parsePhone(input: string): string {
  const phone = normalizeIndianMobile(input);
  if (!phone) {
    throw new AppError('VALIDATION_FAILED', 'Enter a valid 10-digit Indian mobile number', { field: 'phone' });
  }
  return phone;
}

/**
 * Issues a new OTP. The response is identical whether or not the phone has an account,
 * so the endpoint cannot be used to discover registered numbers.
 */
export async function requestOtp(deps: OtpDeps, rawPhone: string, ip: string | null) {
  const phone = parsePhone(rawPhone);

  const { rows } = await deps.db.query<{ phone_count: number; ip_count: number; seconds_since_last: number | null }>(
    `SELECT
       count(*) FILTER (WHERE phone = $1)::int AS phone_count,
       count(*) FILTER (WHERE $2::inet IS NOT NULL AND request_ip = $2::inet)::int AS ip_count,
       extract(epoch FROM now() - max(created_at) FILTER (WHERE phone = $1))::float AS seconds_since_last
     FROM otp_challenges
     WHERE created_at > now() - make_interval(mins => $3)
       AND (phone = $1 OR request_ip = $2::inet)`,
    [phone, ip, OTP_POLICY.windowMinutes],
  );
  const stats = rows[0]!;
  if (stats.seconds_since_last !== null && stats.seconds_since_last < OTP_POLICY.resendCooldownSeconds) {
    const wait = Math.ceil(OTP_POLICY.resendCooldownSeconds - stats.seconds_since_last);
    throw new AppError('RATE_LIMITED', `Please wait ${wait} seconds before requesting another code`, {
      retryAfterSeconds: wait,
    });
  }
  if (stats.phone_count >= OTP_POLICY.maxPerPhonePerWindow || stats.ip_count >= OTP_POLICY.maxPerIpPerWindow) {
    throw new AppError('RATE_LIMITED', 'Too many code requests. Please try again later.');
  }

  const code = generateOtpCode();
  await deps.db.query(
    `INSERT INTO otp_challenges (phone, code_hash, max_attempts, expires_at, request_ip)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5)`,
    [phone, hashOtp(deps.pepper, phone, code), OTP_POLICY.maxAttempts, OTP_POLICY.ttlSeconds, ip],
  );
  await deps.sms.sendOtp(phone, code);

  return {
    status: 'sent' as const,
    expiresInSeconds: OTP_POLICY.ttlSeconds,
    resendAfterSeconds: OTP_POLICY.resendCooldownSeconds,
  };
}

type VerifyOutcome = { ok: true; phone: string } | { ok: false; error: AppError };

/**
 * Checks a code against the latest open challenge for the phone. The attempt counter is committed
 * even when the code is wrong, so brute force is capped at `maxAttempts` per code.
 */
export async function verifyOtp(deps: OtpDeps, rawPhone: string, code: string): Promise<string> {
  const phone = parsePhone(rawPhone);
  if (!/^\d{6}$/.test(code)) {
    throw new AppError('VALIDATION_FAILED', 'The code must be 6 digits', { field: 'code' });
  }

  const outcome = await withTransaction<VerifyOutcome>(deps.db, async (client) => {
    const { rows } = await client.query<{
      id: string;
      code_hash: string;
      attempts: number;
      max_attempts: number;
      expired: boolean;
    }>(
      `SELECT id, code_hash, attempts, max_attempts, expires_at <= now() AS expired
       FROM otp_challenges
       WHERE phone = $1 AND consumed_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [phone],
    );
    const challenge = rows[0];
    if (!challenge) {
      return { ok: false, error: new AppError('OTP_INVALID', 'Code is incorrect. Request a new code.') };
    }
    if (challenge.expired) {
      return { ok: false, error: new AppError('OTP_EXPIRED', 'This code has expired. Request a new code.') };
    }
    if (challenge.attempts >= challenge.max_attempts) {
      return { ok: false, error: new AppError('OTP_TOO_MANY_ATTEMPTS', 'Too many wrong attempts. Request a new code.') };
    }

    await client.query('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1', [challenge.id]);
    if (!safeEqualHex(challenge.code_hash, hashOtp(deps.pepper, phone, code))) {
      const remaining = challenge.max_attempts - challenge.attempts - 1;
      return {
        ok: false,
        error:
          remaining > 0
            ? new AppError('OTP_INVALID', 'Code is incorrect', { attemptsRemaining: remaining })
            : new AppError('OTP_TOO_MANY_ATTEMPTS', 'Too many wrong attempts. Request a new code.'),
      };
    }
    await client.query('UPDATE otp_challenges SET consumed_at = now() WHERE id = $1', [challenge.id]);
    return { ok: true, phone };
  });

  if (!outcome.ok) throw outcome.error;
  return outcome.phone;
}
