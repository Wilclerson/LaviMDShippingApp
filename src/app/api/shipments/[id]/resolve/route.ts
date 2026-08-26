import { z } from 'zod';
import { authorizeApi } from '@/lib/auth/rbac';
import { resolveShipment, unresolveShipment, isResolutionReason } from '@/lib/database/mutations';
import { jsonError, jsonOk, parseBody, clientIp } from '@/lib/http/api';
import { RESOLUTION_REASONS } from '@/lib/types';

const ResolveSchema = z.object({
  reason: z.string().refine(isResolutionReason, {
    message: `must be one of: ${RESOLUTION_REASONS.join(', ')}`,
  }),
  note: z.string().max(2000).nullable().optional(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // Resolving an exception is an admin-only action.
  const auth = await authorizeApi('shipments:resolve');
  if (!auth.ok) return jsonError(auth.message, auth.status, auth.code);

  const { id } = await params;
  if (!UUID_RE.test(id)) return jsonError('Invalid shipment id.', 400);

  const body = await parseBody(request, ResolveSchema);
  if (!body.ok) return body.response;

  const resolved = await resolveShipment({
    shipmentId: id,
    reason: body.data.reason as (typeof RESOLUTION_REASONS)[number],
    note: body.data.note ?? null,
    userId: auth.user.id,
    actorEmail: auth.user.email,
    ipAddress: clientIp(request),
  });

  if (!resolved) {
    return jsonError('Shipment not found, or it is already resolved.', 404);
  }

  return jsonOk({ resolved: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeApi('shipments:resolve');
  if (!auth.ok) return jsonError(auth.message, auth.status, auth.code);

  const { id } = await params;
  if (!UUID_RE.test(id)) return jsonError('Invalid shipment id.', 400);

  const reopened = await unresolveShipment({
    shipmentId: id,
    userId: auth.user.id,
    actorEmail: auth.user.email,
    ipAddress: clientIp(request),
  });

  if (!reopened) return jsonError('Shipment not found, or it is not resolved.', 404);
  return jsonOk({ resolved: false });
}
