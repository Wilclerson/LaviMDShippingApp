/**
 * Scheduled synchronisation endpoint.
 *
 * Called every 15–30 minutes by the platform scheduler. Protected by
 * CRON_SECRET; see docs/DEPLOYMENT.md for the schedule configuration.
 *
 * maxDuration is raised because a full three-pass sync can outlive the default
 * serverless limit on a busy day. The passes are individually bounded
 * (TRACKING_MAX_LOOKUPS_PER_RUN, Quantum View page cap) so the run stays inside
 * this budget and simply resumes on the next tick.
 */

import { NextResponse } from 'next/server';
import { authorizeCron } from '@/lib/http/api';
import { runFullSync } from '@/lib/sync/run';
import { purgeExpiredSessions } from '@/lib/auth/session';
import { purgeOldLoginAttempts } from '@/lib/auth/throttle';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function handle(request: Request): Promise<NextResponse> {
  const auth = authorizeCron(request);
  if (!auth.ok) return auth.response;

  const startedAt = Date.now();
  try {
    const result = await runFullSync('cron');
    await purgeExpiredSessions();
    await purgeOldLoginAttempts();

    return NextResponse.json({
      ok: result.ok,
      durationMs: result.durationMs,
      agingEscalated: result.agingEscalated,
      passes: result.passes.map((pass) => ({
        source: pass.source,
        status: pass.status,
        seen: pass.seen,
        created: pass.created,
        updated: pass.updated,
        events: pass.events,
        errors: pass.errors,
        // The message is safe to surface: it is our own text, never a credential.
        message: pass.errorMessage,
      })),
    });
  } catch (err) {
    logger.error('cron sync crashed', { error: err });
    return NextResponse.json(
      { ok: false, error: 'Sync failed. See server logs.', durationMs: Date.now() - startedAt },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
