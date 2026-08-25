/**
 * UPS Tracking API client and response parser.
 *
 * Verified 2026-08-25 against UPS-API/api-documentation (Tracking.yaml):
 *
 *   GET {base}/api/track/v1/details/{inquiryNumber}
 *   Headers: Authorization: Bearer <token>, transId, transactionSrc
 *   Query:   locale=en_US, returnSignature=false, returnMilestones=false
 *
 *   Response shape:
 *     trackResponse.shipment[].package[]
 *       .trackingNumber
 *       .currentStatus { code, description, type, simplifiedTextDescription }
 *       .activity[]  (most recent first)
 *           .date (YYYYMMDD) .time (HHMMSS)
 *           .gmtDate .gmtTime .gmtOffset ("-05:00")
 *           .status { code, description, type, statusCode }
 *           .location.address { city, stateProvince, countryCode }
 *           .logicalScan (true = logical/system event, false = physical scan)
 *       .deliveryDate[] { date, type: SDD|RDD|DEL }
 *       .deliveryTime { startTime, endTime, type }
 *
 * The physical-possession decision lives in ./codes.ts, not here.
 */

import { env } from '../env';
import { logger } from '../logger';
import { request, HttpError } from '../http/fetch';
import { upsAuthHeaders, getAccessToken } from './oauth';
import { parseUpsDateTime } from '../time';
import {
  isPhysicalPossessionScan,
  isDeliveryActivity,
  isExceptionActivity,
  isVoidActivity,
} from './codes';
import type { CarrierEvent, UpsShipmentFacts } from '../types';

const log = logger.child({ integration: 'ups-tracking' });

/** UPS publishes generous limits; we still pace to stay a good citizen. */
const MIN_REQUEST_INTERVAL_MS = 120;
let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

interface UpsAddress {
  city?: string;
  stateProvince?: string;
  countryCode?: string;
  postalCode?: string;
}

interface UpsActivity {
  date?: string;
  time?: string;
  gmtDate?: string;
  gmtTime?: string;
  gmtOffset?: string;
  logicalScan?: boolean | string;
  status?: { code?: string; description?: string; type?: string; statusCode?: string };
  location?: { address?: UpsAddress; slic?: string };
}

interface UpsPackage {
  trackingNumber?: string;
  currentStatus?: { code?: string; description?: string; type?: string };
  statusCode?: string;
  statusDescription?: string;
  service?: { code?: string; description?: string };
  activity?: UpsActivity[];
  deliveryDate?: Array<{ date?: string; type?: string }>;
  deliveryTime?: { startTime?: string; endTime?: string; type?: string };
  packageAddress?: Array<{ type?: string; address?: UpsAddress; name?: string; attentionName?: string }>;
}

interface UpsTrackResponse {
  trackResponse?: { shipment?: Array<{ inquiryNumber?: string; package?: UpsPackage[] }> };
}

export class TrackingNotFoundError extends Error {
  constructor(public readonly trackingNumber: string) {
    super(`UPS has no tracking data for ${trackingNumber}`);
    this.name = 'TrackingNotFoundError';
  }
}

/** UPS returns logicalScan as a boolean or the strings "true"/"false". */
function readLogicalScan(value: boolean | string | undefined): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return null;
}

function activityTimestamp(activity: UpsActivity): Date | null {
  // Prefer the GMT fields — they are unambiguous. Fall back to the local
  // scan date/time with the supplied offset.
  const fromGmt = parseUpsDateTime(activity.gmtDate, activity.gmtTime, '+00:00');
  if (fromGmt) return fromGmt;
  return parseUpsDateTime(activity.date, activity.time, activity.gmtOffset);
}

/** Stable identity for an activity so re-ingesting the same scan is a no-op. */
function eventDedupKey(activity: UpsActivity, occurredAt: Date): string {
  const parts = [
    occurredAt.toISOString(),
    activity.status?.code ?? '',
    activity.status?.type ?? '',
    (activity.status?.description ?? '').slice(0, 60),
    activity.location?.address?.city ?? '',
    activity.location?.address?.stateProvince ?? '',
  ];
  return parts.join('|');
}

export function parseTrackingResponse(
  trackingNumber: string,
  payload: UpsTrackResponse,
): UpsShipmentFacts | null {
  const shipments = payload.trackResponse?.shipment ?? [];
  const packages: UpsPackage[] = shipments.flatMap((s) => s.package ?? []);
  if (packages.length === 0) return null;

  // A single inquiry number can return several packages on a multi-piece
  // shipment; take the one whose tracking number matches, else the first.
  const pkg =
    packages.find(
      (p) => (p.trackingNumber ?? '').replace(/\s+/g, '').toUpperCase() === trackingNumber,
    ) ?? packages[0];
  if (!pkg) return null;

  const events: CarrierEvent[] = [];
  let firstPhysicalScanAt: Date | null = null;
  let deliveredAt: Date | null = null;
  let exceptionType: string | null = null;
  let hasVoid = false;
  let labelCreatedAt: Date | null = null;

  for (const activity of pkg.activity ?? []) {
    const occurredAt = activityTimestamp(activity);
    if (!occurredAt) continue;

    const description = activity.status?.description ?? activity.status?.code ?? 'UPS activity';
    const classification = {
      statusType: activity.status?.type ?? null,
      statusCode: activity.status?.code ?? null,
      description,
      logicalScan: readLogicalScan(activity.logicalScan),
    };

    const isPhysical = isPhysicalPossessionScan(classification);

    events.push({
      occurredAt,
      description,
      statusCode: activity.status?.code ?? null,
      statusType: activity.status?.type ?? null,
      locationCity: activity.location?.address?.city ?? null,
      locationState: activity.location?.address?.stateProvince ?? null,
      locationCountry: activity.location?.address?.countryCode ?? null,
      isPhysicalScan: isPhysical,
      eventSource: 'ups_tracking',
      dedupKey: eventDedupKey(activity, occurredAt),
      raw: activity,
    });

    if (isPhysical && (!firstPhysicalScanAt || occurredAt < firstPhysicalScanAt)) {
      firstPhysicalScanAt = occurredAt;
    }
    if (isDeliveryActivity(classification) && (!deliveredAt || occurredAt > deliveredAt)) {
      deliveredAt = occurredAt;
    }
    if (isExceptionActivity(classification)) {
      exceptionType = description;
    }
    if (isVoidActivity(classification)) hasVoid = true;

    // The manifest activity is UPS's own record of when the label entered
    // their system — a useful cross-check on ShipStation's timestamp, and the
    // only label timestamp we have for Danielle's UPS-created labels.
    if (!isPhysical && !labelCreatedAt) {
      const type = (activity.status?.type ?? '').toUpperCase();
      if (type === 'M' || (activity.status?.code ?? '').toUpperCase() === 'MP') {
        labelCreatedAt = occurredAt;
      }
    }
  }

  events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const latest = events[events.length - 1] ?? null;

  // A DEL delivery date is authoritative when the activity feed is truncated.
  if (!deliveredAt) {
    const delivered = (pkg.deliveryDate ?? []).find((d) => (d.type ?? '').toUpperCase() === 'DEL');
    if (delivered?.date) {
      deliveredAt = parseUpsDateTime(delivered.date, pkg.deliveryTime?.endTime ?? '120000', null);
    }
  }

  const shipToEntry =
    (pkg.packageAddress ?? []).find((a) => (a.type ?? '').toUpperCase().includes('DESTINATION')) ??
    (pkg.packageAddress ?? [])[0];

  const currentStatus = pkg.currentStatus ?? {};

  return {
    trackingNumber,
    recipientName: shipToEntry?.name ?? shipToEntry?.attentionName ?? null,
    companyName: shipToEntry?.attentionName && shipToEntry?.name !== shipToEntry?.attentionName
      ? shipToEntry.attentionName
      : null,
    carrier: 'UPS',
    service: pkg.service?.description ?? pkg.service?.code ?? null,
    labelCreatedAt,
    shipDate: null,
    destinationCity: shipToEntry?.address?.city ?? null,
    destinationState: shipToEntry?.address?.stateProvince ?? null,
    destinationPostalCode: shipToEntry?.address?.postalCode ?? null,
    destinationCountry: shipToEntry?.address?.countryCode ?? null,
    upsStatus: currentStatus.description ?? pkg.statusDescription ?? null,
    upsStatusCode: currentStatus.code ?? pkg.statusCode ?? null,
    upsStatusType: currentStatus.type ?? null,
    firstCarrierScanAt: firstPhysicalScanAt,
    deliveredAt,
    latestEvent: latest?.description ?? null,
    latestEventAt: latest?.occurredAt ?? null,
    exceptionType: hasVoid ? 'Label voided' : exceptionType,
    events,
    raw: payload,
  };
}

/** Fetch and parse tracking for one number. Returns null when UPS has nothing. */
export async function trackPackage(trackingNumber: string): Promise<UpsShipmentFacts | null> {
  await throttle();

  const url = new URL(
    `${env.ups.baseUrl}/api/track/v1/details/${encodeURIComponent(trackingNumber)}`,
  );
  url.searchParams.set('locale', 'en_US');
  url.searchParams.set('returnSignature', 'false');
  url.searchParams.set('returnMilestones', 'false');

  try {
    const { data } = await request<UpsTrackResponse>(url.toString(), {
      label: 'ups-tracking',
      headers: await upsAuthHeaders(),
      timeoutMs: 20_000,
    });
    return parseTrackingResponse(trackingNumber, data);
  } catch (err) {
    if (err instanceof HttpError) {
      // 404 is the normal answer for a label UPS has not ingested yet — that
      // is a meaningful audit result, not an error.
      if (err.status === 404) {
        log.debug('no UPS tracking data yet', { trackingNumber });
        return null;
      }
      if (err.status === 401) {
        // Token may have been revoked mid-run; force a refresh for the next call.
        await getAccessToken(true).catch(() => undefined);
      }
    }
    throw err;
  }
}
