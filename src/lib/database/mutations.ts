/**
 * Administrative mutations.
 *
 * Nothing here deletes a shipment. Resolution is a flag plus an audit record,
 * so the original evidence stays intact and the decision is attributable.
 */

import { query, transaction } from './pool';
import { logger } from '../logger';
import { RESOLUTION_REASONS, type ResolutionReason } from '../types';

export function isResolutionReason(value: string): value is ResolutionReason {
  return (RESOLUTION_REASONS as readonly string[]).includes(value);
}

export async function recordAudit(entry: {
  userId: string | null;
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  detail?: Record<string, unknown>;
  ipAddress?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO audit_log (user_id, actor_email, action, entity_type, entity_id, detail, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.userId,
      entry.actorEmail,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.detail ? JSON.stringify(entry.detail) : null,
      entry.ipAddress ?? null,
    ],
  );
}

export interface ResolveInput {
  shipmentId: string;
  reason: ResolutionReason;
  note: string | null;
  userId: string;
  actorEmail: string;
  ipAddress?: string | null;
}

export async function resolveShipment(input: ResolveInput): Promise<boolean> {
  return transaction(async (client) => {
    const { rows } = await client.query<{ id: string; normalized_status: string; tracking_number: string }>(
      `UPDATE shipments
          SET manually_resolved = TRUE,
              manually_resolved_by = $2,
              manually_resolved_at = NOW(),
              resolution_reason = $3,
              resolution_note = $4
        WHERE id = $1 AND manually_resolved = FALSE
        RETURNING id, normalized_status, tracking_number`,
      [input.shipmentId, input.userId, input.reason, input.note],
    );

    if (rows.length === 0) return false;

    await client.query(
      `INSERT INTO audit_log (user_id, actor_email, action, entity_type, entity_id, detail, ip_address)
       VALUES ($1, $2, 'shipment.resolve', 'shipment', $3, $4, $5)`,
      [
        input.userId,
        input.actorEmail,
        input.shipmentId,
        JSON.stringify({
          reason: input.reason,
          note: input.note,
          trackingNumber: rows[0]!.tracking_number,
          statusAtResolution: rows[0]!.normalized_status,
        }),
        input.ipAddress ?? null,
      ],
    );

    logger.info('shipment resolved', {
      shipmentId: input.shipmentId,
      reason: input.reason,
      userId: input.userId,
    });
    return true;
  });
}

export async function unresolveShipment(input: {
  shipmentId: string;
  userId: string;
  actorEmail: string;
  ipAddress?: string | null;
}): Promise<boolean> {
  return transaction(async (client) => {
    const { rows } = await client.query<{ id: string; resolution_reason: string | null }>(
      `UPDATE shipments
          SET manually_resolved = FALSE,
              manually_resolved_by = NULL,
              manually_resolved_at = NULL,
              resolution_reason = NULL,
              resolution_note = NULL
        WHERE id = $1 AND manually_resolved = TRUE
        RETURNING id, resolution_reason`,
      [input.shipmentId],
    );

    if (rows.length === 0) return false;

    await client.query(
      `INSERT INTO audit_log (user_id, actor_email, action, entity_type, entity_id, detail, ip_address)
       VALUES ($1, $2, 'shipment.unresolve', 'shipment', $3, $4, $5)`,
      [
        input.userId,
        input.actorEmail,
        input.shipmentId,
        JSON.stringify({ previousReason: rows[0]!.resolution_reason }),
        input.ipAddress ?? null,
      ],
    );
    return true;
  });
}

export async function addNote(input: {
  shipmentId: string;
  body: string;
  userId: string;
  authorName: string;
  actorEmail: string;
  ipAddress?: string | null;
}): Promise<{ id: string; created_at: Date } | null> {
  return transaction(async (client) => {
    const exists = await client.query('SELECT 1 FROM shipments WHERE id = $1', [input.shipmentId]);
    if (exists.rows.length === 0) return null;

    const { rows } = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO shipment_notes (shipment_id, user_id, author_name, body)
       VALUES ($1, $2, $3, $4)
       RETURNING id::text, created_at`,
      [input.shipmentId, input.userId, input.authorName, input.body],
    );

    await client.query(
      `INSERT INTO audit_log (user_id, actor_email, action, entity_type, entity_id, detail, ip_address)
       VALUES ($1, $2, 'shipment.note', 'shipment', $3, $4, $5)`,
      [
        input.userId,
        input.actorEmail,
        input.shipmentId,
        JSON.stringify({ length: input.body.length }),
        input.ipAddress ?? null,
      ],
    );

    return rows[0] ?? null;
  });
}

export async function getAuditTrail(entityId: string, limit = 50) {
  return query<{
    id: string;
    action: string;
    actor_email: string | null;
    detail: Record<string, unknown> | null;
    created_at: Date;
  }>(
    `SELECT id::text, action, actor_email, detail, created_at
       FROM audit_log
      WHERE entity_type = 'shipment' AND entity_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [entityId, limit],
  );
}
