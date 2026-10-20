import { buildApp } from './app.js';
import { DevConsoleSmsSender } from './auth/sms.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { loadDotEnv } from './env-file.js';
import { loggerOptions } from './logger.js';
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
  logger: loggerOptions(config),
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await db.end();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
