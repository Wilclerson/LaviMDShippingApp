/**
 * The 8:00 AM America/New_York shipping audit email.
 *
 * The spec requires the report to read our own database *after* a fresh sync,
 * so this endpoint syncs first and then renders. A sync failure does not cancel
 * the email — yesterday's data with a stale-sync warning is far better than no
 * report at all — but it is recorded and reported.
 *
 * Schedule this in UTC. Because America/New_York shifts between EDT (UTC-4) and
 * EST (UTC-5), the schedule fires at both 12:00 and 13:00 UTC and this handler
 * sends only when it is actually the 8 o'clock hour in New York. The duplicate
 * guard in sendDailyReport makes the second call a no-op.
 */

import { NextResponse } from 'next/server';
import { authorizeCron } from '@/lib/http/api';
import { runFullSync } from '@/lib/sync/run';
import { sendDailyReport } from '@/lib/email/daily-report';
import { logger } from '@/lib/logger';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** The hour of day (0–23) it currently is in the display timezone. */
function localHour(now: Date): number {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: env.displayTimeZone,
    hour: '2-digit',
    hour12: false,
  }).format(now);
  return Number.parseInt(formatted, 10);
}

async function handle(request: Request): Promise<NextResponse> {
  const auth = authorizeCron(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const force = url.searchParams.get('force') === 'true';
  const skipSync = url.searchParams.get('skipSync') === 'true';
  const now = new Date();

  // Guard against the DST double-fire. `force` bypasses it for manual sends.
  const hour = localHour(now);
  if (!force && hour !== 8) {
    logger.info('daily report endpoint called outside the 8 AM hour; skipping', {
      localHour: hour,
      timeZone: env.displayTimeZone,
    });
    return NextResponse.json({
      sent: false,
      skipped: true,
      reason: `Not the 8 AM hour in ${env.displayTimeZone} (currently ${hour}:00).`,
    });
  }

  let syncOk = true;
  let syncError: string | undefined;

  if (!skipSync) {
    try {
      const sync = await runFullSync('cron');
      syncOk = sync.ok;
      if (!sync.ok) {
        syncError = sync.passes
          .filter((p) => p.status === 'failed')
          .map((p) => `${p.source}: ${p.errorMessage ?? 'failed'}`)
          .join('; ');
      }
    } catch (err) {
      // A failed sync must not cancel the morning report.
      syncOk = false;
      syncError = err instanceof Error ? err.message : String(err);
      logger.error('pre-report sync failed; sending the report anyway', { error: err });
    }
  }

  try {
    const result = await sendDailyReport({ force, now });
    return NextResponse.json({
      ...result,
      syncOk,
      syncError,
      // Recipients are internal staff; echoing the count avoids putting
      // addresses in a response body that may be logged by the scheduler.
      recipients: result.recipients.length,
    });
  } catch (err) {
    logger.error('daily report crashed', { error: err });
    return NextResponse.json({ sent: false, error: 'Report failed. See server logs.' }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
