/**
 * The dashboard "Refresh Data" button.
 *
 * It is a second entry point to the SAME sync — POST /api/sync — not a second
 * implementation. The interesting properties are that it stays behind session
 * auth, that widening it to fulfillment did not widen anything else, and that
 * a double-click cannot start two syncs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { can, type Permission } from '../src/lib/auth/rbac';

const read = (p: string) => readFileSync(p, 'utf8');
const TRIGGER = 'src/components/SyncTrigger.tsx';

describe('authorisation for triggering a sync', () => {
  test('admin can refresh', () => {
    assert.equal(can('admin', 'sync:trigger'), true);
  });

  test('fulfillment can refresh', () => {
    assert.equal(can('fulfillment', 'sync:trigger'), true);
  });

  test('unauthenticated callers cannot — there is no anonymous path', () => {
    // Two independent gates, neither of which consults a role: the edge
    // middleware requires a session cookie, and the route re-checks the session
    // against the database. A caller with no session reaches neither role.
    const mw = read('src/middleware.ts');
    const publicPaths = /const PUBLIC_PATHS = \[(.*?)\]/s.exec(mw)?.[1] ?? '';
    assert.ok(!publicPaths.includes("'/api/sync'"));
    assert.ok(read('src/app/api/sync/route.ts').includes("authorizeApi('sync:trigger')"));
  });

  test('widening sync did NOT widen any admin-only control', () => {
    const adminOnly: Permission[] = ['shipments:resolve', 'users:manage'];
    for (const p of adminOnly) {
      assert.equal(can('admin', p), true, `admin should keep ${p}`);
      assert.equal(can('fulfillment', p), false, `fulfillment must NOT gain ${p}`);
    }
  });

  test('fulfillment keeps exactly its intended permission set', () => {
    // system:view left this set when the System page became admin-only: it
    // exposes integration configuration and error logs.
    const expected: Permission[] = [
      'shipments:view',
      'shipments:search',
      'shipments:note',
      'sync:trigger',
    ];
    const all: Permission[] = [
      'shipments:view', 'shipments:search', 'shipments:note', 'shipments:resolve',
      'sync:trigger', 'users:manage', 'system:view',
    ];
    for (const p of all) {
      assert.equal(
        can('fulfillment', p),
        expected.includes(p),
        `fulfillment permission for ${p} is not what was intended`,
      );
    }
  });
});

describe('the Refresh Data button', () => {
  const source = read(TRIGGER);

  test('renders the required labels', () => {
    assert.ok(source.includes("idleLabel=\"Refresh Data\""), 'button text');
    assert.ok(source.includes("busyLabel=\"Refreshing…\""), 'busy text');
    assert.ok(source.includes("successLabel=\"Data refreshed successfully\""), 'success text');
  });

  test('is disabled while running and guards against double-clicks', () => {
    assert.ok(source.includes('disabled={busy}'), 'disabled while busy');
    assert.ok(/if\s*\(busy\)\s*return;/.test(source), 're-entry guard, not just the attribute');
    assert.ok(source.includes('aria-busy={busy}'), 'busy state is announced');
  });

  test('revalidates the page on success so Last sync updates', () => {
    assert.ok(source.includes('router.refresh()'));
  });

  test('surfaces the API error rather than a generic message', () => {
    assert.ok(source.includes('payload.error'), 'uses the backend error text');
    assert.ok(source.includes("payload.code === 'session_cookie_missing'"), 'names the cookie case');
  });

  test('sends the session cookie explicitly', () => {
    assert.ok(source.includes("credentials: 'same-origin'"));
  });

  test('there is ONE sync implementation behind both buttons', () => {
    // Both exports render the same component, which calls the one endpoint.
    const posts = source.split("fetch('/api/sync'").length - 1;
    assert.equal(posts, 1, 'exactly one call site for the sync endpoint');
    assert.ok(source.includes('export function RefreshDataButton'));
    assert.ok(source.includes('export function SyncButton'));
    assert.ok(source.includes('SyncTriggerButton'), 'both delegate to the shared component');
  });

  test('the client component reads no server secret', () => {
    // What matters is that no secret VALUE can reach the browser, not whether
    // the words appear in a comment. So: this is the only 'use client' file in
    // the path, and it must not read process.env or import the server env
    // module — which is where CRON_SECRET and every credential live.
    assert.ok(source.startsWith("'use client'"), 'SyncTrigger is the client boundary');
    assert.ok(!source.includes('process.env'), 'no direct env access');
    assert.ok(!/from '@\/lib\/env'/.test(source), 'no import of the server env module');
    assert.ok(!/from '.*auth\/session'/.test(source), 'no import of session internals');

    // AppHeader renders it and is a server component; it must not have become a
    // client component carrying server config across the boundary.
    const header = read('src/components/AppHeader.tsx');
    assert.ok(!header.includes("'use client'"), 'AppHeader stays a server component');
    assert.ok(!header.includes('process.env'));
  });

  test('the sync endpoint authorises by session, never by CRON_SECRET', () => {
    const route = read('src/app/api/sync/route.ts');
    assert.ok(!route.includes('authorizeCron'), '/api/sync must not accept the cron secret');
    assert.ok(route.includes("authorizeApi('sync:trigger')"));
  });
});

describe('placement', () => {
  /**
   * The button lived in AppHeader's `.header-meta`, which the stylesheet hides
   * below 900px — so on a phone or tablet the warehouse had no refresh control
   * and no Last sync readout at all. Both now live in a dashboard context bar
   * that survives every width.
   */
  test('the dashboard renders the button in its own context bar', () => {
    const page = read('src/app/page.tsx');
    assert.ok(page.includes('<RefreshDataButton />'), 'dashboard renders it directly');
    assert.ok(page.includes('context-bar'), 'in the always-visible context bar');
    assert.ok(page.includes('Last sync:'), 'next to the Last sync readout');
  });

  test('it is permission-gated on the dashboard', () => {
    const page = read('src/app/page.tsx');
    assert.ok(page.includes("can(user.role, 'sync:trigger')"), 'gated by permission');
    assert.ok(page.includes('canRefresh &&'), 'and only rendered when allowed');
  });

  test('the context bar is not hidden on narrow screens', () => {
    const css = read('src/app/globals.css');
    // .header-meta is still hidden below 900px; .context-bar must never be.
    const hidden = /\.context-bar[^{]*\{[^}]*display:\s*none/.test(css);
    assert.equal(hidden, false, 'the context bar must survive small screens');
    assert.ok(css.includes('.context-bar'), 'the context bar is styled');
  });

  test('AppHeader no longer carries the refresh control', () => {
    const header = read('src/components/AppHeader.tsx');
    assert.ok(!header.includes('RefreshDataButton'), 'moved out of the hidden header block');
  });
});
