'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function SyncButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function trigger() {
    setBusy(true);
    setMessage(null);
    try {
      // `credentials` is explicit on purpose. Its default varies by browser,
      // webview and privacy setting, and when it resolves to "omit" the session
      // cookie never leaves the page — the request reaches the server looking
      // exactly like an anonymous one and is rejected at the edge, while normal
      // page navigation keeps working because documents always carry cookies.
      const response = await fetch('/api/sync', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) {
          setMessage(
            payload.code === 'session_cookie_missing'
              ? 'Your browser did not send the session cookie. Sign in again, and check that cookies are enabled for this site.'
              : 'Your session has expired. Please sign in again.',
          );
          return;
        }
        setMessage(payload.error ?? 'Sync failed.');
        return;
      }
      const seen = (payload.passes ?? []).reduce(
        (total: number, pass: { seen?: number }) => total + (pass.seen ?? 0),
        0,
      );
      setMessage(
        payload.ok
          ? `Sync complete — ${seen} record(s) examined in ${Math.round((payload.durationMs ?? 0) / 1000)}s.`
          : 'Sync finished with errors. See the pass table below.',
      );
      router.refresh();
    } catch {
      setMessage('Network error while triggering the sync.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="toolbar">
      <button type="button" className="btn btn-primary" onClick={trigger} disabled={busy}>
        {busy ? 'Syncing…' : 'Run sync now'}
      </button>
      {message && <span className="subtle">{message}</span>}
    </div>
  );
}
