'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The one client-side path that triggers a sync.
 *
 * Both the dashboard's "Refresh Data" button and the System page's "Run sync
 * now" button render this. There is a single sync implementation behind it —
 * POST /api/sync — which authorises the caller's session server-side and never
 * sees CRON_SECRET. Cron uses its own endpoint and its own shared-secret check;
 * the two authorisation paths stay entirely separate.
 */

interface SyncTriggerProps {
  idleLabel: string;
  busyLabel: string;
  /**
   * Shown on success. When omitted the detailed record counts are shown
   * instead, which is what the System page wants.
   */
  successLabel?: string;
  className?: string;
}

export function SyncTriggerButton({
  idleLabel,
  busyLabel,
  successLabel,
  className = 'btn btn-primary',
}: SyncTriggerProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function trigger() {
    // Guard as well as `disabled`: a fast double-click, an Enter key repeat or
    // a re-render between click and state flush can all get a second call in
    // before the attribute takes effect. A sync is expensive; running two is
    // wasteful and makes the API rate limits work harder than they need to.
    if (busy) return;

    setBusy(true);
    setMessage(null);
    setFailed(false);
    try {
      // `credentials` is explicit: its default varies by browser, webview and
      // privacy setting, and when it resolves to "omit" the session cookie
      // never leaves the page and the request arrives looking anonymous.
      const response = await fetch('/api/sync', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setFailed(true);
        if (response.status === 401) {
          setMessage(
            payload.code === 'session_cookie_missing'
              ? 'Your browser did not send the session cookie. Sign in again, and check that cookies are enabled for this site.'
              : 'Your session has expired. Please sign in again.',
          );
          return;
        }
        // Surface whatever the backend actually said rather than a generic line.
        setMessage(payload.error ?? `Refresh failed (${response.status}).`);
        return;
      }

      const seen = (payload.passes ?? []).reduce(
        (total: number, pass: { seen?: number }) => total + (pass.seen ?? 0),
        0,
      );
      if (!payload.ok) {
        setFailed(true);
        setMessage('Sync finished with errors. See the System page for details.');
      } else {
        setMessage(
          successLabel ??
            `Sync complete — ${seen} record(s) examined in ${Math.round((payload.durationMs ?? 0) / 1000)}s.`,
        );
      }
      // Re-render the server components so "Last sync" and the shipment table
      // reflect what just landed.
      router.refresh();
    } catch {
      setFailed(true);
      setMessage('Network error while triggering the sync.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="toolbar">
      <button
        type="button"
        className={className}
        onClick={trigger}
        disabled={busy}
        aria-busy={busy}
      >
        {busy ? busyLabel : idleLabel}
      </button>
      {message && (
        <span className={failed ? 'subtle tone-critical' : 'subtle'} role="status">
          {message}
        </span>
      )}
    </div>
  );
}

/** Dashboard, beside the "Last sync" indicator. Available to every signed-in user. */
export function RefreshDataButton() {
  return (
    <SyncTriggerButton
      idleLabel="Refresh Data"
      busyLabel="Refreshing…"
      successLabel="Data refreshed successfully"
      className="btn btn-sm btn-primary"
    />
  );
}

/** System page. Same endpoint, but reports the per-pass record counts. */
export function SyncButton() {
  return <SyncTriggerButton idleLabel="Run sync now" busyLabel="Syncing…" />;
}
