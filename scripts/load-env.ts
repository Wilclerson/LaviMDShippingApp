/**
 * Load .env files for the CLI scripts.
 *
 * Next.js loads these automatically for the web app, but `tsx scripts/*.ts`
 * runs outside that, so the scripts import this module first. Precedence
 * matches Next.js: .env.local overrides .env, and a variable already present in
 * the real environment always wins (that is how production is configured).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

const FILES = ['.env', '.env.local'];

for (const file of FILES) {
  const fullPath = path.join(process.cwd(), file);
  if (!existsSync(fullPath)) continue;
  try {
    // Node 20.12+/22 built-in; no dependency required.
    process.loadEnvFile(fullPath);
  } catch (err) {
    console.warn(`Warning: could not read ${file}:`, err instanceof Error ? err.message : err);
  }
}
