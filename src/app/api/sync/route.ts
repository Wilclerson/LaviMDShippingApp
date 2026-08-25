/** Manual sync trigger for administrators (the System page button). */

import { authorizeApi } from '@/lib/auth/rbac';
import { runFullSync } from '@/lib/sync/run';
import { recordAudit } from '@/lib/database/mutations';
import { jsonError, jsonOk, clientIp } from '@/lib/http/api';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request) {
  const auth = await authorizeApi('sync:trigger');
  if (!auth.ok) return jsonError(auth.message, auth.status);

  await recordAudit({
    userId: auth.user.id,
    actorEmail: auth.user.email,
    action: 'sync.manual',
    entityType: 'system',
    entityId: null,
    ipAddress: clientIp(request),
  });

  try {
    const result = await runFullSync('manual');
    return jsonOk({
      ok: result.ok,
      durationMs: result.durationMs,
      agingEscalated: result.agingEscalated,
      passes: result.passes,
    });
  } catch (err) {
    logger.error('manual sync failed', { error: err });
    return jsonError('Sync failed. See server logs.', 500);
  }
}
