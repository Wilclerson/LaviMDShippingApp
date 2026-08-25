'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function NoteForm({ shipmentId }: { shipmentId: string }) {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/shipments/${shipmentId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: trimmed }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload.error ?? 'Could not save the note.');
        return;
      }
      setBody('');
      router.refresh();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 8 }}>
      {error && <div className="form-error" style={{ margin: 0 }}>{error}</div>}
      <textarea
        rows={3}
        value={body}
        maxLength={4000}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Add an internal note…"
        aria-label="Internal note"
      />
      <div>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !body.trim()}>
          {busy ? 'Saving…' : 'Add note'}
        </button>
      </div>
    </form>
  );
}
