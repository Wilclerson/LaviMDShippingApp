/**
 * The merge / deduplication engine.
 *
 * RULE: the tracking number is the primary matching key. If a ShipStation
 * tracking number equals a UPS tracking number, that is ONE shipment — never
 * two records.
 *
 * Field authority when both sides describe the same shipment:
 *
 *   ShipStation is authoritative for  →  customer, order number, store/source
 *   UPS is authoritative for          →  carrier status, scans, delivery
 *
 * When a tracking number exists only in UPS, it is Danielle's wholesale work:
 *   source      = wholesale_danielle  ("Wholesale / Danielle")
 *   orderNumber = null                (rendered as "—")
 */

import type {
  NormalizedStatus,
  ShipStationShipmentFacts,
  ShipmentSource,
  UpsShipmentFacts,
  CarrierEvent,
} from '../types';
import { WHOLESALE_SOURCE_LABEL } from '../types';
import { deriveStatus, refineMovementStatus } from './status';

/** The complete, merged picture of one shipment, ready to persist. */
export interface MergedShipment {
  trackingNumber: string;
  source: ShipmentSource;
  sourceStore: string | null;
  shipstationStoreId: string | null;

  customerName: string | null;
  companyName: string | null;
  orderNumber: string | null;
  shipstationOrderId: string | null;
  shipstationShipmentId: string | null;
  shipstationLabelId: string | null;
  shipstationStatus: string | null;

  carrier: string | null;
  service: string | null;

  labelCreatedAt: Date | null;
  shipDate: string | null;
  firstCarrierScanAt: Date | null;
  deliveredAt: Date | null;

  destinationCity: string | null;
  destinationState: string | null;
  destinationPostalCode: string | null;
  destinationCountry: string | null;

  upsStatus: string | null;
  upsStatusCode: string | null;
  upsStatusType: string | null;
  normalizedStatus: NormalizedStatus;

  latestTrackingEvent: string | null;
  latestTrackingEventAt: Date | null;
  exceptionType: string | null;
  hasPhysicalScan: boolean;

  events: CarrierEvent[];
  rawShipStation: unknown;
  rawUps: unknown;
}

export interface MergeOptions {
  agingThresholdHours: number;
  now?: Date;
  /** Preserved across syncs so a resolved shipment is not re-flagged. */
  manuallyResolved?: boolean;
  /**
   * The earliest physical scan we have already recorded for this shipment.
   * Historical timestamps are never lost when a later API response omits them.
   */
  knownFirstCarrierScanAt?: Date | null;
  knownLabelCreatedAt?: Date | null;
  /** Physical scans already stored, so SHIPPED vs IN_TRANSIT stays correct. */
  knownPhysicalScanCount?: number;

  /**
   * Terminal facts already recorded for this shipment.
   *
   * Each sync pass only holds part of the picture: the ShipStation pass knows
   * nothing about delivery, and the Quantum View pass may not see a void that
   * ShipStation reported. Without these, a pass would compute a status from its
   * own narrow view and downgrade a DELIVERED shipment back to IN_TRANSIT on
   * the next run. Delivery, exceptions and voids are therefore carried into
   * every merge so any pass derives the same, complete status.
   */
  knownDeliveredAt?: Date | null;
  knownExceptionType?: string | null;
  knownVoided?: boolean;
}

/** Prefer the first non-null value. */
function coalesce<T>(...values: (T | null | undefined)[]): T | null {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return null;
}

/** Earliest of the supplied dates; nulls ignored. */
function earliest(...dates: (Date | null | undefined)[]): Date | null {
  const valid = dates.filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()));
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
}

/** Latest of the supplied dates; nulls ignored. */
function latest(...dates: (Date | null | undefined)[]): Date | null {
  const valid = dates.filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()));
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
}

/** Merge event lists, dropping duplicates by dedup key. */
function mergeEvents(...lists: CarrierEvent[][]): CarrierEvent[] {
  const byKey = new Map<string, CarrierEvent>();
  for (const list of lists) {
    for (const event of list) {
      const existing = byKey.get(event.dedupKey);
      // Quantum View events are richer than a bare tracking activity, so let
      // a later source fill gaps but never downgrade a physical-scan flag.
      if (existing) {
        byKey.set(event.dedupKey, {
          ...existing,
          isPhysicalScan: existing.isPhysicalScan || event.isPhysicalScan,
        });
      } else {
        byKey.set(event.dedupKey, event);
      }
    }
  }
  return [...byKey.values()].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}

/**
 * Merge one shipment from whichever sides we have.
 *
 * At least one of `shipstation` / `ups` must be present.
 */
export function mergeShipment(
  shipstation: ShipStationShipmentFacts | null,
  ups: UpsShipmentFacts | null,
  options: MergeOptions,
): MergedShipment {
  if (!shipstation && !ups) {
    throw new Error('mergeShipment requires at least one source.');
  }

  const now = options.now ?? new Date();
  const trackingNumber = (shipstation?.trackingNumber ?? ups?.trackingNumber) as string;

  // --- source attribution ---------------------------------------------------
  // A tracking number that ShipStation has never heard of is, by definition,
  // a label created directly in the UPS account.
  const source: ShipmentSource = shipstation ? 'shipstation' : 'wholesale_danielle';
  const sourceStore = shipstation ? shipstation.sourceStore : WHOLESALE_SOURCE_LABEL;

  // --- identity: ShipStation wins ------------------------------------------
  const customerName = coalesce(shipstation?.customerName, ups?.recipientName);
  const companyName = coalesce(shipstation?.companyName, ups?.companyName);
  // Wholesale shipments deliberately carry no internal order number.
  const orderNumber = shipstation ? coalesce(shipstation.orderNumber) : null;

  // --- timestamps: earliest observation wins, history is never lost ---------
  const labelCreatedAt = earliest(
    options.knownLabelCreatedAt,
    shipstation?.labelCreatedAt,
    ups?.labelCreatedAt,
  );

  const firstCarrierScanAt = earliest(options.knownFirstCarrierScanAt, ups?.firstCarrierScanAt);

  // Delivery is terminal: once observed it is never forgotten, even by a pass
  // that cannot see it.
  const deliveredAt = latest(options.knownDeliveredAt, ups?.deliveredAt);

  // --- carrier status: UPS wins --------------------------------------------
  const events = mergeEvents(ups?.events ?? []);
  const physicalScanCount = Math.max(
    options.knownPhysicalScanCount ?? 0,
    events.filter((e) => e.isPhysicalScan).length,
  );

  const voided =
    options.knownVoided === true ||
    shipstation?.voided === true ||
    (ups?.exceptionType ?? '').toLowerCase().includes('void');

  // An exception stays raised until UPS supersedes it with delivery, or an
  // administrator resolves the shipment. A pass that simply cannot see the
  // exception must not silently clear it.
  const exceptionType = coalesce(ups?.exceptionType, options.knownExceptionType);
  const hasException = Boolean(exceptionType) && !voided;

  const baseStatus = deriveStatus(
    {
      labelCreatedAt,
      firstCarrierScanAt,
      deliveredAt,
      hasException,
      voided,
      manuallyResolved: options.manuallyResolved ?? false,
      agingThresholdHours: options.agingThresholdHours,
    },
    now,
  );

  const normalizedStatus = refineMovementStatus(baseStatus, physicalScanCount);

  const latestEvent = events[events.length - 1] ?? null;

  return {
    trackingNumber,
    source,
    sourceStore,
    shipstationStoreId: shipstation?.shipstationStoreId ?? null,

    customerName,
    companyName,
    orderNumber,
    shipstationOrderId: shipstation?.shipstationOrderId ?? null,
    shipstationShipmentId: shipstation?.shipstationShipmentId ?? null,
    shipstationLabelId: shipstation?.shipstationLabelId ?? null,
    shipstationStatus: shipstation?.shipstationStatus ?? null,

    carrier: coalesce(shipstation?.carrier, ups ? 'UPS' : null),
    service: coalesce(shipstation?.service, ups?.service),

    labelCreatedAt,
    shipDate: coalesce(shipstation?.shipDate, ups?.shipDate),
    firstCarrierScanAt,
    deliveredAt,

    // Destination: ShipStation's address is the one we printed; UPS fills gaps.
    destinationCity: coalesce(shipstation?.destinationCity, ups?.destinationCity),
    destinationState: coalesce(shipstation?.destinationState, ups?.destinationState),
    destinationPostalCode: coalesce(shipstation?.destinationPostalCode, ups?.destinationPostalCode),
    destinationCountry: coalesce(shipstation?.destinationCountry, ups?.destinationCountry),

    upsStatus: ups?.upsStatus ?? null,
    upsStatusCode: ups?.upsStatusCode ?? null,
    upsStatusType: ups?.upsStatusType ?? null,
    normalizedStatus,

    latestTrackingEvent: coalesce(ups?.latestEvent, latestEvent?.description),
    latestTrackingEventAt: latest(ups?.latestEventAt, latestEvent?.occurredAt),
    exceptionType: voided ? 'Label voided' : exceptionType,
    hasPhysicalScan: firstCarrierScanAt !== null,

    events,
    rawShipStation: shipstation?.raw ?? null,
    rawUps: ups?.raw ?? null,
  };
}

/**
 * Convert Quantum View account activity into UPS facts, so a wholesale
 * shipment discovered through Quantum View flows through the same merge path
 * as a tracked one.
 */
export function quantumViewToUpsFacts(qv: {
  trackingNumber: string;
  recipientName: string | null;
  companyName: string | null;
  service: string | null;
  labelCreatedAt: Date | null;
  shipDate: string | null;
  destinationCity: string | null;
  destinationState: string | null;
  destinationPostalCode: string | null;
  destinationCountry: string | null;
  originScanAt: Date | null;
  deliveredAt: Date | null;
  exceptionType: string | null;
  events: CarrierEvent[];
}): UpsShipmentFacts {
  const latestEvent = qv.events[qv.events.length - 1] ?? null;
  return {
    trackingNumber: qv.trackingNumber,
    recipientName: qv.recipientName,
    companyName: qv.companyName,
    carrier: 'UPS',
    service: qv.service,
    labelCreatedAt: qv.labelCreatedAt,
    shipDate: qv.shipDate,
    destinationCity: qv.destinationCity,
    destinationState: qv.destinationState,
    destinationPostalCode: qv.destinationPostalCode,
    destinationCountry: qv.destinationCountry,
    upsStatus: latestEvent?.description ?? null,
    upsStatusCode: latestEvent?.statusCode ?? null,
    upsStatusType: latestEvent?.statusType ?? null,
    // A Quantum View Origin event is definitive physical possession.
    firstCarrierScanAt: qv.originScanAt,
    deliveredAt: qv.deliveredAt,
    latestEvent: latestEvent?.description ?? null,
    latestEventAt: latestEvent?.occurredAt ?? null,
    exceptionType: qv.exceptionType,
    events: qv.events,
    raw: { source: 'quantum_view', trackingNumber: qv.trackingNumber },
  };
}

/**
 * Combine two UPS observations of the same package (Quantum View + Tracking).
 * Quantum View's Origin event and the Tracking feed can each see a scan the
 * other has not yet published, so the earliest wins and events are unioned.
 */
export function mergeUpsFacts(
  a: UpsShipmentFacts | null,
  b: UpsShipmentFacts | null,
): UpsShipmentFacts | null {
  if (!a) return b;
  if (!b) return a;

  const events = mergeEvents(a.events, b.events);
  const latestEvent = events[events.length - 1] ?? null;

  return {
    trackingNumber: a.trackingNumber,
    recipientName: coalesce(a.recipientName, b.recipientName),
    companyName: coalesce(a.companyName, b.companyName),
    carrier: 'UPS',
    service: coalesce(a.service, b.service),
    labelCreatedAt: earliest(a.labelCreatedAt, b.labelCreatedAt),
    shipDate: coalesce(a.shipDate, b.shipDate),
    destinationCity: coalesce(a.destinationCity, b.destinationCity),
    destinationState: coalesce(a.destinationState, b.destinationState),
    destinationPostalCode: coalesce(a.destinationPostalCode, b.destinationPostalCode),
    destinationCountry: coalesce(a.destinationCountry, b.destinationCountry),
    // Prefer the observation with the more recent event for live status.
    upsStatus:
      (a.latestEventAt?.getTime() ?? 0) >= (b.latestEventAt?.getTime() ?? 0)
        ? coalesce(a.upsStatus, b.upsStatus)
        : coalesce(b.upsStatus, a.upsStatus),
    upsStatusCode: coalesce(a.upsStatusCode, b.upsStatusCode),
    upsStatusType: coalesce(a.upsStatusType, b.upsStatusType),
    firstCarrierScanAt: earliest(a.firstCarrierScanAt, b.firstCarrierScanAt),
    deliveredAt: latest(a.deliveredAt, b.deliveredAt),
    latestEvent: latestEvent?.description ?? null,
    latestEventAt: latestEvent?.occurredAt ?? null,
    exceptionType: coalesce(a.exceptionType, b.exceptionType),
    events,
    raw: { tracking: a.raw, quantumView: b.raw },
  };
}
