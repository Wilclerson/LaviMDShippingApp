/**
 * Sync orchestration.
 *
 * Three passes, each independently recoverable:
 *
 *   1. ShipStation  — pull recently created labels, enrich with the shipment
 *                     record, keep the ones from the Lavi MD stores.
 *   2. Quantum View — pull UPS account activity. This is what discovers labels
 *                     Danielle created directly in UPS, and it supplies the
 *                     authoritative Origin (possession) scan.
 *   3. Tracking     — poll UPS tracking for shipments we already know about,
 *                     prioritising the ones with no physical scan yet.
 *
 * Failure policy: a failing pass is logged and recorded, and the remaining
 * passes still run. A sync NEVER deletes or blanks existing shipment data — the
 * worst case is that a record goes un-refreshed for a cycle.
 */

import { env } from '../env';
import { logger } from '../logger';
import { query, queryOne } from '../database/pool';
import {
  upsertShipment,
  loadKnownStates,
  selectTrackingRefreshCandidates,
  markTrackingChecked,
  refreshAgingLabels,
  findExistingTrackingNumbers,
} from '../database/shipments';
import { mergeShipment, quantumViewToUpsFacts } from '../shipment-normalizer/merge';
import { lookupShipStationOrigin } from '../shipstation/origin-lookup';
import * as shipstation from '../shipstation/client';
import { toShipStationFacts, buildStoreResolver, isStoreInScope, isUpsCarrier } from '../shipstation/normalize';
import { fetchQuantumViewShipments } from '../ups/quantum-view';
import { trackPackage } from '../ups/tracking';
import { HttpError } from '../http/fetch';
import type { ShipStationShipmentFacts, UpsShipmentFacts } from '../types';

const log = logger.child({ component: 'sync' });

export interface PassResult {
  source: string;
  status: 'success' | 'partial' | 'failed' | 'skipped';
  seen: number;
  created: number;
  updated: number;
  events: number;
  errors: number;
  errorMessage?: string;
  detail?: Record<string, unknown>;
}

export interface SyncResult {
  runId: string | null;
  passes: PassResult[];
  agingEscalated: number;
  durationMs: number;
  ok: boolean;
}

async function startRun(source: string, triggeredBy: string): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO sync_runs (source, status, triggered_by) VALUES ($1, 'running', $2) RETURNING id`,
    [source, triggeredBy],
  );
  return row?.id ?? null;
}

async function finishRun(runId: string | null, result: PassResult, startedAt: number): Promise<void> {
  if (!runId) return;
  await query(
    `UPDATE sync_runs
        SET status = $2, finished_at = NOW(), duration_ms = $3,
            records_seen = $4, records_created = $5, records_updated = $6,
            events_recorded = $7, error_count = $8, error_message = $9, detail = $10
      WHERE id = $1`,
    [
      runId,
      result.status,
      Date.now() - startedAt,
      result.seen,
      result.created,
      result.updated,
      result.events,
      result.errors,
      result.errorMessage ?? null,
      result.detail ? JSON.stringify(result.detail) : null,
    ],
  );
}

async function logError(scope: string, message: string, detail?: unknown): Promise<void> {
  try {
    await query('INSERT INTO error_log (scope, message, detail) VALUES ($1, $2, $3)', [
      scope,
      message.slice(0, 1000),
      detail ? JSON.stringify(detail).slice(0, 8000) : null,
    ]);
  } catch (err) {
    log.error('failed to persist error log entry', { error: err });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Is this Quantum View telling us the account simply is not entitled to it?
 *
 * Quantum View needs a subscription configured on the UPS account, which is
 * separate from the developer app's API grant. Without it UPS answers
 * `400 / 330050 Invalid QV user` — verified live, invariant across every
 * request shape, window and API version, while the SAME token drives Tracking
 * happily.
 *
 * That is a configuration state, not a sync failure. ShipStation is the
 * authoritative discovery source and UPS Tracking the authoritative possession
 * source; Quantum View only adds completeness for labels that never touch
 * ShipStation. So an unentitled account degrades this pass to "skipped" and the
 * run still succeeds, rather than painting the dashboard red every 20 minutes
 * over an optional feature.
 */
const QV_UNAVAILABLE_CODES = ['330050', '330051', '250002', '250003'];

export function isQuantumViewUnavailable(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  if (err.status === 401 || err.status === 403) return true;
  if (err.status !== 400) return false;
  const body = err.body ?? '';
  return (
    QV_UNAVAILABLE_CODES.some((code) => body.includes(code)) ||
    /invalid qv user|not subscribed|no subscription/i.test(body)
  );
}

// --- Pass 1: ShipStation ------------------------------------------------------

export async function syncShipStation(triggeredBy: string): Promise<PassResult> {
  const result: PassResult = {
    source: 'shipstation',
    status: 'success',
    seen: 0,
    created: 0,
    updated: 0,
    events: 0,
    errors: 0,
  };

  if (!env.shipstation.configured()) {
    return { ...result, status: 'skipped', errorMessage: 'SHIPSTATION_API_KEY is not configured.' };
  }

  const startedAt = Date.now();
  const runId = await startRun('shipstation', triggeredBy);

  try {
    const stores = await shipstation.listStores().catch(() => []);
    const resolver = buildStoreResolver(stores);

    if (resolver.allowedIds.size === 0 && resolver.allowedNames.size === 0) {
      log.warn(
        'no ShipStation store filter configured; ingesting every store. Set SHIPSTATION_STORE_IDS or SHIPSTATION_STORE_NAMES.',
      );
    }

    const since = new Date(Date.now() - env.tuning.syncLookbackHours * 3_600_000);
    const facts: ShipStationShipmentFacts[] = [];
    // Shipment lookups are cached per run: several labels can share a shipment.
    const shipmentCache = new Map<string, shipstation.RawShipment | null>();

    let page = 1;
    let pages = 1;
    let outOfScope = 0;
    let nonUps = 0;

    while (page <= pages && page <= 50) {
      const batch = await shipstation.listLabels({ createdAtStart: since, page, pageSize: 100 });
      pages = batch.pages;
      result.seen += batch.items.length;

      for (const label of batch.items) {
        if (!label.tracking_number) continue;

        const shipmentId = typeof label.shipment_id === 'string' ? label.shipment_id : null;
        let shipment: shipstation.RawShipment | null = null;
        if (shipmentId) {
          if (!shipmentCache.has(shipmentId)) {
            try {
              shipmentCache.set(shipmentId, await shipstation.getShipment(shipmentId));
            } catch (err) {
              // A failed enrichment must not drop the label — the tracking
              // number and label timestamp are the audit-critical facts.
              log.warn('shipment enrichment failed; keeping label without it', {
                shipmentId,
                error: err,
              });
              shipmentCache.set(shipmentId, null);
              result.errors += 1;
            }
          }
          shipment = shipmentCache.get(shipmentId) ?? null;
        }

        const storeId =
          shipment && typeof shipment.store_id !== 'undefined' ? String(shipment.store_id) : null;
        const storeName = storeId ? (resolver.nameById.get(storeId) ?? null) : null;

        if (!isStoreInScope(storeId, storeName, resolver)) {
          outOfScope += 1;
          continue;
        }

        const fact = toShipStationFacts(label, shipment, resolver);
        if (!fact) continue;

        // This audit is about UPS possession; other carriers are recorded but
        // never expected to gain a UPS scan. A UPS 1Z tracking number counts as
        // UPS even when the carrier code says otherwise (Worldwide Express
        // resells UPS labels as `wwex_parcel`).
        if (!isUpsCarrier(fact.carrier, fact.trackingNumber)) nonUps += 1;

        facts.push(fact);
      }

      if (batch.items.length === 0) break;
      page += 1;
    }

    const knownStates = await loadKnownStates(facts.map((f) => f.trackingNumber));

    for (const fact of facts) {
      try {
        const known = knownStates.get(fact.trackingNumber);
        const merged = mergeShipment(fact, null, {
          agingThresholdHours: env.tuning.agingLabelHours,
          manuallyResolved: known?.manuallyResolved ?? false,
          knownLabelCreatedAt: known?.labelCreatedAt ?? null,
          knownFirstCarrierScanAt: known?.firstCarrierScanAt ?? null,
          knownPhysicalScanCount: known?.physicalScanCount ?? 0,
          knownDeliveredAt: known?.deliveredAt ?? null,
          knownExceptionType: known?.exceptionType ?? null,
          knownVoided: known?.voided ?? false,
        });
        const upserted = await upsertShipment(merged);
        if (upserted.created) result.created += 1;
        else result.updated += 1;
        result.events += upserted.eventsInserted;
      } catch (err) {
        result.errors += 1;
        log.error('failed to persist ShipStation shipment', {
          trackingNumber: fact.trackingNumber,
          error: err,
        });
      }
    }

    result.detail = { outOfScope, nonUps, pagesRead: page - 1, storesKnown: resolver.nameById.size };
    if (result.errors > 0) result.status = 'partial';
  } catch (err) {
    result.status = 'failed';
    result.errors += 1;
    result.errorMessage = errorMessage(err);
    log.error('ShipStation sync failed', { error: err });
    await logError('shipstation', result.errorMessage);
  }

  await finishRun(runId, result, startedAt);
  return result;
}

// --- Pass 2: UPS Quantum View -------------------------------------------------

export async function syncQuantumView(triggeredBy: string): Promise<PassResult> {
  const result: PassResult = {
    source: 'ups_quantum_view',
    status: 'success',
    seen: 0,
    created: 0,
    updated: 0,
    events: 0,
    errors: 0,
  };

  if (!env.ups.configured()) {
    return { ...result, status: 'skipped', errorMessage: 'UPS credentials are not configured.' };
  }
  if (!env.ups.quantumViewEnabled) {
    return { ...result, status: 'skipped', errorMessage: 'Quantum View polling is disabled.' };
  }

  const startedAt = Date.now();
  const runId = await startRun('ups_quantum_view', triggeredBy);

  try {
    // UPS retains Quantum View subscription data for 7 days. Ask for the
    // configured lookback, clamped to that limit.
    const lookbackHours = Math.min(env.tuning.syncLookbackHours, 7 * 24 - 1);
    const end = new Date();
    const begin = new Date(end.getTime() - lookbackHours * 3_600_000);

    const { shipments, pages, truncated } = await fetchQuantumViewShipments({ begin, end });
    result.seen = shipments.length;

    const trackingNumbers = shipments.map((s) => s.trackingNumber);
    const knownStates = await loadKnownStates(trackingNumbers);
    const existing = await findExistingTrackingNumbers(trackingNumbers);

    let wholesaleDiscovered = 0;

    // Store names are not carried on ShipStation records and the store-listing
    // endpoints 404 on this account, so an empty resolver is the honest input;
    // the store id still reaches the shipment record.
    const storeResolver = buildStoreResolver([]);
    let inconclusive = 0;

    for (const shipment of shipments) {
      try {
        const known = knownStates.get(shipment.trackingNumber);
        const upsFacts = quantumViewToUpsFacts(shipment);

        // Absence from OUR database is not absence from ShipStation — the
        // database only holds the configured stores. Before calling anything
        // wholesale, ask ShipStation across every store.
        const alreadyKnown = existing.get(shipment.trackingNumber);
        let shipstationFacts: ShipStationShipmentFacts | null = null;

        if (alreadyKnown?.source !== 'shipstation') {
          try {
            shipstationFacts = await lookupShipStationOrigin(
              shipment.trackingNumber,
              storeResolver,
            );
          } catch (err) {
            // Inconclusive: we must not guess. Defer to the next cycle rather
            // than write "Wholesale / Danielle" over a real ShipStation order.
            inconclusive += 1;
            result.errors += 1;
            log.warn('ShipStation origin lookup inconclusive; deferring shipment', {
              trackingNumber: shipment.trackingNumber,
              error: err,
            });
            continue;
          }
          if (!shipstationFacts && !alreadyKnown) wholesaleDiscovered += 1;
        }

        const merged = mergeShipment(shipstationFacts, upsFacts, {
          agingThresholdHours: env.tuning.agingLabelHours,
          manuallyResolved: known?.manuallyResolved ?? false,
          knownLabelCreatedAt: known?.labelCreatedAt ?? null,
          knownFirstCarrierScanAt: known?.firstCarrierScanAt ?? null,
          knownPhysicalScanCount: known?.physicalScanCount ?? 0,
          knownDeliveredAt: known?.deliveredAt ?? null,
          knownExceptionType: known?.exceptionType ?? null,
          knownVoided: known?.voided ?? false,
        });

        const upserted = await upsertShipment(merged);
        if (upserted.created) result.created += 1;
        else result.updated += 1;
        result.events += upserted.eventsInserted;
      } catch (err) {
        result.errors += 1;
        log.error('failed to persist Quantum View shipment', {
          trackingNumber: shipment.trackingNumber,
          error: err,
        });
      }
    }

    result.detail = { pages, truncated, wholesaleDiscovered, inconclusive };
    if (result.errors > 0 || truncated) result.status = 'partial';
  } catch (err) {
    if (isQuantumViewUnavailable(err)) {
      // Optional feature, unavailable on this account. Not a sync failure.
      result.status = 'skipped';
      result.errorMessage =
        'Quantum View is not available on this UPS account (no subscription). ' +
        'ShipStation and UPS Tracking are unaffected; wholesale-only labels stay undiscovered until it is enabled.';
      log.warn('Quantum View unavailable; continuing without it', { error: err });
    } else {
      result.status = 'failed';
      result.errors += 1;
      result.errorMessage = errorMessage(err);
      log.error('Quantum View sync failed', { error: err });
      await logError('ups', `Quantum View: ${result.errorMessage}`);
    }
  }

  await finishRun(runId, result, startedAt);
  return result;
}

// --- Pass 3: UPS tracking refresh --------------------------------------------

export async function syncUpsTracking(
  triggeredBy: string,
  options: { limit?: number } = {},
): Promise<PassResult> {
  const result: PassResult = {
    source: 'ups_tracking',
    status: 'success',
    seen: 0,
    created: 0,
    updated: 0,
    events: 0,
    errors: 0,
  };

  if (!env.ups.configured()) {
    return { ...result, status: 'skipped', errorMessage: 'UPS credentials are not configured.' };
  }

  const startedAt = Date.now();
  const runId = await startRun('ups_tracking', triggeredBy);

  try {
    const limit = options.limit ?? env.tuning.trackingMaxLookupsPerRun;
    const candidates = await selectTrackingRefreshCandidates(limit);
    result.seen = candidates.length;

    const knownStates = await loadKnownStates(candidates);
    const checked: string[] = [];
    let notFound = 0;
    let consecutiveFailures = 0;

    for (const trackingNumber of candidates) {
      try {
        const facts: UpsShipmentFacts | null = await trackPackage(trackingNumber);
        checked.push(trackingNumber);
        consecutiveFailures = 0;

        if (!facts) {
          // UPS has no record yet. That is a meaningful audit result: the label
          // exists but UPS has not even ingested it. Nothing to write.
          notFound += 1;
          continue;
        }

        const known = knownStates.get(trackingNumber);
        const merged = mergeShipment(null, facts, {
          agingThresholdHours: env.tuning.agingLabelHours,
          manuallyResolved: known?.manuallyResolved ?? false,
          knownLabelCreatedAt: known?.labelCreatedAt ?? null,
          knownFirstCarrierScanAt: known?.firstCarrierScanAt ?? null,
          knownPhysicalScanCount: known?.physicalScanCount ?? 0,
          knownDeliveredAt: known?.deliveredAt ?? null,
          knownExceptionType: known?.exceptionType ?? null,
          knownVoided: known?.voided ?? false,
        });

        const upserted = await upsertShipment(merged);
        if (upserted.created) result.created += 1;
        else result.updated += 1;
        result.events += upserted.eventsInserted;
      } catch (err) {
        result.errors += 1;
        consecutiveFailures += 1;
        log.warn('tracking lookup failed', { trackingNumber, error: err });

        // A run of failures means UPS is unhappy with us (auth, outage, rate
        // limit). Stop hammering it; the next cycle picks up where we left off.
        if (consecutiveFailures >= 5) {
          result.errorMessage = 'Aborted after 5 consecutive UPS tracking failures.';
          log.error(result.errorMessage);
          await logError('ups', result.errorMessage);
          break;
        }
      }
    }

    await markTrackingChecked(checked);
    result.detail = { notFound, checked: checked.length, budget: limit };
    if (result.errors > 0) result.status = 'partial';
  } catch (err) {
    result.status = 'failed';
    result.errors += 1;
    result.errorMessage = errorMessage(err);
    log.error('UPS tracking sync failed', { error: err });
    await logError('ups', `Tracking: ${result.errorMessage}`);
  }

  await finishRun(runId, result, startedAt);
  return result;
}

// --- Full sync ----------------------------------------------------------------

export async function runFullSync(triggeredBy: string): Promise<SyncResult> {
  const startedAt = Date.now();
  log.info('sync started', { triggeredBy });

  // Sequential by design: Quantum View benefits from ShipStation having just
  // claimed its tracking numbers, and tracking refresh benefits from both.
  const passes: PassResult[] = [];
  passes.push(await syncShipStation(triggeredBy));
  passes.push(await syncQuantumView(triggeredBy));
  passes.push(await syncUpsTracking(triggeredBy));

  // Time alone can change a status, so re-evaluate aging after the data passes.
  const agingEscalated = await refreshAgingLabels(env.tuning.agingLabelHours);

  const durationMs = Date.now() - startedAt;
  const ok = passes.every((p) => p.status === 'success' || p.status === 'skipped');

  log.info('sync finished', {
    durationMs,
    ok,
    agingEscalated,
    passes: passes.map((p) => ({ source: p.source, status: p.status, seen: p.seen })),
  });

  return { runId: null, passes, agingEscalated, durationMs, ok };
}

// --- Health -------------------------------------------------------------------

export interface SyncHealth {
  source: string;
  lastSuccessAt: Date | null;
  lastAttemptAt: Date | null;
  lastStatus: string | null;
  lastErrorMessage: string | null;
  stale: boolean;
}

/** Powers the dashboard's "synchronisation has failed" warning. */
export async function getSyncHealth(staleAfterMinutes = 90): Promise<SyncHealth[]> {
  const rows = await query<{
    source: string;
    last_success_at: Date | null;
    last_attempt_at: Date | null;
    last_status: string | null;
    last_error_message: string | null;
  }>(
    `SELECT source,
            MAX(finished_at) FILTER (WHERE status IN ('success','partial')) AS last_success_at,
            MAX(started_at) AS last_attempt_at,
            (ARRAY_AGG(status ORDER BY started_at DESC))[1] AS last_status,
            (ARRAY_AGG(error_message ORDER BY started_at DESC))[1] AS last_error_message
       FROM sync_runs
      WHERE started_at > NOW() - INTERVAL '7 days'
      GROUP BY source`,
  );

  const threshold = Date.now() - staleAfterMinutes * 60_000;
  return rows.map((r) => ({
    source: r.source,
    lastSuccessAt: r.last_success_at,
    lastAttemptAt: r.last_attempt_at,
    lastStatus: r.last_status,
    lastErrorMessage: r.last_error_message,
    stale: !r.last_success_at || r.last_success_at.getTime() < threshold,
  }));
}

export async function getLastSuccessfulSyncAt(): Promise<Date | null> {
  const row = await queryOne<{ last_success: Date | null }>(
    `SELECT MAX(finished_at) AS last_success FROM sync_runs WHERE status IN ('success','partial')`,
  );
  return row?.last_success ?? null;
}
