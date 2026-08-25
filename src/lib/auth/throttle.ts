/**
 * Login throttling.
 *
 * Failed sign-ins are counted per email address and per client IP over a
 * rolling window. Once either crosses its limit, further attempts are refused
 * without touching the password hash at all.
 *
 * Design notes:
 *  - Counting both dimensions matters: per-email alone lets an attacker spray
 *    one password across many accounts; per-IP alone lets a botnet through.
 *  - A successful sign-in clears that email's failures, so a user who finally
 *    remembers their password is not left locked out.
 *  - The lockout is a rolling window, not a permanent flag, so nobody needs an
 *    administrator to let them back in.
 */

import { query } from '../database/pool';
import { logger } from '../logger';

const WINDOW_MINUTES = 15;
const MAX_FAILURES_PER_EMAIL = 8;
const MAX_FAILURES_PER_IP = 25;

export interface ThrottleDecision {
  allowed: boolean;
  retryAfterMinutes: number;
}

function emailKey(email: string): string {
  return `email:${email.trim().toLowerCase()}`;
}

function ipKey(ip: string): string {
  return `ip:${ip.trim()}`;
}

/** Check whether this sign-in attempt may proceed. */
export async function checkLoginAllowed(
  email: string,
  ipAddress: string | null,
): Promise<ThrottleDecision> {
  const identifiers = [emailKey(email)];
  if (ipAddress) identifiers.push(ipKey(ipAddress));

  const rows = await query<{ identifier: string; failures: string }>(
    `SELECT identifier, COUNT(*)::text AS failures
       FROM login_attempts
      WHERE identifier = ANY($1::text[])
        AND successful = FALSE
        AND attempted_at > NOW() - ($2 || ' minutes')::interval
      GROUP BY identifier`,
    [identifiers, String(WINDOW_MINUTES)],
  );

  for (const row of rows) {
    const failures = Number.parseInt(row.failures, 10);
    const limit = row.identifier.startsWith('email:')
      ? MAX_FAILURES_PER_EMAIL
      : MAX_FAILURES_PER_IP;

    if (failures >= limit) {
      logger.warn('login throttled', {
        // The identifier kind is useful; the value is not logged.
        kind: row.identifier.startsWith('email:') ? 'email' : 'ip',
        failures,
        limit,
      });
      return { allowed: false, retryAfterMinutes: WINDOW_MINUTES };
    }
  }

  return { allowed: true, retryAfterMinutes: 0 };
}

export async function recordLoginAttempt(
  email: string,
  ipAddress: string | null,
  successful: boolean,
): Promise<void> {
  const rows: [string, boolean][] = [[emailKey(email), successful]];
  if (ipAddress) rows.push([ipKey(ipAddress), successful]);

  await query(
    `INSERT INTO login_attempts (identifier, successful)
     SELECT * FROM UNNEST($1::text[], $2::boolean[])`,
    [rows.map((r) => r[0]), rows.map((r) => r[1])],
  );

  // A success wipes that email's recent failures so the user is not left
  // locked out by their own earlier typos.
  if (successful) {
    await query(
      `DELETE FROM login_attempts
        WHERE identifier = $1 AND successful = FALSE`,
      [emailKey(email)],
    );
  }
}

/** Housekeeping, invoked from the sync cron alongside session purging. */
export async function purgeOldLoginAttempts(): Promise<number> {
  const rows = await query<{ count: string }>(
    `WITH deleted AS (
       DELETE FROM login_attempts WHERE attempted_at < NOW() - INTERVAL '30 days' RETURNING 1
     )
     SELECT COUNT(*)::text AS count FROM deleted`,
  );
  return Number.parseInt(rows[0]?.count ?? '0', 10);
}
