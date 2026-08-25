#!/usr/bin/env tsx
import './load-env';
/** Apply pending database migrations. Usage: npm run migrate */

import { runMigrations } from '../src/lib/database/migrate';
import { closePool } from '../src/lib/database/pool';

async function main() {
  const applied = await runMigrations();
  if (applied.length > 0) {
    console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
  } else {
    console.log('Database schema is already up to date.');
  }
}

main()
  .catch((err) => {
    console.error('Migration failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
