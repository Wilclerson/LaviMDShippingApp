/** Shared domain types. */

export type ShipmentSource = 'shipstation' | 'wholesale_danielle';

export type NormalizedStatus =
  | 'LABEL_CREATED'
  | 'AGING_LABEL'
  | 'SHIPPED'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'EXCEPTION'
  | 'VOIDED'
  | 'UNKNOWN';

export type UserRole = 'admin' | 'fulfillment';

export const WHOLESALE_SOURCE_LABEL = 'Wholesale / Danielle';

/** A carrier scan as stored in shipment_events. */
export interface CarrierEvent {
  occurredAt: Date;
  description: string;
  statusCode: string | null;
  statusType: string | null;
  locationCity: string | null;
  locationState: string | null;
  locationCountry: string | null;
  isPhysicalScan: boolean;
  eventSource: 'ups_tracking' | 'ups_quantum_view' | 'shipstation';
  dedupKey: string;
  raw?: unknown;
}

/** Normalised shipment facts gathered from ShipStation. */
export interface ShipStationShipmentFacts {
  trackingNumber: string;
  customerName: string | null;
  companyName: string | null;
  orderNumber: string | null;
  shipstationOrderId: string | null;
  shipstationShipmentId: string | null;
  shipstationLabelId: string | null;
  shipstationStoreId: string | null;
  sourceStore: string | null;
  shipstationStatus: string | null;
  carrier: string | null;
  service: string | null;
  labelCreatedAt: Date | null;
  shipDate: string | null;
  destinationCity: string | null;
  destinationState: string | null;
  destinationPostalCode: string | null;
  destinationCountry: string | null;
  voided: boolean;
  raw: unknown;
}

/** Normalised shipment facts gathered from UPS (tracking and/or Quantum View). */
export interface UpsShipmentFacts {
  trackingNumber: string;
  recipientName: string | null;
  companyName: string | null;
  carrier: 'UPS';
  service: string | null;
  labelCreatedAt: Date | null;
  shipDate: string | null;
  destinationCity: string | null;
  destinationState: string | null;
  destinationPostalCode: string | null;
  destinationCountry: string | null;
  upsStatus: string | null;
  upsStatusCode: string | null;
  upsStatusType: string | null;
  firstCarrierScanAt: Date | null;
  deliveredAt: Date | null;
  latestEvent: string | null;
  latestEventAt: Date | null;
  exceptionType: string | null;
  events: CarrierEvent[];
  raw: unknown;
}

export interface ShipmentRow {
  id: string;
  tracking_number: string;
  source: ShipmentSource;
  source_store: string | null;
  shipstation_store_id: string | null;
  customer_name: string | null;
  company_name: string | null;
  order_number: string | null;
  shipstation_order_id: string | null;
  shipstation_shipment_id: string | null;
  shipstation_label_id: string | null;
  shipstation_status: string | null;
  carrier: string | null;
  service: string | null;
  label_created_at: Date | null;
  ship_date: string | null;
  first_carrier_scan_at: Date | null;
  delivered_at: Date | null;
  destination_city: string | null;
  destination_state: string | null;
  destination_postal_code: string | null;
  destination_country: string | null;
  ups_status: string | null;
  ups_status_code: string | null;
  ups_status_type: string | null;
  normalized_status: NormalizedStatus;
  latest_tracking_event: string | null;
  latest_tracking_event_at: Date | null;
  exception_type: string | null;
  has_physical_scan: boolean;
  first_seen_at: Date;
  last_synced_at: Date | null;
  last_tracking_check_at: Date | null;
  manually_resolved: boolean;
  manually_resolved_by: string | null;
  manually_resolved_at: Date | null;
  resolution_reason: string | null;
  resolution_note: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export const RESOLUTION_REASONS = [
  'Label voided',
  'Duplicate label',
  'Shipment cancelled',
  'Customer order cancelled',
  'Replacement label issued',
  'Other',
] as const;

export type ResolutionReason = (typeof RESOLUTION_REASONS)[number];
