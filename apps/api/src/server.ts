import { buildApp } from './app.js';
import { DevConsoleSmsSender } from './auth/sms.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { loadDotEnv } from './env-file.js';
import { loggerOptions } from './logger.js';
import { expireUnpaidOrders } from './orders.js';
import { DevFakePaymentProvider, NoPaymentProvider } from './payments.js';
import { LocalDiskDocumentStore } from './storage.js';

loadDotEnv();
const config = loadConfig();
const db = createPool(config);
const app = await buildApp({
  db,
  sms: new DevConsoleSmsSender(),
  documents: new LocalDiskDocumentStore(config.documentStorageDir),
  otpPepper: config.otpPepper,
  sessionTtlDays: config.sessionTtlDays,
  payments:
    config.paymentProvider === 'dev_fake'
      ? new DevFakePaymentProvider(config.devPaymentWebhookSecret)
      : new NoPaymentProvider(),
  logger: loggerOptions(config),
});

// Unpaid prepaid orders give their stock back once the payment window passes.
const expiryTimer = setInterval(() => {
  expireUnpaidOrders(db)
    .then((expired) => expired.length && app.log.info({ expired }, 'cancelled unpaid orders'))
    .catch((err) => app.log.error({ err }, 'unpaid order expiry failed'));
}, 60_000);
expiryTimer.unref();

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  clearInterval(expiryTimer);
  await app.close();
  await db.end();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
