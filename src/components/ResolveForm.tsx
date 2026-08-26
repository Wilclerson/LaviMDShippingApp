'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RESOLUTION_REASONS } from '@/lib/types';

export function ResolveForm({ shipmentId }: { shipmentId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>(RESOLUTION_REASONS[0]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/shipments/${shipmentId}/resolve`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, note: note.trim() || null }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload.error ?? 'Could not resolve this shipment.');
        return;
      }
      setOpen(false);
      setNote('');
      router.refresh();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
        Mark resolved
      </button>
    );
  }

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 10 }}>
      {error && <div className="form-error" style={{ margin: 0 }}>{error}</div>}
      <div>
        <label className="field-label" htmlFor="resolve-reason">Reason</label>
        <select
          id="resolve-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
        >
          {RESOLUTION_REASONS.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="field-label" htmlFor="resolve-note">Note (optional)</label>
        <textarea
          id="resolve-note"
          rows={3}
          value={note}
          maxLength={2000}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Context for the audit trail…"
        />
      </div>
      <div className="toolbar">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Confirm resolution'}
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
      <p className="subtle" style={{ margin: 0 }}>
        The shipment record is never deleted. Resolving it removes it from the attention list and
        records who resolved it and why.
      </p>
    </form>
  );
}

export function UnresolveButton({ shipmentId }: { shipmentId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function reopen() {
    setBusy(true);
    try {
      await fetch(`/api/shipments/${shipmentId}/resolve`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className="btn btn-sm" onClick={reopen} disabled={busy}>
      {busy ? 'Reopening…' : 'Reopen'}
    </button>
  );
}
