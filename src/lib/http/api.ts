/**
 * Shared helpers for route handlers: JSON responses, input validation, and the
 * CRON_SECRET check.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { env } from '../env';
import { logger } from '../logger';
import { safeEqual } from '../auth/session';

export function jsonError(message: string, status: number, code?: string): NextResponse {
  return NextResponse.json(code ? { error: message, code } : { error: message }, { status });
}

export function jsonOk<T extends Record<string, unknown>>(body: T, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

/** Parse and validate a JSON request body. Never trusts the client. */
export async function parseBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: jsonError('Request body must be valid JSON.', 400) };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    return { ok: false, response: jsonError(message, 400) };
  }
  return { ok: true, data: result.data };
}

export const UUID_SCHEMA = z.string().uuid('must be a valid shipment id');

/**
 * Authorise a cron/scheduler request.
 *
 * Accepts `Authorization: Bearer <CRON_SECRET>` (preferred) or `?secret=` for
 * schedulers that cannot set headers. Comparison is constant-time. Vercel Cron's
 * own `x-vercel-cron` header is accepted only alongside a valid secret — the
 * header alone is not proof of anything.
 */
export function authorizeCron(request: Request): { ok: true } | { ok: false; response: NextResponse } {
  let expected: string;
  try {
    expected = env.cron.secret();
  } catch {
    logger.error('CRON_SECRET is not configured; refusing cron request');
    return { ok: false, response: jsonError('Server is missing CRON_SECRET.', 500) };
  }

  const header = request.headers.get('authorization') ?? '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
  const querySecret = new URL(request.url).searchParams.get('secret');
  const supplied = bearer ?? querySecret;

  if (!supplied || !safeEqual(supplied, expected)) {
    logger.warn('rejected unauthorised cron request', {
      hasHeader: Boolean(bearer),
      hasQuery: Boolean(querySecret),
    });
    return { ok: false, response: jsonError('Unauthorized.', 401) };
  }

  return { ok: true };
}

/** Best-effort client IP for the audit log. */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? null;
  return request.headers.get('x-real-ip');
}
