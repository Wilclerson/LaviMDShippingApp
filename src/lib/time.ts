/**
 * Time helpers.
 *
 * Storage is always UTC. Display is always America/New_York (configurable via
 * DISPLAY_TIMEZONE). Nothing in the app formats a date without going through
 * here, so the two never get mixed up.
 */

import { env } from './env';

export const DISPLAY_TZ = env.displayTimeZone;

export function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 3_600_000;
}

/** "3d 4h" / "5h 12m" / "42m" — compact age for tables and email. */
export function formatAge(from: Date | null, now: Date = new Date()): string {
  if (!from) return '—';
  const totalMinutes = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function parts(date: Date, tz: string = DISPLAY_TZ): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return out;
}

/** "Aug 26, 2026 8:04 AM" in the display timezone. */
export function formatDateTime(date: Date | null, tz: string = DISPLAY_TZ): string {
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

/** "Aug 26, 8:04 AM" — compact variant for dense tables. */
export function formatDateTimeShort(date: Date | null, tz: string = DISPLAY_TZ): string {
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

/** "August 26, 2026" — used in the email subject line. */
export function formatLongDate(date: Date, tz: string = DISPLAY_TZ): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

/** "2026-08-26" as observed in the display timezone (not UTC). */
export function toLocalDateKey(date: Date, tz: string = DISPLAY_TZ): string {
  const p = parts(date, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Parse UPS's YYYYMMDD + HHMMSS pair into a UTC Date. */
export function parseUpsDateTime(
  date: string | null | undefined,
  time: string | null | undefined,
  gmtOffset?: string | null,
): Date | null {
  if (!date || !/^\d{8}$/.test(date)) return null;
  const y = date.slice(0, 4);
  const m = date.slice(4, 6);
  const d = date.slice(6, 8);

  const t = (time ?? '000000').padEnd(6, '0').slice(0, 6);
  if (!/^\d{6}$/.test(t)) return null;
  const hh = t.slice(0, 2);
  const mm = t.slice(2, 4);
  const ss = t.slice(4, 6);

  // UPS returns gmtDate/gmtTime alongside a gmtOffset like "-05:00". When the
  // offset is supplied the timestamp is unambiguous; otherwise the local scan
  // time is the best available and is interpreted as Eastern, our own tz.
  const offset = gmtOffset && /^[+-]\d{2}:\d{2}$/.test(gmtOffset) ? gmtOffset : null;
  const iso = `${y}-${m}-${d}T${hh}:${mm}:${ss}${offset ?? 'Z'}`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Parse a UPS YYYYMMDD date into a plain "YYYY-MM-DD" string. */
export function parseUpsDateOnly(date: string | null | undefined): string | null {
  if (!date || !/^\d{8}$/.test(date)) return null;
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

/** Format a Date as UPS expects in Quantum View ranges: YYYYMMDDHHmmss (UTC). */
export function toUpsDateTimeString(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
  );
}

/**
 * The UTC instant of the most recent `hour`:00 in the display timezone.
 * Used to anchor the 8:00 AM America/New_York report window correctly across
 * daylight-saving transitions.
 */
export function localHourToUtc(reference: Date, hour: number, tz: string = DISPLAY_TZ): Date {
  const p = parts(reference, tz);
  const target = `${p.year}-${p.month}-${p.day}T${String(hour).padStart(2, '0')}:00:00`;
  // Determine the tz offset at that wall-clock moment by round-tripping.
  const guess = new Date(`${target}Z`);
  const guessParts = parts(guess, tz);
  const guessLocal = Date.parse(
    `${guessParts.year}-${guessParts.month}-${guessParts.day}T${guessParts.hour}:${guessParts.minute}:${guessParts.second}Z`,
  );
  const offsetMs = guessLocal - guess.getTime();
  return new Date(guess.getTime() - offsetMs);
}
