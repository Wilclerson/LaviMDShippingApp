/**
 * Role-based access control.
 *
 *   admin       — view everything, resolve exceptions, add notes, manage users
 *   fulfillment — view shipments, search, view tracking, add notes
 */

import { redirect } from 'next/navigation';
import type { UserRole } from '../types';
import { getCurrentUser, type SessionUser } from './session';

export type Permission =
  | 'shipments:view'
  | 'shipments:search'
  | 'shipments:note'
  | 'shipments:resolve'
  | 'sync:trigger'
  | 'users:manage'
  | 'system:view';

const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  admin: [
    'shipments:view',
    'shipments:search',
    'shipments:note',
    'shipments:resolve',
    'sync:trigger',
    'users:manage',
    'system:view',
  ],
  fulfillment: ['shipments:view', 'shipments:search', 'shipments:note', 'system:view'],
};

export function can(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** For server components: redirect to login when unauthenticated. */
export async function requireUser(returnTo?: string): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) {
    const target = returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : '/login';
    redirect(target);
  }
  return user;
}

export async function requirePermission(
  permission: Permission,
  returnTo?: string,
): Promise<SessionUser> {
  const user = await requireUser(returnTo);
  if (!can(user.role, permission)) redirect('/?error=forbidden');
  return user;
}

/** For route handlers: return a typed result instead of redirecting. */
/**
 * Distinguishes auth failures that look identical from the outside.
 *   session_invalid   — a cookie arrived, but no live session matches it
 *   permission_denied — authenticated, but the role lacks the permission
 * The middleware emits a third code, `session_cookie_missing`, for the case
 * where no cookie reached the server at all. Collapsing these into one message
 * is what made this class of failure undiagnosable in production.
 */
export type ApiAuthFailureCode = 'session_invalid' | 'permission_denied';

export type ApiAuthResult =
  | { ok: true; user: SessionUser }
  | { ok: false; status: 401 | 403; message: string; code: ApiAuthFailureCode };

export async function authorizeApi(permission: Permission): Promise<ApiAuthResult> {
  const user = await getCurrentUser();
  if (!user) {
    return {
      ok: false,
      status: 401,
      message: 'Your session has expired or is no longer valid. Please sign in again.',
      code: 'session_invalid',
    };
  }
  if (!can(user.role, permission)) {
    return {
      ok: false,
      status: 403,
      message: 'You do not have permission to do that.',
      code: 'permission_denied',
    };
  }
  return { ok: true, user };
}
