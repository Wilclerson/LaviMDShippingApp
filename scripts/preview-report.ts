#!/usr/bin/env tsx
import './load-env';
/**
 * Render the morning report to disk without sending it.
 *   npm run report:preview -- --out /tmp/report.html
 */

import { writeFile } from 'node:fs/promises';
import { getDailyReportData } from '../src/lib/database/queries';
import { renderDailyReport } from '../src/lib/email/render';
import { localHourToUtc } from '../src/lib/time';
import { closePool } from '../src/lib/database/pool';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const now = new Date();
  const windowStart = new Date(localHourToUtc(now, 8).getTime() - 24 * 3_600_000);
  const data = await getDailyReportData(windowStart);
  const { subject, html, text } = renderDailyReport(data, now);

  const out = arg('out');
  if (out) {
    await writeFile(out, html, 'utf8');
    console.log(`Wrote ${out}`);
  }
  console.log(`\nSubject: ${subject}\n`);
  console.log(text);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => closePool());
