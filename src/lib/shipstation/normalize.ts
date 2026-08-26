/**
 * Turn raw ShipStation V2 payloads into the domain facts the rest of the app
 * uses.
 *
 * Every field is read defensively through a list of candidate keys. ShipStation
 * has renamed fields between releases (order_number / external_order_id /
 * shipment_number all appear in the wild), and a rename must degrade to a null
 * value, never break the nightly audit.
 */

import type { ShipStationShipmentFacts } from '../types';
import type { RawLabel, RawShipment, RawStore, RawAddress } from './client';
import { env } from '../env';

export function normalizeTrackingNumber(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, '').toUpperCase();
  return cleaned.length >= 6 ? cleaned : null;
}

function pickString(source: Record<string, unknown> | undefined, keys: string[]): string | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function pickDate(source: Record<string, unknown> | undefined, keys: string[]): Date | null {
  const raw = pickString(source, keys);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** ShipStation ship_date values arrive as full ISO timestamps; we want the day. */
function toDateOnly(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (match?.[1]) return match[1];
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function readAddress(address: RawAddress | undefined) {
  return {
    name: pickString(address, ['name', 'contact_name', 'attention_name']),
    company: pickString(address, ['company_name', 'company']),
    city: pickString(address, ['city_locality', 'city']),
    state: pickString(address, ['state_province', 'state']),
    postal: pickString(address, ['postal_code', 'postcode', 'zip']),
    country: pickString(address, ['country_code', 'country']),
  };
}

/** Human-readable carrier name from ShipStation's carrier_code. */
export function carrierDisplayName(code: string | null): string | null {
  if (!code) return null;
  const normalized = code.toLowerCase();
  if (normalized.includes('ups')) return 'UPS';
  if (normalized.includes('fedex')) return 'FedEx';
  if (normalized.includes('usps') || normalized.includes('stamps')) return 'USPS';
  if (normalized.includes('dhl')) return 'DHL';
  return code.toUpperCase();
}

/**
 * ShipStation returns machine service codes ("ups_ground",
 * "ups_2nd_day_air"). Warehouse staff read the human name, so render that and
 * fall back to the raw code for anything unrecognised.
 */
export function serviceDisplayName(code: string | null): string | null {
  if (!code) return null;
  const trimmed = code.trim();
  // Already human-readable (UPS Tracking and Quantum View return descriptions).
  if (/\s/.test(trimmed)) return trimmed;
  return trimmed
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bUps\b/g, 'UPS')
    .replace(/\bUsps\b/g, 'USPS')
    .replace(/\bFedex\b/g, 'FedEx')
    .replace(/\bDhl\b/g, 'DHL')
    .replace(/\b(\d)(St|Nd|Rd|Th)\b/g, (_m, d, suffix) => `${d}${suffix.toLowerCase()}`);
}

/**
 * Is this a structurally valid UPS "1Z" tracking number?
 *
 *   1Z + 6-char shipper number + 2-digit service code + 8 more characters
 *   = 18 characters total.
 *
 * Only the format is checked, deliberately. The check digit is not verified:
 * a false negative here would silently exclude a real package from UPS
 * polling, which is precisely the failure this function exists to prevent.
 * A false positive costs one wasted tracking lookup that returns nothing.
 */
export function isUpsTrackingNumber(trackingNumber: string | null): boolean {
  if (!trackingNumber) return false;
  return /^1Z[0-9A-Z]{16}$/.test(trackingNumber.replace(/\s+/g, '').toUpperCase());
}

/**
 * Should this shipment be verified against UPS?
 *
 * The carrier code alone is not sufficient. Lavi MD buys UPS labels through
 * Worldwide Express, so ShipStation reports `carrier_code: "wwex_parcel"` on
 * labels that carry genuine UPS 1Z tracking numbers and move through the UPS
 * network. Trusting the code alone excluded every one of those shipments from
 * tracking, so nothing could ever reach "Confirmed Shipped".
 *
 * A valid 1Z tracking number is therefore treated as UPS whatever the carrier
 * code says. The reverse does not hold: a non-1Z number is not made UPS by its
 * carrier code, because there would be nothing for UPS tracking to look up.
 *
 * This affects verification routing only. The original ShipStation carrier code
 * is still stored and displayed unchanged — see `carrierDisplayName`.
 */
export function isUpsCarrier(carrier: string | null, trackingNumber: string | null = null): boolean {
  if (isUpsTrackingNumber(trackingNumber)) return true;
  return (carrier ?? '').toUpperCase().includes('UPS');
}

export interface StoreResolver {
  /** store_id -> display name */
  nameById: Map<string, string>;
  /** Lower-cased configured names that are in scope. */
  allowedNames: Set<string>;
  allowedIds: Set<string>;
}

export function buildStoreResolver(stores: RawStore[]): StoreResolver {
  const nameById = new Map<string, string>();
  for (const store of stores) {
    const id = pickString(store, ['store_id', 'storeId', 'id']);
    const name = pickString(store, ['name', 'store_name', 'nickname', 'marketplace_name']);
    if (id && name) nameById.set(id, name);
  }
  return {
    nameById,
    allowedNames: new Set(env.shipstation.storeNames.map((n) => n.toLowerCase())),
    allowedIds: new Set(env.shipstation.storeIds),
  };
}

/**
 * Is this shipment from one of the Lavi MD stores we audit?
 *
 * Matching order: explicit store id, then store name (case-insensitive).
 * When neither list is configured everything is accepted, and the sync logs a
 * warning so the misconfiguration is visible rather than silent.
 */
export function isStoreInScope(
  storeId: string | null,
  storeName: string | null,
  resolver: StoreResolver,
): boolean {
  if (resolver.allowedIds.size === 0 && resolver.allowedNames.size === 0) return true;
  if (storeId && resolver.allowedIds.has(storeId)) return true;
  if (storeName && resolver.allowedNames.has(storeName.toLowerCase())) return true;
  return false;
}

export function resolveStoreName(
  storeId: string | null,
  shipment: RawShipment | null,
  resolver: StoreResolver,
): string | null {
  const fromShipment = pickString(shipment as Record<string, unknown> | undefined, [
    'store_name',
    'storeName',
    'marketplace_name',
  ]);
  if (fromShipment) return fromShipment;
  if (storeId && resolver.nameById.has(storeId)) return resolver.nameById.get(storeId) ?? null;
  return null;
}

/**
 * Merge a label with its (optional) shipment record into domain facts.
 *
 * The label supplies the tracking number and the label creation timestamp —
 * the two facts this application is built around. The shipment supplies who
 * the package is for and which order it belongs to.
 */
export function toShipStationFacts(
  label: RawLabel,
  shipment: RawShipment | null,
  resolver: StoreResolver,
): ShipStationShipmentFacts | null {
  const trackingNumber = normalizeTrackingNumber(label.tracking_number);
  if (!trackingNumber) return null;

  const labelRecord = label as Record<string, unknown>;
  const shipmentRecord = (shipment ?? undefined) as Record<string, unknown> | undefined;

  const address = readAddress(shipment?.ship_to ?? label.ship_to);
  const storeId = pickString(shipmentRecord, ['store_id', 'storeId']);
  const sourceStore = resolveStoreName(storeId, shipment, resolver);

  const carrierCode = pickString(labelRecord, ['carrier_code', 'carrier_id']);

  return {
    trackingNumber,
    customerName: address.name,
    companyName: address.company,
    // ShipStation surfaces the merchant's own order number under several keys
    // depending on which integration created the order.
    orderNumber: pickString(shipmentRecord, [
      'order_number',
      'external_order_id',
      'shipment_number',
      'external_shipment_id',
    ]),
    shipstationOrderId: pickString(shipmentRecord, ['order_id', 'sales_order_id', 'order_source_id']),
    shipstationShipmentId: pickString(labelRecord, ['shipment_id']) ?? pickString(shipmentRecord, ['shipment_id']),
    shipstationLabelId: pickString(labelRecord, ['label_id']),
    shipstationStoreId: storeId,
    sourceStore,
    shipstationStatus:
      pickString(shipmentRecord, ['shipment_status']) ?? pickString(labelRecord, ['status']),
    carrier: carrierDisplayName(carrierCode),
    service: serviceDisplayName(
      pickString(labelRecord, ['service_code']) ?? pickString(shipmentRecord, ['service_code']),
    ),
    labelCreatedAt: pickDate(labelRecord, ['created_at', 'create_date']),
    shipDate: toDateOnly(pickString(labelRecord, ['ship_date']) ?? pickString(shipmentRecord, ['ship_date'])),
    destinationCity: address.city,
    destinationState: address.state,
    destinationPostalCode: address.postal,
    destinationCountry: address.country,
    voided:
      label.voided === true ||
      (typeof label.status === 'string' && label.status.toLowerCase() === 'voided'),
    // Kept for forensic replay. Never sent to the browser.
    raw: { label, shipment: shipment ?? null },
  };
}
