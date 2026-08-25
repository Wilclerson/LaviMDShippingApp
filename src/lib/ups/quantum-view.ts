/**
 * UPS Quantum View client — the account-level shipment feed.
 *
 * WHY THIS EXISTS
 * ---------------
 * The UPS Tracking API answers "what happened to tracking number X?". It
 * cannot answer "what labels exist on our account?". Danielle creates wholesale
 * labels directly in UPS, so those tracking numbers are unknown to ShipStation
 * and therefore unknown to us — there is nothing to look up.
 *
 * Quantum View is the UPS API that pushes account-wide shipment activity, so it
 * is how those labels are discovered. It also gives the cleanest possible
 * possession signal: UPS emits an `Origin` event only after an actual origin /
 * pickup scan.
 *
 * Verified 2026-08-25 against UPS-API/api-documentation (QuantumView.yaml):
 *
 *   POST {base}/api/quantumview/v3/events
 *   Body: {
 *     QuantumViewRequest: {
 *       Request: { RequestAction: "QVEvents", TransactionReference: {...} },
 *       SubscriptionRequest: [{ Name?, DateTimeRange: { BeginDateTime, EndDateTime } }],
 *       Bookmark?: "<base64 from previous response>"
 *     }
 *   }
 *   Dates are YYYYMMDDHHmmss. Subscription data is available up to 7 days back.
 *
 *   Response: QuantumViewResponse.QuantumViewEvents.SubscriptionEvents[]
 *               .SubscriptionFile[] { Manifest[], Origin[], Exception[], Delivery[], Generic[] }
 *             plus a top-level Bookmark when more pages remain.
 *
 * IMPORTANT OPERATIONAL NOTE
 * --------------------------
 * Quantum View only returns events for subscriptions configured on the UPS
 * account. If no subscription exists, this returns nothing and Danielle's
 * labels stay invisible. docs/UPS_SETUP.md covers the one-time setup, and the
 * dashboard surfaces a warning when Quantum View has produced no manifest
 * events for an extended period.
 */

import { env } from '../env';
import { logger } from '../logger';
import { request, HttpError } from '../http/fetch';
import { upsAuthHeaders } from './oauth';
import { parseUpsDateTime, parseUpsDateOnly, toUpsDateTimeString } from '../time';
import type { CarrierEvent } from '../types';

const log = logger.child({ integration: 'ups-quantum-view' });

/** A shipment as assembled from Quantum View activity. */
export interface QuantumViewShipment {
  trackingNumber: string;
  shipperNumber: string | null;
  recipientName: string | null;
  companyName: string | null;
  service: string | null;
  /** From the Manifest event — when the label was created. */
  labelCreatedAt: Date | null;
  shipDate: string | null;
  destinationCity: string | null;
  destinationState: string | null;
  destinationPostalCode: string | null;
  destinationCountry: string | null;
  /** From the Origin event — definitive physical UPS possession. */
  originScanAt: Date | null;
  deliveredAt: Date | null;
  exceptionType: string | null;
  exceptionAt: Date | null;
  events: CarrierEvent[];
}

// --- raw payload shapes -------------------------------------------------------

interface QvAddress {
  City?: string;
  StateProvinceCode?: string;
  PoliticalDivision1?: string;
  PoliticalDivision2?: string;
  PostalCode?: string;
  PostcodePrimaryLow?: string;
  CountryCode?: string;
}

interface QvManifestPackage {
  TrackingNumber?: string;
  Activity?: Array<{ Date?: string; Time?: string }>;
}

interface QvManifest {
  Shipper?: { Name?: string; ShipperNumber?: string };
  ShipTo?: { CompanyName?: string; AttentionName?: string; Name?: string; Address?: QvAddress };
  Service?: { Code?: string; Description?: string };
  PickupDate?: string;
  ScheduledDeliveryDate?: string;
  Package?: QvManifestPackage[] | QvManifestPackage;
  BillToAccount?: { Number?: string; Option?: string };
}

interface QvOrigin {
  TrackingNumber?: string;
  ShipperNumber?: string;
  Date?: string;
  Time?: string;
  ActivityLocation?: { Address?: QvAddress };
  ScheduledDeliveryDate?: string;
}

interface QvException {
  TrackingNumber?: string;
  ShipperNumber?: string;
  Date?: string;
  Time?: string;
  StatusCode?: string;
  StatusDescription?: string;
  ReasonCode?: string;
  ReasonDescription?: string;
  ActivityLocation?: { Address?: QvAddress };
}

interface QvDelivery {
  TrackingNumber?: string;
  ShipperNumber?: string;
  Date?: string;
  Time?: string;
  DeliveryLocation?: { City?: string; PoliticalDivision1?: string; SignedForByName?: string; Description?: string };
  ActivityLocation?: { Address?: QvAddress };
}

interface QvSubscriptionFile {
  FileName?: string;
  Manifest?: QvManifest[] | QvManifest;
  Origin?: QvOrigin[] | QvOrigin;
  Exception?: QvException[] | QvException;
  Delivery?: QvDelivery[] | QvDelivery;
}

interface QvResponse {
  QuantumViewResponse?: {
    Response?: { ResponseStatusCode?: string; ResponseStatusDescription?: string };
    QuantumViewEvents?: {
      SubscriberID?: string;
      SubscriptionEvents?:
        | Array<{ Name?: string; SubscriptionFile?: QvSubscriptionFile[] | QvSubscriptionFile }>
        | { Name?: string; SubscriptionFile?: QvSubscriptionFile[] | QvSubscriptionFile };
    };
    Bookmark?: string;
  };
}

/**
 * Quantum View v1/v2 collapse single-element arrays into bare objects; v3 is
 * documented to always return arrays. Normalise both so the parser is simple.
 */
function toArray<T>(value: T[] | T | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeTracking(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, '').toUpperCase();
  return cleaned.length >= 6 ? cleaned : null;
}

function readAddress(address: QvAddress | undefined) {
  return {
    city: address?.City ?? null,
    // UPS uses StateProvinceCode in some payloads and PoliticalDivision1 in others.
    state: address?.StateProvinceCode ?? address?.PoliticalDivision1 ?? null,
    postal: address?.PostalCode ?? address?.PostcodePrimaryLow ?? null,
    country: address?.CountryCode ?? null,
  };
}

function blank(trackingNumber: string): QuantumViewShipment {
  return {
    trackingNumber,
    shipperNumber: null,
    recipientName: null,
    companyName: null,
    service: null,
    labelCreatedAt: null,
    shipDate: null,
    destinationCity: null,
    destinationState: null,
    destinationPostalCode: null,
    destinationCountry: null,
    originScanAt: null,
    deliveredAt: null,
    exceptionType: null,
    exceptionAt: null,
    events: [],
  };
}

/**
 * Fold Quantum View subscription files into one shipment per tracking number.
 * Exported separately from the network call so it is directly testable.
 */
export function parseQuantumViewFiles(files: QvSubscriptionFile[]): QuantumViewShipment[] {
  const byTracking = new Map<string, QuantumViewShipment>();

  const ensure = (trackingNumber: string): QuantumViewShipment => {
    let existing = byTracking.get(trackingNumber);
    if (!existing) {
      existing = blank(trackingNumber);
      byTracking.set(trackingNumber, existing);
    }
    return existing;
  };

  for (const file of files) {
    // --- Manifest: a label was created. NOT possession. ---
    for (const manifest of toArray(file.Manifest)) {
      const address = readAddress(manifest.ShipTo?.Address);
      const shipperNumber = manifest.Shipper?.ShipperNumber ?? null;
      const service = manifest.Service?.Description ?? manifest.Service?.Code ?? null;
      const pickupDate = parseUpsDateOnly(manifest.PickupDate);

      for (const pkg of toArray(manifest.Package)) {
        const trackingNumber = normalizeTracking(pkg.TrackingNumber);
        if (!trackingNumber) continue;

        const shipment = ensure(trackingNumber);
        shipment.shipperNumber ??= shipperNumber;
        shipment.recipientName ??= manifest.ShipTo?.AttentionName ?? manifest.ShipTo?.Name ?? null;
        shipment.companyName ??= manifest.ShipTo?.CompanyName ?? null;
        shipment.service ??= service;
        shipment.shipDate ??= pickupDate;
        shipment.destinationCity ??= address.city;
        shipment.destinationState ??= address.state;
        shipment.destinationPostalCode ??= address.postal;
        shipment.destinationCountry ??= address.country;

        // The manifest activity timestamp is when UPS accepted the label data.
        const activity = toArray(pkg.Activity)[0];
        const manifestedAt =
          parseUpsDateTime(activity?.Date, activity?.Time, null) ??
          parseUpsDateTime(manifest.PickupDate, '000000', null);

        if (manifestedAt && (!shipment.labelCreatedAt || manifestedAt < shipment.labelCreatedAt)) {
          shipment.labelCreatedAt = manifestedAt;
        }

        if (manifestedAt) {
          shipment.events.push({
            occurredAt: manifestedAt,
            description: 'Label created (UPS manifest received)',
            statusCode: 'MP',
            statusType: 'M',
            locationCity: null,
            locationState: null,
            locationCountry: null,
            // A manifest is bookkeeping, never custody.
            isPhysicalScan: false,
            eventSource: 'ups_quantum_view',
            dedupKey: `qv-manifest|${manifestedAt.toISOString()}`,
            raw: { manifest: { ...manifest, Package: undefined }, package: pkg },
          });
        }
      }
    }

    // --- Origin: UPS physically took possession. Definitive. ---
    for (const origin of toArray(file.Origin)) {
      const trackingNumber = normalizeTracking(origin.TrackingNumber);
      if (!trackingNumber) continue;
      const occurredAt = parseUpsDateTime(origin.Date, origin.Time, null);
      if (!occurredAt) continue;

      const shipment = ensure(trackingNumber);
      shipment.shipperNumber ??= origin.ShipperNumber ?? null;
      if (!shipment.originScanAt || occurredAt < shipment.originScanAt) {
        shipment.originScanAt = occurredAt;
      }

      const address = readAddress(origin.ActivityLocation?.Address);
      shipment.events.push({
        occurredAt,
        description: 'Origin Scan — UPS took possession',
        statusCode: 'OR',
        statusType: 'I',
        locationCity: address.city,
        locationState: address.state,
        locationCountry: address.country,
        isPhysicalScan: true,
        eventSource: 'ups_quantum_view',
        dedupKey: `qv-origin|${occurredAt.toISOString()}`,
        raw: origin,
      });
    }

    // --- Exception ---
    for (const exception of toArray(file.Exception)) {
      const trackingNumber = normalizeTracking(exception.TrackingNumber);
      if (!trackingNumber) continue;
      const occurredAt = parseUpsDateTime(exception.Date, exception.Time, null);
      if (!occurredAt) continue;

      const shipment = ensure(trackingNumber);
      const description =
        exception.StatusDescription ?? exception.ReasonDescription ?? 'UPS exception';

      if (!shipment.exceptionAt || occurredAt > shipment.exceptionAt) {
        shipment.exceptionAt = occurredAt;
        shipment.exceptionType = description;
      }

      const address = readAddress(exception.ActivityLocation?.Address);
      shipment.events.push({
        occurredAt,
        description,
        statusCode: exception.StatusCode ?? 'X',
        statusType: 'X',
        locationCity: address.city,
        locationState: address.state,
        locationCountry: address.country,
        // An exception scan means UPS handled the package — it is possession.
        isPhysicalScan: true,
        eventSource: 'ups_quantum_view',
        dedupKey: `qv-exception|${occurredAt.toISOString()}|${exception.StatusCode ?? ''}`,
        raw: exception,
      });
    }

    // --- Delivery ---
    for (const delivery of toArray(file.Delivery)) {
      const trackingNumber = normalizeTracking(delivery.TrackingNumber);
      if (!trackingNumber) continue;
      const occurredAt = parseUpsDateTime(delivery.Date, delivery.Time, null);
      if (!occurredAt) continue;

      const shipment = ensure(trackingNumber);
      if (!shipment.deliveredAt || occurredAt > shipment.deliveredAt) {
        shipment.deliveredAt = occurredAt;
      }

      const signedBy = delivery.DeliveryLocation?.SignedForByName;
      shipment.events.push({
        occurredAt,
        description: signedBy ? `Delivered — signed for by ${signedBy}` : 'Delivered',
        statusCode: 'DL',
        statusType: 'D',
        locationCity: delivery.DeliveryLocation?.City ?? null,
        locationState: delivery.DeliveryLocation?.PoliticalDivision1 ?? null,
        locationCountry: null,
        isPhysicalScan: true,
        eventSource: 'ups_quantum_view',
        dedupKey: `qv-delivery|${occurredAt.toISOString()}`,
        raw: delivery,
      });
    }
  }

  for (const shipment of byTracking.values()) {
    shipment.events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  return [...byTracking.values()];
}

export interface FetchQuantumViewOptions {
  begin: Date;
  end: Date;
  /** Hard cap on bookmark pages so one run cannot loop forever. */
  maxPages?: number;
}

/**
 * Pull Quantum View events for a window, following Bookmark pagination.
 *
 * UPS retains subscription data for 7 days; requesting a wider window returns
 * what it has rather than failing, so the caller clamps for clarity.
 */
export async function fetchQuantumViewShipments(
  options: FetchQuantumViewOptions,
): Promise<{ shipments: QuantumViewShipment[]; pages: number; truncated: boolean }> {
  const maxPages = options.maxPages ?? 20;
  const subscriptions = env.ups.quantumViewSubscriptions;

  const files: QvSubscriptionFile[] = [];
  let bookmark: string | undefined;
  let pages = 0;
  let truncated = false;

  while (pages < maxPages) {
    const body = {
      QuantumViewRequest: {
        Request: {
          RequestAction: 'QVEvents',
          TransactionReference: { CustomerContext: 'lavimd-shipping-audit' },
        },
        // With no names supplied UPS returns every subscription on the account.
        ...(subscriptions.length > 0
          ? {
              SubscriptionRequest: subscriptions.map((name) => ({
                Name: name,
                DateTimeRange: {
                  BeginDateTime: toUpsDateTimeString(options.begin),
                  EndDateTime: toUpsDateTimeString(options.end),
                },
              })),
            }
          : {
              SubscriptionRequest: [
                {
                  DateTimeRange: {
                    BeginDateTime: toUpsDateTimeString(options.begin),
                    EndDateTime: toUpsDateTimeString(options.end),
                  },
                },
              ],
            }),
        ...(bookmark ? { Bookmark: bookmark } : {}),
      },
    };

    const { data } = await request<QvResponse>(
      `${env.ups.baseUrl}/api/quantumview/v3/events`,
      {
        method: 'POST',
        label: 'ups-quantum-view',
        headers: await upsAuthHeaders(),
        body,
        timeoutMs: 45_000,
        // Quantum View is a heavier call; fewer retries keeps a sync bounded.
        maxRetries: 2,
      },
    );

    pages += 1;

    const response = data.QuantumViewResponse;
    const statusCode = response?.Response?.ResponseStatusCode;
    if (statusCode && statusCode !== '1') {
      log.warn('Quantum View reported a non-success status', {
        statusCode,
        description: response?.Response?.ResponseStatusDescription,
      });
    }

    for (const subscriptionEvent of toArray(response?.QuantumViewEvents?.SubscriptionEvents)) {
      files.push(...toArray(subscriptionEvent.SubscriptionFile));
    }

    bookmark = response?.Bookmark;
    if (!bookmark) break;
    if (pages >= maxPages) {
      truncated = true;
      log.warn('Quantum View pagination hit the page cap; some events were not read this run', {
        maxPages,
      });
    }
  }

  const shipments = parseQuantumViewFiles(files);
  log.info('Quantum View poll complete', {
    pages,
    files: files.length,
    shipments: shipments.length,
    truncated,
  });

  return { shipments, pages, truncated };
}

/** Health probe: can we reach Quantum View at all? */
export async function verifyQuantumView(): Promise<{ ok: boolean; message: string }> {
  try {
    const end = new Date();
    const begin = new Date(end.getTime() - 6 * 3_600_000);
    const result = await fetchQuantumViewShipments({ begin, end, maxPages: 1 });
    return {
      ok: true,
      message: `Quantum View reachable (${result.shipments.length} shipment(s) in the last 6 hours).`,
    };
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.status === 401 || err.status === 403) {
        return {
          ok: false,
          message:
            'UPS rejected the Quantum View request. Confirm the app is subscribed to the Quantum View API and that a Quantum View subscription exists on the account.',
        };
      }
      return { ok: false, message: `Quantum View returned ${err.status}.` };
    }
    return { ok: false, message: 'Quantum View unreachable.' };
  }
}
