/**
 * The session cookie name — single source of truth.
 *
 * This lives alone, with NO imports, because it is needed in two runtimes that
 * cannot share code: the Edge middleware and the Node server modules. Edge
 * cannot import `session.ts` (it pulls in `pg`), so the name used to be typed
 * out twice — once here and once in the middleware. Two copies of a magic
 * string that must agree is a silent-failure waiting to happen: if they ever
 * drift, every authenticated API call 401s while pages keep working, which is
 * indistinguishable from a browser not sending the cookie at all.
 */
export const SESSION_COOKIE = 'lavimd_session';
