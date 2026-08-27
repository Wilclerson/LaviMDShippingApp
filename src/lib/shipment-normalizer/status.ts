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
import { evaluateOverdue } from './overdue';
import type { BusinessCalendarOptions } from '../business-calendar';

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
  /**
   * ShipStation service description. Decides whether a Thursday/Friday label
   * was printed for same-day dispatch (Ground-safe) or held for Monday
   * (air/cold). Absent service falls back to the air/cold assumption, which is
   * the more forgiving of the two.
   */
  service?: string | null;
  /** Override the business calendar. Tests and future configuration only. */
  calendar?: BusinessCalendarOptions;
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

  // Overdue is a calendar question, not an hours question: a weekend or a
  // holiday is not a delay, and Thursday/Friday cold labels are printed for
  // Monday. `evaluateOverdue` owns that reasoning; the floor keeps
  // AGING_LABEL_HOURS meaningful as an operator-facing minimum.
  const { overdue } = evaluateOverdue({
    labelCreatedAt,
    service: inputs.service ?? null,
    minimumHours: agingThresholdHours,
    now,
    calendar: inputs.calendar,
  });

  return overdue ? 'AGING_LABEL' : 'LABEL_CREATED';
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
    label: 'Overdue',
    display: 'Overdue — No UPS Scan',
    tone: 'critical',
    needsAttention: true,
    description:
      'This label is past the day we expected to hand it to UPS, and UPS still has no physical possession scan. The package may still be inside the facility.',
  },
  EXCEPTION: {
    label: 'Delivery Problem',
    display: 'Delivery Problem',
    tone: 'critical',
    needsAttention: true,
    description: 'UPS reported an exception, failed delivery, return, damage, or address issue.',
  },
  LABEL_CREATED: {
    label: 'Awaiting UPS',
    display: 'Awaiting UPS',
    tone: 'warning',
    needsAttention: true,
    description:
      'A label exists and UPS has not scanned it yet, but it is still within the expected window for its service and the day it was printed.',
  },
  SHIPPED: {
    label: 'Confirmed Shipped',
    display: 'Confirmed Shipped',
    tone: 'success',
    needsAttention: false,
    description: 'UPS recorded its first physical possession/acceptance/origin scan.',
  },
  IN_TRANSIT: {
    label: 'In Transit',
    display: 'In Transit',
    tone: 'success',
    needsAttention: false,
    description: 'UPS has the package and it is moving through the network.',
  },
  DELIVERED: {
    label: 'Delivered',
    display: 'Delivered',
    tone: 'success',
    needsAttention: false,
    description: 'UPS confirms delivery.',
  },
  VOIDED: {
    label: 'Voided',
    display: 'Label Voided',
    tone: 'neutral',
    needsAttention: false,
    description: 'The label was voided. No package is expected to ship against it.',
  },
  UNKNOWN: {
    label: 'Unknown',
    display: 'Awaiting Carrier Data',
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
