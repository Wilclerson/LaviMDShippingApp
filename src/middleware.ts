import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge-level gate.
 *
 * This only checks for the presence of a session cookie — validating it needs
 * the database, which is not available in the Edge runtime. The authoritative
 * check happens in each page/route via requireUser / authorizeApi. This layer
 * exists to redirect anonymous browsers to the login page cheaply, and to keep
 * unauthenticated traffic off the database entirely.
 */

const SESSION_COOKIE = 'lavimd_session';

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
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
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
