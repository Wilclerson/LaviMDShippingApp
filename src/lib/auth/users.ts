/** User management queries. */

import { query, queryOne } from '../database/pool';
import { hashPassword, verifyPassword, dummyVerify } from './password';
import { logger } from '../logger';
import type { UserRole } from '../types';

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  is_active: boolean;
  last_login_at: Date | null;
  created_at: Date;
}

const USER_COLUMNS = 'id, email, name, role, is_active, last_login_at, created_at';

export async function listUsers(): Promise<UserRecord[]> {
  return query<UserRecord>(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at ASC`);
}

export async function getUserById(id: string): Promise<UserRecord | null> {
  return queryOne<UserRecord>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
}

export async function createUser(input: {
  email: string;
  name: string;
  role: UserRole;
  password: string;
}): Promise<UserRecord> {
  const passwordHash = await hashPassword(input.password);
  const row = await queryOne<UserRecord>(
    `INSERT INTO users (email, name, role, password_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING ${USER_COLUMNS}`,
    [input.email.trim().toLowerCase(), input.name.trim(), input.role, passwordHash],
  );
  if (!row) throw new Error('Failed to create user.');
  logger.info('user created', { userId: row.id, role: row.role });
  return row;
}

export async function setUserPassword(userId: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
  logger.info('user password changed', { userId });
}

export async function setUserActive(userId: string, isActive: boolean): Promise<void> {
  await query('UPDATE users SET is_active = $1 WHERE id = $2', [isActive, userId]);
  if (!isActive) await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  logger.info('user active flag changed', { userId, isActive });
}

export async function setUserRole(userId: string, role: UserRole): Promise<void> {
  await query('UPDATE users SET role = $1 WHERE id = $2', [role, userId]);
  logger.info('user role changed', { userId, role });
}

export async function countAdmins(): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM users WHERE role = 'admin' AND is_active = TRUE`,
  );
  return Number.parseInt(row?.count ?? '0', 10);
}

/**
 * Authenticate an email/password pair.
 *
 * Always performs a key-derivation step, even for unknown emails, so response
 * timing does not reveal whether an account exists.
 */
export async function authenticate(
  email: string,
  password: string,
): Promise<UserRecord | null> {
  const row = await queryOne<UserRecord & { password_hash: string }>(
    `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE LOWER(email) = LOWER($1)`,
    [email.trim()],
  );

  if (!row) {
    await dummyVerify();
    return null;
  }

  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) return null;

  if (!row.is_active) return null;

  await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [row.id]);

  const { password_hash: _ignored, ...safe } = row;
  return safe;
}
