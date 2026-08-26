import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth/cookie-name';

/**
 * Edge-level gate.
 *
 * This only checks for the presence of a session cookie — validating it needs
 * the database, which is not available in the Edge runtime. The authoritative
 * check happens in each page/route via requireUser / authorizeApi. This layer
 * exists to redirect anonymous browsers to the login page cheaply, and to keep
 * unauthenticated traffic off the database entirely.
 *
 * The cookie name is imported rather than retyped: this file and session.ts run
 * in different runtimes and cannot share much, but a duplicated cookie name
 * that silently drifts would 401 every authenticated API call while pages kept
 * working — a failure that is very hard to read from the outside.
 *
 * Its 401 carries a DIFFERENT code from the route-level one on purpose. "The
 * browser sent no cookie" and "the session is invalid or expired" are different
 * faults with different fixes, and emitting one indistinguishable message for
 * both makes production diagnosis guesswork.
 */

const PUBLIC_PATHS = ['/login', '/api/auth/logout', '/api/cron'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return NextResponse.next();
  }

  const hasSession = request.cookies.has(SESSION_COOKIE);
  if (hasSession) return NextResponse.next();

  // API callers get a 401 rather than an HTML redirect.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      {
        error: 'Authentication required. No session cookie was sent with this request.',
        code: 'session_cookie_missing',
      },
      { status: 401 },
    );
  }

  const loginUrl = new URL('/login', request.url);
  if (pathname !== '/') loginUrl.searchParams.set('next', pathname + request.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // Everything except Next internals and static assets.
    '/((?!_next/static|_next/image|favicon.ico|robots.txt).*)',
  ],
};
