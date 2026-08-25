#!/usr/bin/env tsx
import './load-env';
/**
 * Run a synchronisation from the command line.
 *
 *   npm run sync                  full sync
 *   npm run sync -- --list-stores print the ShipStation stores and their ids
 */

import { runFullSync } from '../src/lib/sync/run';
import { listStores } from '../src/lib/shipstation/client';
import { closePool } from '../src/lib/database/pool';

async function main() {
  if (process.argv.includes('--list-stores')) {
    const stores = await listStores();
    if (stores.length === 0) {
      console.log('No stores returned. Set SHIPSTATION_STORE_NAMES and rely on name matching.');
      return;
    }
    console.log('ShipStation stores (use the ids in SHIPSTATION_STORE_IDS):\n');
    for (const store of stores) {
      const id = store.store_id ?? '(no id)';
      const name = store.name ?? store.store_name ?? store.marketplace_name ?? '(unnamed)';
      console.log(`  ${String(id).padEnd(14)} ${name}`);
    }
    return;
  }

  const result = await runFullSync('cli');
  console.log(`\nSync ${result.ok ? 'completed' : 'completed with errors'} in ${result.durationMs}ms\n`);
  for (const pass of result.passes) {
    console.log(
      `  ${pass.source.padEnd(18)} ${pass.status.padEnd(9)} ` +
        `seen=${pass.seen} created=${pass.created} updated=${pass.updated} ` +
        `events=${pass.events} errors=${pass.errors}` +
        (pass.errorMessage ? `\n      ${pass.errorMessage}` : ''),
    );
  }
  console.log(`\n  Labels escalated to aging: ${result.agingEscalated}`);
  if (!result.ok) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('Sync failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
