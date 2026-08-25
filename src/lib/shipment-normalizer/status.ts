/**
 * Normalised status derivation.
 *
 * The single source of truth for how raw carrier facts become one of our
 * internal statuses, and for the display strings used across the dashboard
 * and the morning email.
 *
 * The governing rule:  LABEL CREATED  !=  SHIPPED.
 * A shipment is only ever promoted past LABEL_CREATED when we hold evidence of
 * a physical UPS possession scan (`firstCarrierScanAt`).
 */

import type { NormalizedStatus } from '../types';

export interface StatusInputs {
  /** When the shipping label was created. */
  labelCreatedAt: Date | null;
  /** First physical UPS possession/acceptance/origin scan. Null = never scanned. */
  firstCarrierScanAt: Date | null;
  /** UPS delivery confirmation. */
  deliveredAt: Date | null;
  /** True when UPS reports an active exception. */
  hasException: boolean;
  /** True when the label was voided in ShipStation or UPS. */
  voided: boolean;
  /** True when an administrator manually resolved the shipment. */
  manuallyResolved: boolean;
  /** Hours after label creation before a scan-less label is escalated. */
  agingThresholdHours: number;
}

export function deriveStatus(inputs: StatusInputs, now: Date = new Date()): NormalizedStatus {
  const {
    labelCreatedAt,
    firstCarrierScanAt,
    deliveredAt,
    hasException,
    voided,
    agingThresholdHours,
  } = inputs;

  // A voided label is a closed matter regardless of any other signal.
  if (voided) return 'VOIDED';

  // Delivery is terminal and outranks a stale exception flag.
  if (deliveredAt) return 'DELIVERED';

  // An exception matters more than transit progress — it needs a human.
  if (hasException) return 'EXCEPTION';

  if (firstCarrierScanAt) {
    // UPS has the package. Whether we call it SHIPPED or IN_TRANSIT is a
    // presentation nuance; both mean "it physically left our facility".
    return 'IN_TRANSIT';
  }

  // No physical scan. Everything below here is the "still in our building"
  // family — the reason this application exists.
  if (!labelCreatedAt) return 'UNKNOWN';

  const ageHours = (now.getTime() - labelCreatedAt.getTime()) / 3_600_000;
  if (ageHours >= agingThresholdHours) return 'AGING_LABEL';

  return 'LABEL_CREATED';
}

/**
 * SHIPPED vs IN_TRANSIT: `deriveStatus` returns IN_TRANSIT once a physical
 * scan exists. Callers that want to distinguish the very first scan from
 * ongoing network movement use this refinement — a shipment whose only
 * physical scan is its origin scan is "Confirmed Shipped".
 */
export function refineMovementStatus(
  status: NormalizedStatus,
  physicalScanCount: number,
): NormalizedStatus {
  if (status !== 'IN_TRANSIT') return status;
  return physicalScanCount <= 1 ? 'SHIPPED' : 'IN_TRANSIT';
}

export interface StatusPresentation {
  label: string;
  /** Emoji + text, exactly as the spec requires it to appear. */
  display: string;
  tone: 'critical' | 'warning' | 'success' | 'neutral';
  /** True when the shipment belongs in the "Needs Attention" working set. */
  needsAttention: boolean;
  description: string;
}

export const STATUS_PRESENTATION: Record<NormalizedStatus, StatusPresentation> = {
  AGING_LABEL: {
    label: 'Label >24 Hours',
    display: '🚨 Label >24 Hours — No UPS Scan',
    tone: 'critical',
    needsAttention: true,
    description:
      'A label was created more than 24 hours ago and UPS still has no physical possession scan. The package may still be inside the facility.',
  },
  EXCEPTION: {
    label: 'Carrier Exception',
    display: '🚨 Carrier Exception',
    tone: 'critical',
    needsAttention: true,
    description: 'UPS reported an exception, failed delivery, return, damage, or address issue.',
  },
  LABEL_CREATED: {
    label: 'Label Created',
    display: '⚠️ Label Created — No Carrier Scan',
    tone: 'warning',
    needsAttention: true,
    description:
      'A UPS label exists but there is no physical carrier possession scan. The package may still be inside the facility.',
  },
  SHIPPED: {
    label: 'Confirmed Shipped',
    display: '✅ Confirmed Shipped',
    tone: 'success',
    needsAttention: false,
    description: 'UPS recorded its first physical possession/acceptance/origin scan.',
  },
  IN_TRANSIT: {
    label: 'In Transit',
    display: '✅ In Transit',
    tone: 'success',
    needsAttention: false,
    description: 'UPS has the package and it is moving through the network.',
  },
  DELIVERED: {
    label: 'Delivered',
    display: '✅ Delivered',
    tone: 'success',
    needsAttention: false,
    description: 'UPS confirms delivery.',
  },
  VOIDED: {
    label: 'Voided',
    display: '◻️ Label Voided',
    tone: 'neutral',
    needsAttention: false,
    description: 'The label was voided. No package is expected to ship against it.',
  },
  UNKNOWN: {
    label: 'Unknown',
    display: '◻️ Awaiting Carrier Data',
    tone: 'neutral',
    needsAttention: false,
    description: 'Not enough carrier information yet to classify this shipment.',
  },
};

/** Statuses that keep a shipment on the Needs Attention list. */
export const ATTENTION_STATUSES: NormalizedStatus[] = ['AGING_LABEL', 'EXCEPTION', 'LABEL_CREATED'];

/** Statuses that count as "the package physically left our facility". */
export const CONFIRMED_MOVED_STATUSES: NormalizedStatus[] = ['SHIPPED', 'IN_TRANSIT', 'DELIVERED'];

export function statusDisplay(status: NormalizedStatus): string {
  return STATUS_PRESENTATION[status].display;
}

export function needsAttention(status: NormalizedStatus, manuallyResolved: boolean): boolean {
  if (manuallyResolved) return false;
  return STATUS_PRESENTATION[status].needsAttention;
}
