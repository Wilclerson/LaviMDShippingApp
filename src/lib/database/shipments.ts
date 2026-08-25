/**
 * Shipment persistence.
 *
 * The upsert here is the only writer of shipment rows during a sync. It is
 * built around one promise: an API failure or a thinner-than-usual response
 * must never destroy information we already hold. Every column is written with
 * COALESCE(new, existing) semantics unless the new value is genuinely better,
 * and the historical timestamps are additionally protected by database
 * triggers (see 001_init.sql).
 */

import { query, queryOne, transaction } from './pool';
import { logger } from '../logger';
import type { MergedShipment } from '../shipment-normalizer/merge';
import type { CarrierEvent, NormalizedStatus, ShipmentRow, ShipmentSource } from '../types';

export interface UpsertResult {
  id: string;
  created: boolean;
  eventsInserted: number;
}

/**
 * Insert or update one shipment plus its carrier events.
 *
 * Runs in a transaction so a shipment and its events land together.
 */
export async function upsertShipment(merged: MergedShipment): Promise<UpsertResult> {
  return transaction(async (client) => {
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM shipments WHERE tracking_number = $1',
      [merged.trackingNumber],
    );
    const created = existing.rows.length === 0;

    const { rows } = await client.query<{ id: string }>(
      `
      INSERT INTO shipments (
        tracking_number, source, source_store, shipstation_store_id,
        customer_name, company_name, order_number,
        shipstation_order_id, shipstation_shipment_id, shipstation_label_id, shipstation_status,
        carrier, service,
        label_created_at, ship_date, first_carrier_scan_at, delivered_at,
        destination_city, destination_state, destination_postal_code, destination_country,
        ups_status, ups_status_code, ups_status_type, normalized_status,
        latest_tracking_event, latest_tracking_event_at, exception_type, has_physical_scan,
        last_synced_at, raw_shipstation, raw_ups
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13,
        $14, $15, $16, $17,
        $18, $19, $20, $21,
        $22, $23, $24, $25,
        $26, $27, $28, $29,
        NOW(), $30, $31
      )
      ON CONFLICT (tracking_number) DO UPDATE SET
        -- Source only ever narrows from wholesale to shipstation: once
        -- ShipStation claims a tracking number it is not wholesale work.
        source = CASE
          WHEN EXCLUDED.source = 'shipstation' THEN EXCLUDED.source
          ELSE shipments.source
        END,
        source_store = CASE
          WHEN EXCLUDED.source = 'shipstation' THEN COALESCE(EXCLUDED.source_store, shipments.source_store)
          ELSE COALESCE(shipments.source_store, EXCLUDED.source_store)
        END,
        shipstation_store_id     = COALESCE(EXCLUDED.shipstation_store_id, shipments.shipstation_store_id),

        -- Identity fields: a later sync may enrich them but must not blank them.
        customer_name            = COALESCE(EXCLUDED.customer_name, shipments.customer_name),
        company_name             = COALESCE(EXCLUDED.company_name, shipments.company_name),
        order_number             = COALESCE(EXCLUDED.order_number, shipments.order_number),
        shipstation_order_id     = COALESCE(EXCLUDED.shipstation_order_id, shipments.shipstation_order_id),
        shipstation_shipment_id  = COALESCE(EXCLUDED.shipstation_shipment_id, shipments.shipstation_shipment_id),
        shipstation_label_id     = COALESCE(EXCLUDED.shipstation_label_id, shipments.shipstation_label_id),
        shipstation_status       = COALESCE(EXCLUDED.shipstation_status, shipments.shipstation_status),
        carrier                  = COALESCE(EXCLUDED.carrier, shipments.carrier),
        service                  = COALESCE(EXCLUDED.service, shipments.service),

        -- Historical timestamps: keep the EARLIEST observation, never lose one.
        label_created_at         = LEAST(
                                     COALESCE(shipments.label_created_at, EXCLUDED.label_created_at),
                                     COALESCE(EXCLUDED.label_created_at, shipments.label_created_at)),
        first_carrier_scan_at    = LEAST(
                                     COALESCE(shipments.first_carrier_scan_at, EXCLUDED.first_carrier_scan_at),
                                     COALESCE(EXCLUDED.first_carrier_scan_at, shipments.first_carrier_scan_at)),
        ship_date                = COALESCE(shipments.ship_date, EXCLUDED.ship_date),
        -- Delivery is terminal: keep it once seen.
        delivered_at             = COALESCE(shipments.delivered_at, EXCLUDED.delivered_at),

        destination_city         = COALESCE(EXCLUDED.destination_city, shipments.destination_city),
        destination_state        = COALESCE(EXCLUDED.destination_state, shipments.destination_state),
        destination_postal_code  = COALESCE(EXCLUDED.destination_postal_code, shipments.destination_postal_code),
        destination_country      = COALESCE(EXCLUDED.destination_country, shipments.destination_country),

        -- Live carrier status: UPS is authoritative, so take the new value when
        -- we actually have one.
        ups_status               = COALESCE(EXCLUDED.ups_status, shipments.ups_status),
        ups_status_code          = COALESCE(EXCLUDED.ups_status_code, shipments.ups_status_code),
        ups_status_type          = COALESCE(EXCLUDED.ups_status_type, shipments.ups_status_type),
        normalized_status        = EXCLUDED.normalized_status,
        exception_type           = COALESCE(EXCLUDED.exception_type, shipments.exception_type),

        -- Only advance the "latest event" pointer; never rewind it.
        latest_tracking_event    = CASE
          WHEN EXCLUDED.latest_tracking_event_at IS NOT NULL
           AND (shipments.latest_tracking_event_at IS NULL
                OR EXCLUDED.latest_tracking_event_at >= shipments.latest_tracking_event_at)
          THEN EXCLUDED.latest_tracking_event
          ELSE shipments.latest_tracking_event
        END,
        latest_tracking_event_at = GREATEST(
                                     COALESCE(shipments.latest_tracking_event_at, EXCLUDED.latest_tracking_event_at),
                                     COALESCE(EXCLUDED.latest_tracking_event_at, shipments.latest_tracking_event_at)),

        has_physical_scan        = shipments.has_physical_scan OR EXCLUDED.has_physical_scan,
        last_synced_at           = NOW(),
        raw_shipstation          = COALESCE(EXCLUDED.raw_shipstation, shipments.raw_shipstation),
        raw_ups                  = COALESCE(EXCLUDED.raw_ups, shipments.raw_ups)
      RETURNING id
      `,
      [
        merged.trackingNumber,
        merged.source,
        merged.sourceStore,
        merged.shipstationStoreId,
        merged.customerName,
        merged.companyName,
        merged.orderNumber,
        merged.shipstationOrderId,
        merged.shipstationShipmentId,
        merged.shipstationLabelId,
        merged.shipstationStatus,
        merged.carrier,
        merged.service,
        merged.labelCreatedAt,
        merged.shipDate,
        merged.firstCarrierScanAt,
        merged.deliveredAt,
        merged.destinationCity,
        merged.destinationState,
        merged.destinationPostalCode,
        merged.destinationCountry,
        merged.upsStatus,
        merged.upsStatusCode,
        merged.upsStatusType,
        merged.normalizedStatus,
        merged.latestTrackingEvent,
        merged.latestTrackingEventAt,
        merged.exceptionType,
        merged.hasPhysicalScan,
        merged.rawShipStation ? JSON.stringify(merged.rawShipStation) : null,
        merged.rawUps ? JSON.stringify(merged.rawUps) : null,
      ],
    );

    const shipmentId = rows[0]?.id;
    if (!shipmentId) throw new Error(`Upsert returned no id for ${merged.trackingNumber}`);

    let eventsInserted = 0;
    for (const event of merged.events) {
      const inserted = await insertEvent(client, shipmentId, merged.trackingNumber, event);
      if (inserted) eventsInserted += 1;
    }

    return { id: shipmentId, created, eventsInserted };
  });
}

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null }> };

/** Append-only event insert. A repeat of the same scan is a silent no-op. */
async function insertEvent(
  client: Queryable,
  shipmentId: string,
  trackingNumber: string,
  event: CarrierEvent,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO shipment_events (
       shipment_id, tracking_number, occurred_at, description,
       status_code, status_type, location_city, location_state, location_country,
       is_physical_scan, event_source, dedup_key, raw
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (shipment_id, dedup_key) DO NOTHING`,
    [
      shipmentId,
      trackingNumber,
      event.occurredAt,
      event.description,
      event.statusCode,
      event.statusType,
      event.locationCity,
      event.locationState,
      event.locationCountry,
      event.isPhysicalScan,
      event.eventSource,
      event.dedupKey,
      event.raw ? JSON.stringify(event.raw) : null,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Which of these tracking numbers do we already know about? */
export async function findExistingTrackingNumbers(
  trackingNumbers: string[],
): Promise<Map<string, { id: string; source: ShipmentSource }>> {
  if (trackingNumbers.length === 0) return new Map();
  const rows = await query<{ id: string; tracking_number: string; source: ShipmentSource }>(
    'SELECT id, tracking_number, source FROM shipments WHERE tracking_number = ANY($1::text[])',
    [trackingNumbers],
  );
  return new Map(rows.map((r) => [r.tracking_number, { id: r.id, source: r.source }]));
}

export interface KnownShipmentState {
  labelCreatedAt: Date | null;
  firstCarrierScanAt: Date | null;
  manuallyResolved: boolean;
  physicalScanCount: number;
}

/**
 * Load the prior state needed to merge without losing history.
 * Batched so a sync makes one round-trip rather than one per shipment.
 */
export async function loadKnownStates(
  trackingNumbers: string[],
): Promise<Map<string, KnownShipmentState>> {
  if (trackingNumbers.length === 0) return new Map();
  const rows = await query<{
    tracking_number: string;
    label_created_at: Date | null;
    first_carrier_scan_at: Date | null;
    manually_resolved: boolean;
    physical_scan_count: string;
  }>(
    `SELECT s.tracking_number, s.label_created_at, s.first_carrier_scan_at, s.manually_resolved,
            COALESCE(e.physical_scan_count, 0)::text AS physical_scan_count
       FROM shipments s
       LEFT JOIN (
         SELECT shipment_id, COUNT(*) AS physical_scan_count
           FROM shipment_events
          WHERE is_physical_scan = TRUE
          GROUP BY shipment_id
       ) e ON e.shipment_id = s.id
      WHERE s.tracking_number = ANY($1::text[])`,
    [trackingNumbers],
  );

  return new Map(
    rows.map((r) => [
      r.tracking_number,
      {
        labelCreatedAt: r.label_created_at,
        firstCarrierScanAt: r.first_carrier_scan_at,
        manuallyResolved: r.manually_resolved,
        physicalScanCount: Number.parseInt(r.physical_scan_count, 10) || 0,
      },
    ]),
  );
}

/**
 * Tracking numbers that still need a UPS lookup, most urgent first.
 *
 * Ordering matters because the per-run lookup budget is finite: unresolved
 * label-only shipments are the ones the business needs an answer about, so
 * they are polled before packages already confirmed in transit.
 */
export async function selectTrackingRefreshCandidates(limit: number): Promise<string[]> {
  const rows = await query<{ tracking_number: string }>(
    `SELECT tracking_number
       FROM shipments
      WHERE carrier ILIKE '%UPS%'
        AND manually_resolved = FALSE
        AND normalized_status <> 'VOIDED'
        AND (
          delivered_at IS NULL
          OR delivered_at > NOW() - ($2 || ' days')::interval
        )
      ORDER BY
        -- 1. label-only shipments: the open question this app exists to answer
        (has_physical_scan = FALSE) DESC,
        -- 2. never checked at all
        (last_tracking_check_at IS NULL) DESC,
        -- 3. staleness
        last_tracking_check_at ASC NULLS FIRST
      LIMIT $1`,
    [limit, String(7)],
  );
  return rows.map((r) => r.tracking_number);
}

export async function markTrackingChecked(trackingNumbers: string[]): Promise<void> {
  if (trackingNumbers.length === 0) return;
  await query(
    'UPDATE shipments SET last_tracking_check_at = NOW() WHERE tracking_number = ANY($1::text[])',
    [trackingNumbers],
  );
}

/**
 * Re-evaluate statuses for shipments whose age has crossed the aging threshold
 * since the last sync. Nothing about the shipment changed; time passed.
 */
export async function refreshAgingLabels(thresholdHours: number): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE shipments
        SET normalized_status = 'AGING_LABEL'
      WHERE normalized_status = 'LABEL_CREATED'
        AND has_physical_scan = FALSE
        AND manually_resolved = FALSE
        AND label_created_at IS NOT NULL
        AND label_created_at <= NOW() - ($1 || ' hours')::interval
      RETURNING id`,
    [String(thresholdHours)],
  );
  if (rows.length > 0) logger.info('labels escalated to aging', { count: rows.length });
  return rows.length;
}

export async function getShipmentById(id: string): Promise<ShipmentRow | null> {
  return queryOne<ShipmentRow>(
    `SELECT id, tracking_number, source, source_store, shipstation_store_id, customer_name,
            company_name, order_number, shipstation_order_id, shipstation_shipment_id,
            shipstation_label_id, shipstation_status, carrier, service, label_created_at,
            ship_date, first_carrier_scan_at, delivered_at, destination_city, destination_state,
            destination_postal_code, destination_country, ups_status, ups_status_code,
            ups_status_type, normalized_status, latest_tracking_event, latest_tracking_event_at,
            exception_type, has_physical_scan, first_seen_at, last_synced_at,
            last_tracking_check_at, manually_resolved, manually_resolved_by,
            manually_resolved_at, resolution_reason, resolution_note, notes,
            created_at, updated_at
       FROM shipments WHERE id = $1`,
    [id],
  );
}

export async function getShipmentEvents(shipmentId: string) {
  return query<{
    id: string;
    occurred_at: Date;
    description: string;
    status_code: string | null;
    status_type: string | null;
    location_city: string | null;
    location_state: string | null;
    location_country: string | null;
    is_physical_scan: boolean;
    event_source: string;
  }>(
    `SELECT id, occurred_at, description, status_code, status_type,
            location_city, location_state, location_country, is_physical_scan, event_source
       FROM shipment_events
      WHERE shipment_id = $1
      ORDER BY occurred_at ASC, id ASC`,
    [shipmentId],
  );
}

export async function getStatusHistory(shipmentId: string) {
  return query<{ from_status: NormalizedStatus | null; to_status: NormalizedStatus; changed_at: Date; reason: string | null }>(
    `SELECT from_status, to_status, changed_at, reason
       FROM shipment_status_history
      WHERE shipment_id = $1
      ORDER BY changed_at ASC, id ASC`,
    [shipmentId],
  );
}
