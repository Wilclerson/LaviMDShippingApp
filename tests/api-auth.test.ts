/**
 * The authenticated-API path, as it behaves in production.
 *
 * Background: in production the "Run sync now" button returned
 * "Authentication required." while page navigation worked normally. Two defects
 * combined to make that both possible and undiagnosable:
 *
 *   1. Every client fetch relied on the DEFAULT value of `credentials`. When
 *      that resolves to "omit", the session cookie never leaves the page and
 *      the request arrives looking anonymous — while document navigation keeps
 *      working, because documents always carry cookies. That asymmetry is
 *      exactly what was observed.
 *   2. The edge middleware and the route-level check returned the SAME message,
 *      so "no cookie was sent" and "the session is invalid" were impossible to
 *      tell apart from the outside.
 *
 * A third latent hazard: the cookie name was typed out separately in the
 * middleware and in session.ts. Drift there produces this identical symptom.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SESSION_COOKIE } from '../src/lib/auth/cookie-name';

const read = (p: string) => readFileSync(p, 'utf8');

describe('session cookie name has one definition', () => {
  test('the shared constant is the expected name', () => {
    assert.equal(SESSION_COOKIE, 'lavimd_session');
  });

  test('the middleware imports it rather than redefining it', () => {
    const mw = read('src/middleware.ts');
    assert.ok(
      /import\s*\{\s*SESSION_COOKIE\s*\}\s*from\s*'@\/lib\/auth\/cookie-name'/.test(mw),
      'middleware must import the shared cookie name',
    );
    assert.ok(
      !/const\s+SESSION_COOKIE\s*=\s*'/.test(mw),
      'middleware must not declare its own copy of the cookie name',
    );
  });

  test('session.ts re-exports the same constant', () => {
    const s = read('src/lib/auth/session.ts');
    assert.ok(/from '\.\/cookie-name'/.test(s));
    assert.ok(
      !/const\s+SESSION_COOKIE\s*=\s*'lavimd_session'/.test(s),
      'session.ts must not declare its own copy either',
    );
  });

  test('the literal appears in exactly one source file', () => {
    const files = [
      'src/middleware.ts',
      'src/lib/auth/session.ts',
      'src/lib/auth/cookie-name.ts',
    ];
    const withLiteral = files.filter((f) => read(f).includes("'lavimd_session'"));
    assert.deepEqual(withLiteral, ['src/lib/auth/cookie-name.ts']);
  });
});

describe('every client fetch sends credentials explicitly', () => {
  const components = [
    'src/components/SyncButton.tsx',
    'src/components/NoteForm.tsx',
    'src/components/ResolveForm.tsx',
  ];

  test('no fetch to an API route omits `credentials`', () => {
    for (const file of components) {
      const source = read(file);
      // Each fetch(...) call object must carry credentials.
      const calls = source.split('await fetch(').slice(1);
      assert.ok(calls.length > 0, `${file} should contain at least one fetch`);
      for (const call of calls) {
        const head = call.slice(0, 400);
        assert.ok(
          head.includes("credentials: 'same-origin'"),
          `${file}: a fetch call is missing credentials: 'same-origin'`,
        );
      }
    }
  });

  test('credentials is same-origin, never include', () => {
    // 'include' would attach cookies to cross-origin requests too — unnecessary
    // here and a needless widening of where the session token can travel.
    for (const file of components) {
      assert.ok(!read(file).includes("credentials: 'include'"), `${file} must not use include`);
    }
  });
});

describe('auth failures are distinguishable', () => {
  test('the middleware emits session_cookie_missing for API routes', () => {
    const mw = read('src/middleware.ts');
    assert.ok(mw.includes("code: 'session_cookie_missing'"));
    assert.ok(mw.includes('status: 401'));
  });

  test('the middleware still redirects page requests instead of 401ing', () => {
    const mw = read('src/middleware.ts');
    assert.ok(mw.includes('NextResponse.redirect'), 'pages must redirect to login');
    assert.ok(mw.includes("pathname.startsWith('/api/')"), 'API vs page split must remain');
  });

  test('route-level auth emits its own codes', () => {
    const rbac = read('src/lib/auth/rbac.ts');
    assert.ok(rbac.includes("code: 'session_invalid'"));
    assert.ok(rbac.includes("code: 'permission_denied'"));
    // The two layers must not EMIT the same code, or the distinction is lost
    // again. (The middleware's code may be referenced in a comment.)
    assert.ok(!rbac.includes("code: 'session_cookie_missing'"));
  });

  test('routes forward the code to the client', () => {
    for (const file of [
      'src/app/api/sync/route.ts',
      'src/app/api/shipments/[id]/notes/route.ts',
      'src/app/api/shipments/[id]/resolve/route.ts',
    ]) {
      assert.ok(
        read(file).includes('jsonError(auth.message, auth.status, auth.code)'),
        `${file} must pass the auth failure code through`,
      );
    }
  });
});

describe('the manual sync stays admin-authenticated', () => {
  test('/api/sync still requires the sync:trigger permission', () => {
    const route = read('src/app/api/sync/route.ts');
    assert.ok(route.includes("authorizeApi('sync:trigger')"));
    assert.ok(route.includes('if (!auth.ok) return jsonError'), 'must bail before syncing');
  });

  test('/api/sync is NOT in the middleware public allowlist', () => {
    const mw = read('src/middleware.ts');
    const publicPaths = /const PUBLIC_PATHS = \[(.*?)\]/s.exec(mw)?.[1] ?? '';
    assert.ok(!publicPaths.includes("'/api/sync'"), 'the manual sync must never be public');
    assert.ok(publicPaths.includes("'/api/cron'"), 'cron keeps its own secret-based auth');
  });

  test('only admins hold sync:trigger', async () => {
    const { can } = await import('../src/lib/auth/rbac');
    assert.equal(can('admin', 'sync:trigger'), true);
    assert.equal(can('fulfillment', 'sync:trigger'), false);
  });
});

describe('cron auth remains separate from admin auth', () => {
  test('cron routes authorise by shared secret, not by session', () => {
    for (const file of ['src/app/api/cron/sync/route.ts', 'src/app/api/cron/daily-report/route.ts']) {
      const source = read(file);
      assert.ok(source.includes('authorizeCron('), `${file} must use authorizeCron`);
      assert.ok(!source.includes('authorizeApi('), `${file} must not use session auth`);
    }
  });

  test('authorizeCron accepts a bearer token or ?secret and compares in constant time', () => {
    const api = read('src/lib/http/api.ts');
    assert.ok(api.includes("headers.get('authorization')"), 'bearer header supported');
    assert.ok(api.includes("searchParams.get('secret')"), 'query fallback supported');
    assert.ok(api.includes('safeEqual('), 'constant-time comparison');
  });

  test('the session cookie plays no part in cron authorisation', () => {
    assert.ok(!read('src/lib/http/api.ts').includes('SESSION_COOKIE'));
  });
});
