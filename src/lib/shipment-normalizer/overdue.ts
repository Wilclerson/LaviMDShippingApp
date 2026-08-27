/**
 * When does an unscanned label become a problem?
 *
 * The old rule was a flat 24 hours from label creation. Measured against 678
 * production shipments that did eventually get a UPS scan, that rule would have
 * flagged 36% of them — because Lavi MD prints Thursday and Friday labels for
 * Monday dispatch, and Friday labels take a median of 83.7 hours to be scanned.
 * A list that is one-third false alarms stops being read, which is worse than
 * having no list.
 *
 * So overdue is derived from the shipping cadence instead:
 *
 *   Mon–Wed              → handed over the same day
 *   Thu/Fri, air/cold    → held for the next open Monday (would otherwise sit
 *                          in a facility over the weekend)
 *   Thu/Fri, Ground-safe → handed over the same day
 *   Sat/Sun              → the next open business day
 *
 * and a label is overdue once we pass the END of the next open business day
 * after that expected hand-over. That grace day absorbs late-afternoon printing
 * and next-morning pickups.
 *
 * THIS DOES NOT TOUCH THE POSSESSION RULE. Nothing here can mark a shipment as
 * shipped. It only decides whether an already-unscanned label is "Awaiting UPS"
 * or "Overdue — No UPS Scan". A physical UPS scan remains the only thing that
 * confirms a shipment, and it is checked before any of this is consulted.
 */

import {
  addDays,
  endOfLocalDay,
  localDay,
  nextBusinessDay,
  nextWeekdayOnOrAfter,
  onOrNextBusinessDay,
  type BusinessCalendarOptions,
} from '../business-calendar';

/**
 * Services safe to send out on a Thursday or Friday.
 *
 * Ground and 3 Day Select carry the creams and shelf-stable products; cold
 * goods go air earlier in the week. ShipStation's service string is the proxy
 * for "cold" — imperfect, but it matches the observed pattern (Fridays are 139
 * air to 7 ground) and needs no extra data source.
 */
export function isGroundSafeService(service: string | null | undefined): boolean {
  return /ground|3\s*day\s*select/i.test(service ?? '');
}

export interface TenderPlan {
  /** Local calendar day we expect to hand the package to UPS. */
  tenderDay: string;
  /** Local calendar day after which an unscanned label is overdue. */
  dueDay: string;
  /** The instant that day ends. */
  dueAt: Date;
  /** Plain-language explanation, shown in the UI. */
  reason: string;
}

/**
 * Work out when this label should have reached UPS, and when to worry.
 *
 * @param labelCreatedAt when the label was printed
 * @param service        ShipStation service description
 */
export function planTender(
  labelCreatedAt: Date,
  service: string | null | undefined,
  options: BusinessCalendarOptions = {},
): TenderPlan {
  const { date, weekday } = localDay(labelCreatedAt, options.timeZone);
  const groundSafe = isGroundSafeService(service);

  let tenderDay: string;
  let reason: string;

  if (weekday === 0 || weekday === 6) {
    tenderDay = onOrNextBusinessDay(addDays(date, 1), options);
    reason = 'Printed at the weekend — expected out on the next business day.';
  } else if (weekday >= 1 && weekday <= 3) {
    // Mon–Wed: the normal cold/overnight cadence, out the same day.
    tenderDay = onOrNextBusinessDay(date, options);
    reason =
      tenderDay === date
        ? 'Printed Monday–Wednesday — expected out the same day.'
        : 'Printed on a holiday — expected out on the next business day.';
  } else if (groundSafe) {
    // Thu/Fri Ground-safe: creams and shelf-stable go out that day.
    tenderDay = onOrNextBusinessDay(date, options);
    reason = 'Ground-safe service printed Thursday/Friday — expected out the same day.';
  } else {
    // Thu/Fri air/cold: held for Monday rather than sitting over the weekend.
    tenderDay = nextWeekdayOnOrAfter(date, 1, options);
    reason = 'Cold/air service printed Thursday/Friday — held for the next open Monday.';
  }

  const dueDay = nextBusinessDay(tenderDay, options);
  return { tenderDay, dueDay, dueAt: endOfLocalDay(dueDay, options.timeZone), reason };
}

export interface OverdueInputs {
  labelCreatedAt: Date;
  service: string | null | undefined;
  /**
   * A label is never overdue sooner than this many hours, whatever the
   * calendar says. Keeps one simple floor in operator hands.
   */
  minimumHours: number;
  now?: Date;
  calendar?: BusinessCalendarOptions;
}

export interface OverdueVerdict {
  overdue: boolean;
  plan: TenderPlan;
  /** The moment it becomes overdue: the later of the cadence due time and the floor. */
  overdueAt: Date;
}

/**
 * Is this unscanned label late?
 *
 * Callers must already have established there is no physical scan; this
 * function has no opinion about possession and cannot grant it.
 */
export function evaluateOverdue(inputs: OverdueInputs): OverdueVerdict {
  const now = inputs.now ?? new Date();
  const plan = planTender(inputs.labelCreatedAt, inputs.service, inputs.calendar ?? {});
  const floor = new Date(inputs.labelCreatedAt.getTime() + inputs.minimumHours * 3_600_000);
  // The floor can only ever DELAY the alarm, never bring it forward.
  const overdueAt = plan.dueAt.getTime() >= floor.getTime() ? plan.dueAt : floor;
  return { overdue: now.getTime() > overdueAt.getTime(), plan, overdueAt };
}
