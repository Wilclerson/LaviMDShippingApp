import { z } from 'zod';
import { authorizeApi } from '@/lib/auth/rbac';
import { addNote } from '@/lib/database/mutations';
import { jsonError, jsonOk, parseBody, clientIp } from '@/lib/http/api';

const NoteSchema = z.object({
  body: z.string().trim().min(1, 'cannot be empty').max(4000),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // Both roles may add notes.
  const auth = await authorizeApi('shipments:note');
  if (!auth.ok) return jsonError(auth.message, auth.status);

  const { id } = await params;
  if (!UUID_RE.test(id)) return jsonError('Invalid shipment id.', 400);

  const body = await parseBody(request, NoteSchema);
  if (!body.ok) return body.response;

  const note = await addNote({
    shipmentId: id,
    body: body.data.body,
    userId: auth.user.id,
    authorName: auth.user.name,
    actorEmail: auth.user.email,
    ipAddress: clientIp(request),
  });

  if (!note) return jsonError('Shipment not found.', 404);
  return jsonOk({ id: note.id, createdAt: note.created_at }, 201);
}
