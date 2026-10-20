import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { loadDotEnv } from './env-file.js';
import { loggerOptions } from './logger.js';

loadDotEnv();
const config = loadConfig();
const db = createPool(config);
const app = await buildApp({ db, logger: loggerOptions(config) });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await db.end();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
