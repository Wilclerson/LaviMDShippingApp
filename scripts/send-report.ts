#!/usr/bin/env tsx
import './load-env';
/**
 * Send the morning audit report from the command line.
 *
 *   npm run report                     respects the once-per-day guard
 *   npm run report -- --force          send even if today's report already went
 *   npm run report -- --to a@b.com     send to specific addresses instead
 */

import { sendDailyReport } from '../src/lib/email/daily-report';
import { closePool } from '../src/lib/database/pool';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main() {
  const to = arg('to');
  const result = await sendDailyReport({
    force: process.argv.includes('--force'),
    overrideRecipients: to ? to.split(',').map((s) => s.trim()) : undefined,
  });

  if (result.sent) {
    console.log(`Sent "${result.subject}" to ${result.recipients.length} recipient(s).`);
  } else {
    console.log(`Not sent: ${result.reason ?? 'unknown reason'}`);
  }
  console.log(
    `  confirmed=${result.summary.confirmed} needsAttention=${result.summary.needsAttention} ` +
      `aging=${result.summary.agingLabels} exceptions=${result.summary.exceptions}`,
  );
}

main()
  .catch((err) => {
    console.error('Report failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
