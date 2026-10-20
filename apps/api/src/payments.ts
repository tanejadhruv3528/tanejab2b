import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';

export interface PaymentSession {
  providerRef: string;
  /** Where the retailer completes payment, when the provider uses a hosted page. */
  redirectUrl: string | null;
}

export interface WebhookEvent {
  eventId: string;
  providerRef: string;
  status: 'succeeded' | 'failed';
  amountPaise: number;
}

/**
 * Taneja's payment provider is not chosen yet, so all payment logic talks to this interface.
 * A real adapter must verify webhook signatures itself; the browser redirect is never trusted.
 */
export interface PaymentProvider {
  readonly name: string;
  readonly enabled: boolean;
  createSession(input: { paymentId: string; orderNumber: string; amountPaise: number }): Promise<PaymentSession>;
  /** Verifies the signature and parses the event. Throws INVALID_SIGNATURE when verification fails. */
  parseWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): WebhookEvent;
}

/** Default until a provider is chosen: prepaid checkout is refused rather than faked. */
export class NoPaymentProvider implements PaymentProvider {
  readonly name = 'none';
  readonly enabled = false;
  async createSession(): Promise<PaymentSession> {
    throw new AppError('PAYMENT_UNAVAILABLE', 'Online payment is not available yet');
  }
  parseWebhook(): WebhookEvent {
    throw new AppError('NOT_FOUND', 'Unknown payment provider');
  }
}

/**
 * Development-only stand-in that behaves like a real provider: opaque references and
 * HMAC-signed webhooks. It never moves money. Config refuses it in staging and production.
 */
export class DevFakePaymentProvider implements PaymentProvider {
  readonly name = 'dev_fake';
  readonly enabled = true;
  constructor(private readonly secret: string) {}

  async createSession(): Promise<PaymentSession> {
    return { providerRef: `devpay_${randomBytes(12).toString('hex')}`, redirectUrl: null };
  }

  sign(rawBody: string | Buffer): string {
    return createHmac('sha256', this.secret).update(rawBody).digest('hex');
  }

  parseWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): WebhookEvent {
    const given = headers['x-dev-signature'];
    const expected = Buffer.from(this.sign(rawBody), 'hex');
    const actual = typeof given === 'string' && /^[0-9a-f]{64}$/.test(given) ? Buffer.from(given, 'hex') : null;
    if (!actual || !timingSafeEqual(actual, expected)) {
      throw new AppError('INVALID_SIGNATURE', 'Webhook signature verification failed');
    }
    let body: Partial<WebhookEvent>;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new AppError('BAD_REQUEST', 'Webhook body is not JSON');
    }
    if (
      typeof body.eventId !== 'string' ||
      typeof body.providerRef !== 'string' ||
      (body.status !== 'succeeded' && body.status !== 'failed') ||
      !Number.isSafeInteger(body.amountPaise)
    ) {
      throw new AppError('BAD_REQUEST', 'Webhook body is missing fields');
    }
    return body as WebhookEvent;
  }
}
