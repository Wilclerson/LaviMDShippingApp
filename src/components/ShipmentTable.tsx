import Link from 'next/link';
import { StatusBadge } from './StatusBadge';
import { formatAge, formatDateTimeShort } from '@/lib/time';
import { STATUS_PRESENTATION } from '@/lib/shipment-normalizer/status';
import { WHOLESALE_SOURCE_LABEL, type ShipmentRow } from '@/lib/types';

function rowClass(shipment: ShipmentRow): string {
  if (shipment.manually_resolved) return 'row-resolved';
  const tone = STATUS_PRESENTATION[shipment.normalized_status].tone;
  if (tone === 'critical') return 'row-critical';
  if (tone === 'warning') return 'row-warning';
  return '';
}

function SourceCell({ shipment }: { shipment: ShipmentRow }) {
  if (shipment.source === 'wholesale_danielle') {
    return <span className="pill wholesale">{WHOLESALE_SOURCE_LABEL}</span>;
  }
  return <span className="pill">{shipment.source_store ?? 'ShipStation'}</span>;
}

export function ShipmentTable({
  shipments,
  now,
}: {
  shipments: ShipmentRow[];
  now: Date;
}) {
  if (shipments.length === 0) {
    return (
      <div className="empty-state">
        <div className="big">No shipments match this view</div>
        <div>Try a different filter, or widen the date range.</div>
      </div>
    );
  }

  return (
    <div className="table-scroll">
      <table className="data">
        <thead>
          <tr>
            <th>Customer</th>
            <th>Order #</th>
            <th>Source</th>
            <th>Tracking #</th>
            <th>Label Created</th>
            <th>First UPS Scan</th>
            <th>Latest UPS Scan</th>
            <th>Status</th>
            <th>Age</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {shipments.map((shipment) => (
            <tr key={shipment.id} className={rowClass(shipment)}>
              <td>
                <div style={{ fontWeight: 500 }}>{shipment.customer_name ?? <span className="dash">—</span>}</div>
                {shipment.company_name && <div className="subtle">{shipment.company_name}</div>}
                {(shipment.destination_city || shipment.destination_state) && (
                  <div className="subtle">
                    {[shipment.destination_city, shipment.destination_state].filter(Boolean).join(', ')}
                  </div>
                )}
              </td>

              <td className="nowrap">
                {/* Wholesale shipments have no internal order number, by design. */}
                {shipment.source === 'wholesale_danielle' || !shipment.order_number ? (
                  <span className="dash">—</span>
                ) : (
                  shipment.order_number
                )}
              </td>

              <td><SourceCell shipment={shipment} /></td>

              <td className="mono nowrap">
                <Link href={`/shipments/${shipment.id}`}>{shipment.tracking_number}</Link>
              </td>

              <td className="nowrap">{formatDateTimeShort(shipment.label_created_at)}</td>

              <td className="nowrap">
                {shipment.first_carrier_scan_at ? (
                  formatDateTimeShort(shipment.first_carrier_scan_at)
                ) : (
                  <span style={{ color: 'var(--critical)', fontWeight: 600 }}>No scan</span>
                )}
              </td>

              <td>
                {shipment.latest_tracking_event ? (
                  <>
                    <div>{shipment.latest_tracking_event}</div>
                    <div className="subtle">{formatDateTimeShort(shipment.latest_tracking_event_at)}</div>
                  </>
                ) : (
                  <span className="dash">—</span>
                )}
              </td>

              <td>
                <StatusBadge status={shipment.normalized_status} resolved={shipment.manually_resolved} />
              </td>

              <td className="nowrap">{formatAge(shipment.label_created_at, now)}</td>

              <td className="nowrap">
                <Link href={`/shipments/${shipment.id}`} className="btn btn-sm">View</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
