interface WarnLogger {
  warn(obj: object, msg: string): void;
}

const consoleLogger: WarnLogger = { warn: (obj, msg) => console.warn(msg, JSON.stringify(obj)) };

export interface SmsSender {
  readonly name: string;
  sendOtp(phone: string, code: string): Promise<void>;
  /** Code the retailer gives the rider to confirm delivery. Needs its own DLT template. */
  sendDeliveryOtp(phone: string, orderNumber: string, code: string): Promise<void>;
}

/**
 * DEVELOPMENT ONLY. Writes the OTP to the server log instead of sending an SMS.
 * Config validation refuses to start staging/production with this sender.
 */
export class DevConsoleSmsSender implements SmsSender {
  readonly name = 'dev_console';

  constructor(private readonly log: WarnLogger = consoleLogger) {}

  async sendOtp(phone: string, code: string): Promise<void> {
    this.log.warn({ phone, devOtpCode: code }, '[DEV SMS - NOT SENT] OTP for local testing');
  }

  async sendDeliveryOtp(phone: string, orderNumber: string, code: string): Promise<void> {
    this.log.warn({ phone, orderNumber, devDeliveryOtp: code }, '[DEV SMS - NOT SENT] delivery OTP for local testing');
  }
}

/** Test helper that remembers the last code sent per phone. */
export class RecordingSmsSender implements SmsSender {
  readonly name = 'recording';
  readonly sent = new Map<string, string>();
  /** Last delivery code per order number. */
  readonly deliveryCodes = new Map<string, string>();

  async sendOtp(phone: string, code: string): Promise<void> {
    this.sent.set(phone, code);
  }

  async sendDeliveryOtp(_phone: string, orderNumber: string, code: string): Promise<void> {
    this.deliveryCodes.set(orderNumber, code);
  }
}
