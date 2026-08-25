/**
 * Cookie session management.
 *
 * The cookie carries an opaque random token. Only a SHA-256 hash of that token
 * is stored in the database, so a database leak does not yield usable sessions.
 * Sessions are server-side revocable (delete the row) and expire absolutely.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { env } from '../env';
import { logger } from '../logger';
import { query, queryOne } from '../database/pool';
import type { UserRole } from '../types';

export const SESSION_COOKIE = 'lavimd_session';
const SESSION_TTL_HOURS = 12;
/** A session is extended on use, but never past this absolute lifetime. */
const SESSION_ABSOLUTE_MAX_HOURS = 24 * 7;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  userId: string,
  meta: { userAgent?: string | null; ipAddress?: string | null } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3_600_000);

  await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, hashToken(token), expiresAt, meta.userAgent ?? null, meta.ipAddress ?? null],
  );

  return { token, expiresAt };
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

interface SessionRow {
  session_id: string;
  user_id: string;
  email: string;
  name: string;
  role: UserRole;
  expires_at: Date;
  created_at: Date;
  is_active: boolean;
}

/** Resolve the caller's session, or null. Also refreshes the sliding expiry. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const row = await queryOne<SessionRow>(
    `SELECT s.id AS session_id, s.expires_at, s.created_at,
            u.id AS user_id, u.email, u.name, u.role, u.is_active
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1`,
    [hashToken(token)],
  );

  if (!row) return null;

  if (!row.is_active) {
    await destroySession(token);
    return null;
  }

  const now = Date.now();
  if (row.expires_at.getTime() <= now) {
    await destroySession(token);
    return null;
  }

  const absoluteDeadline =
    row.created_at.getTime() + SESSION_ABSOLUTE_MAX_HOURS * 3_600_000;
  if (now >= absoluteDeadline) {
    await destroySession(token);
    return null;
  }

  // Slide the expiry forward, capped at the absolute deadline. Only write when
  // it moves by more than a minute so a page with many queries is not chatty.
  const nextExpiry = new Date(Math.min(now + SESSION_TTL_HOURS * 3_600_000, absoluteDeadline));
  if (nextExpiry.getTime() - row.expires_at.getTime() > 60_000) {
    await query('UPDATE sessions SET expires_at = $1, last_seen_at = NOW() WHERE id = $2', [
      nextExpiry,
      row.session_id,
    ]);
  }

  return { id: row.user_id, email: row.email, name: row.name, role: row.role };
}

export async function destroySession(token: string): Promise<void> {
  await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

export async function destroyCurrentSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await destroySession(token);
  await clearSessionCookie();
}

export async function destroyAllSessionsForUser(userId: string): Promise<void> {
  await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

/** Housekeeping, invoked from the sync cron. */
export async function purgeExpiredSessions(): Promise<number> {
  const rows = await query<{ count: string }>(
    `WITH deleted AS (DELETE FROM sessions WHERE expires_at < NOW() RETURNING 1)
     SELECT COUNT(*)::text AS count FROM deleted`,
  );
  const count = Number.parseInt(rows[0]?.count ?? '0', 10);
  if (count > 0) logger.info('purged expired sessions', { count });
  return count;
}

/**
 * Constant-time comparison for the cron shared secret.
 * Exported here so both the cron routes and tests use the same implementation.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
