/**
 * Business-day calendar for the display timezone.
 *
 * Shipping cadence questions ("when would we actually have handed this to
 * UPS?") are calendar questions, not arithmetic on hours. A weekend or a
 * holiday is not a delay — nobody was in the building. This module is the one
 * place that knows which days count.
 *
 * All dates here are calendar days in `America/New_York` (or whatever
 * DISPLAY_TIMEZONE is set to), written as 'YYYY-MM-DD'. Instants stay UTC
 * everywhere else in the application; only this module thinks in local days.
 */

import { DISPLAY_TZ } from './time';

/** 0 = Sunday … 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Observed U.S. shipping holidays — the days UPS does not collect.
 *
 * Deliberately an explicit list rather than computed rules: the observed date
 * of a holiday shifts when it falls on a weekend, carriers do not all observe
 * the same set, and a wrong guess here silently changes what counts as
 * overdue. An explicit list is auditable and easy to correct.
 *
 * Only pickup-affecting holidays are listed. Extend as years are added; an
 * absent year simply means no holidays are skipped, which fails toward
 * flagging rather than hiding.
 */
export const SHIPPING_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026
  '2026-01-01', // New Year's Day
  '2026-05-25', // Memorial Day
  '2026-07-03', // Independence Day (observed, Jul 4 = Saturday)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas Day
  // 2027
  '2027-01-01', // New Year's Day
  '2027-05-31', // Memorial Day
  '2027-07-05', // Independence Day (observed, Jul 4 = Sunday)
  '2027-09-06', // Labor Day
  '2027-11-25', // Thanksgiving
  '2027-12-24', // Christmas Day (observed, Dec 25 = Saturday)
]);

export interface BusinessCalendarOptions {
  /** Override the holiday set — used by tests and by future configuration. */
  holidays?: ReadonlySet<string>;
  /** Weekdays on which UPS collects. Default Monday–Friday. */
  businessDays?: ReadonlySet<Weekday>;
  timeZone?: string;
}

const DEFAULT_BUSINESS_DAYS: ReadonlySet<Weekday> = new Set<Weekday>([1, 2, 3, 4, 5]);
const DAY_INDEX: Record<string, Weekday> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The local calendar day and weekday of an instant. */
export function localDay(
  instant: Date,
  timeZone: string = DISPLAY_TZ,
): { date: string; weekday: Weekday } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: DAY_INDEX[get('weekday')] ?? 0,
  };
}

/** Shift a 'YYYY-MM-DD' by whole days without tripping over DST. */
export function addDays(date: string, days: number): string {
  // Anchored at midday UTC so a ±1h DST shift can never roll the date over.
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The weekday of a calendar day, independent of any instant. */
export function weekdayOf(date: string): Weekday {
  return new Date(`${date}T12:00:00Z`).getUTCDay() as Weekday;
}

export function isHoliday(date: string, options: BusinessCalendarOptions = {}): boolean {
  return (options.holidays ?? SHIPPING_HOLIDAYS).has(date);
}

/** A day UPS collects: a configured weekday that is not a holiday. */
export function isBusinessDay(date: string, options: BusinessCalendarOptions = {}): boolean {
  const days = options.businessDays ?? DEFAULT_BUSINESS_DAYS;
  return days.has(weekdayOf(date)) && !isHoliday(date, options);
}

/** `date` itself when it is a business day, otherwise the next one. */
export function onOrNextBusinessDay(date: string, options: BusinessCalendarOptions = {}): string {
  let cursor = date;
  // Bounded so a misconfigured calendar cannot spin forever.
  for (let i = 0; i < 30; i++) {
    if (isBusinessDay(cursor, options)) return cursor;
    cursor = addDays(cursor, 1);
  }
  return cursor;
}

/** The next business day strictly after `date`. */
export function nextBusinessDay(date: string, options: BusinessCalendarOptions = {}): string {
  return onOrNextBusinessDay(addDays(date, 1), options);
}

/** The next occurrence of `weekday` strictly after `date`, skipped forward past holidays. */
export function nextWeekdayOnOrAfter(
  date: string,
  weekday: Weekday,
  options: BusinessCalendarOptions = {},
): string {
  let cursor = addDays(date, 1);
  for (let i = 0; i < 14 && weekdayOf(cursor) !== weekday; i++) cursor = addDays(cursor, 1);
  // If that day is a holiday (Labor Day, say) the shipment goes the next open day.
  return onOrNextBusinessDay(cursor, options);
}

/**
 * The instant a local calendar day ends, as UTC.
 *
 * Built by probing the zone's offset for that day rather than hard-coding one,
 * so it stays correct across daylight saving.
 */
export function endOfLocalDay(date: string, timeZone: string = DISPLAY_TZ): Date {
  const probe = new Date(`${date}T12:00:00Z`);
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(probe);
  const raw = formatted.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const offset = raw.replace('GMT', '') || '+00:00';
  const iso = `${date}T23:59:59.999${/^[+-]\d{2}:\d{2}$/.test(offset) ? offset : '+00:00'}`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? new Date(`${date}T23:59:59.999Z`) : parsed;
}
