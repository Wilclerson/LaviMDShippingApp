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
      const response = await fetch('/api/sync', { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
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
