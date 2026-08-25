import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/rbac';
import { can } from '@/lib/auth/rbac';
import { getShipmentById, getShipmentEvents, getStatusHistory } from '@/lib/database/shipments';
import { getShipmentNotes } from '@/lib/database/queries';
import { getAuditTrail } from '@/lib/database/mutations';
import { getLastSuccessfulSyncAt } from '@/lib/sync/run';
import { AppHeader } from '@/components/AppHeader';
import { StatusBadge } from '@/components/StatusBadge';
import { ResolveForm, UnresolveButton } from '@/components/ResolveForm';
import { NoteForm } from '@/components/NoteForm';
import { formatAge, formatDateTime } from '@/lib/time';
import { STATUS_PRESENTATION } from '@/lib/shipment-normalizer/status';
import { WHOLESALE_SOURCE_LABEL } from '@/lib/types';

export const dynamic = 'force-dynamic';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="field-label">{label}</div>
      <div className="field-value">{children}</div>
    </div>
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ShipmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser(`/shipments/${id}`);

  // Reject anything that is not a UUID before it reaches the database.
  if (!UUID_RE.test(id)) notFound();

  const shipment = await getShipmentById(id);
  if (!shipment) notFound();

  const [events, notes, statusHistory, auditTrail, lastSyncAt] = await Promise.all([
    getShipmentEvents(id),
    getShipmentNotes(id),
    getStatusHistory(id),
    getAuditTrail(id),
    getLastSuccessfulSyncAt(),
  ]);

  const now = new Date();
  const presentation = STATUS_PRESENTATION[shipment.normalized_status];
  const isWholesale = shipment.source === 'wholesale_danielle';
  const canResolve = can(user.role, 'shipments:resolve');

  return (
    <>
      <AppHeader user={user} lastSyncAt={lastSyncAt} />
      <main className="container">
        <p style={{ margin: '0 0 12px', fontSize: 13 }}>
          <Link href="/">← Back to dashboard</Link>
        </p>

        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-header">
            <div>
              <h1 style={{ margin: 0, fontSize: 18 }}>
                {shipment.customer_name ?? 'Unknown recipient'}
              </h1>
              <div className="mono muted" style={{ marginTop: 2 }}>{shipment.tracking_number}</div>
            </div>
            <div className="header-spacer" />
            <StatusBadge status={shipment.normalized_status} resolved={shipment.manually_resolved} />
          </div>

          <div className="panel-body">
            {/* The headline judgement, stated plainly. */}
            <div
              className={`banner ${
                presentation.tone === 'critical'
                  ? 'critical'
                  : presentation.tone === 'warning'
                    ? 'warning'
                    : 'success'
              }`}
              style={{ marginBottom: 18 }}
            >
              <div>
                <strong>{presentation.display}</strong>
                <div style={{ marginTop: 3 }}>{presentation.description}</div>
              </div>
            </div>

            <div className="field-grid">
              <Field label="Customer">{shipment.customer_name ?? <span className="dash">—</span>}</Field>
              {shipment.company_name && <Field label="Company">{shipment.company_name}</Field>}
              <Field label="Order number">
                {isWholesale || !shipment.order_number ? (
                  <span className="dash">—</span>
                ) : (
                  shipment.order_number
                )}
              </Field>
              <Field label="Source">
                {isWholesale ? (
                  <span className="pill wholesale">{WHOLESALE_SOURCE_LABEL}</span>
                ) : (
                  <span className="pill">{shipment.source_store ?? 'ShipStation'}</span>
                )}
              </Field>
              <Field label="Tracking number">
                <span className="mono">{shipment.tracking_number}</span>
              </Field>
              <Field label="Carrier / service">
                {[shipment.carrier, shipment.service].filter(Boolean).join(' · ') || <span className="dash">—</span>}
              </Field>

              <Field label="Label created">
                {formatDateTime(shipment.label_created_at)}
                {shipment.label_created_at && (
                  <div className="subtle">{formatAge(shipment.label_created_at, now)} ago</div>
                )}
              </Field>

              <Field label="First UPS possession scan">
                {shipment.first_carrier_scan_at ? (
                  <>
                    {formatDateTime(shipment.first_carrier_scan_at)}
                    <div className="subtle" style={{ color: 'var(--success)' }}>
                      Package physically left the facility
                    </div>
                  </>
                ) : (
                  <span style={{ color: 'var(--critical)', fontWeight: 600 }}>
                    No physical scan recorded
                  </span>
                )}
              </Field>

              <Field label="Latest UPS status">
                {shipment.ups_status ?? shipment.latest_tracking_event ?? <span className="dash">—</span>}
                {shipment.latest_tracking_event_at && (
                  <div className="subtle">{formatDateTime(shipment.latest_tracking_event_at)}</div>
                )}
              </Field>

              <Field label="Delivery">
                {shipment.delivered_at ? (
                  formatDateTime(shipment.delivered_at)
                ) : (
                  <span className="dash">Not delivered</span>
                )}
              </Field>

              <Field label="Destination">
                {[shipment.destination_city, shipment.destination_state, shipment.destination_postal_code]
                  .filter(Boolean)
                  .join(', ') || <span className="dash">—</span>}
              </Field>

              <Field label="Ship date">{shipment.ship_date ?? <span className="dash">—</span>}</Field>
              <Field label="First seen">{formatDateTime(shipment.first_seen_at)}</Field>
              <Field label="Last synced">{formatDateTime(shipment.last_synced_at)}</Field>

              {shipment.shipstation_order_id && (
                <Field label="ShipStation order ID">
                  <span className="mono">{shipment.shipstation_order_id}</span>
                </Field>
              )}
              {shipment.shipstation_shipment_id && (
                <Field label="ShipStation shipment ID">
                  <span className="mono">{shipment.shipstation_shipment_id}</span>
                </Field>
              )}
              {shipment.shipstation_status && (
                <Field label="ShipStation status">{shipment.shipstation_status}</Field>
              )}
              {shipment.exception_type && (
                <Field label="Exception">
                  <span style={{ color: 'var(--critical)' }}>{shipment.exception_type}</span>
                </Field>
              )}
            </div>

            {shipment.manually_resolved && (
              <div className="banner success" style={{ marginTop: 18, marginBottom: 0 }}>
                <div>
                  <strong>Manually resolved.</strong> {shipment.resolution_reason}
                  {shipment.resolution_note ? ` — ${shipment.resolution_note}` : ''}
                  <div className="subtle" style={{ marginTop: 3 }}>
                    {formatDateTime(shipment.manually_resolved_at)}
                  </div>
                </div>
                <div className="header-spacer" />
                {canResolve && <UnresolveButton shipmentId={shipment.id} />}
              </div>
            )}
          </div>
        </div>

        <div className="detail-grid">
          <div className="panel">
            <div className="panel-header">
              <h2 className="panel-title">Carrier tracking timeline</h2>
              <div className="header-spacer" />
              <span className="subtle">{events.length} event{events.length === 1 ? '' : 's'}</span>
            </div>
            <div className="panel-body">
              {events.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  UPS has not reported any activity for this tracking number yet.
                </p>
              ) : (
                <ul className="timeline">
                  {events.map((event) => (
                    <li key={event.id} className={event.is_physical_scan ? 'physical' : 'logical'}>
                      <div className="timeline-desc">{event.description}</div>
                      <div className="timeline-time">
                        {formatDateTime(event.occurred_at)}
                        {(event.location_city || event.location_state) && (
                          <> · {[event.location_city, event.location_state].filter(Boolean).join(', ')}</>
                        )}
                      </div>
                      <div className="subtle">
                        {event.is_physical_scan ? (
                          <span style={{ color: 'var(--success)' }}>Physical possession scan</span>
                        ) : (
                          <span style={{ color: 'var(--warning)' }}>Label / system event — not possession</span>
                        )}
                        {event.status_code && <> · code {event.status_code}</>}
                        {' · '}
                        {event.event_source === 'ups_quantum_view' ? 'Quantum View' : 'UPS Tracking'}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div style={{ display: 'grid', gap: 16 }}>
            {canResolve && !shipment.manually_resolved && (
              <div className="panel">
                <div className="panel-header">
                  <h2 className="panel-title">Manual resolution</h2>
                </div>
                <div className="panel-body">
                  <ResolveForm shipmentId={shipment.id} />
                </div>
              </div>
            )}

            <div className="panel">
              <div className="panel-header">
                <h2 className="panel-title">Internal notes</h2>
              </div>
              <div className="panel-body" style={{ display: 'grid', gap: 14 }}>
                <NoteForm shipmentId={shipment.id} />
                {notes.length === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>No notes yet.</p>
                ) : (
                  <div style={{ display: 'grid', gap: 12 }}>
                    {notes.map((note) => (
                      <div key={note.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                        <div style={{ whiteSpace: 'pre-wrap' }}>{note.body}</div>
                        <div className="subtle" style={{ marginTop: 3 }}>
                          {note.author_name} · {formatDateTime(note.created_at)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {statusHistory.length > 0 && (
              <div className="panel">
                <div className="panel-header">
                  <h2 className="panel-title">Status history</h2>
                </div>
                <div className="panel-body">
                  <ul className="timeline">
                    {statusHistory.map((entry, index) => (
                      <li key={index}>
                        <div className="timeline-desc">
                          {entry.from_status ? `${entry.from_status} → ` : ''}
                          {entry.to_status}
                        </div>
                        <div className="timeline-time">{formatDateTime(entry.changed_at)}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {auditTrail.length > 0 && (
              <div className="panel">
                <div className="panel-header">
                  <h2 className="panel-title">Audit trail</h2>
                </div>
                <div className="panel-body">
                  <ul className="timeline">
                    {auditTrail.map((entry) => (
                      <li key={entry.id}>
                        <div className="timeline-desc">{entry.action}</div>
                        <div className="timeline-time">
                          {entry.actor_email ?? 'system'} · {formatDateTime(entry.created_at)}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
