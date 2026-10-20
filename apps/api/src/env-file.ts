import { existsSync } from 'node:fs';

/** Loads `.env` from the working directory for local development, if present. Real environments set variables directly. */
export function loadDotEnv(file = '.env'): void {
  if (existsSync(file)) process.loadEnvFile(file);
}
