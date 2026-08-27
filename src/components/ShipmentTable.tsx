import Link from 'next/link';
import { StatusBadge } from './StatusBadge';
import { formatAge, formatDateTimeShort } from '@/lib/time';
import { STATUS_PRESENTATION } from '@/lib/shipment-normalizer/status';
import { WHOLESALE_SOURCE_LABEL, type ShipmentRow } from '@/lib/types';

/**
 * Rows are tinted only when a human must act.
 *
 * Delivered and In Transit used to carry a green tick each, so a board that is
 * 92% delivered read as a wall of green with the handful of real problems lost
 * inside it. Success is now plain text; colour is reserved for the two states
 * that need somebody.
 */
function rowClass(shipment: ShipmentRow): string {
  if (shipment.manually_resolved) return 'row-resolved';
  const tone = STATUS_PRESENTATION[shipment.normalized_status].tone;
  if (tone === 'critical') return 'row-critical';
  if (tone === 'warning') return 'row-warning';
  return '';
}

function SourceCell({ shipment }: { shipment: ShipmentRow }) {
  if (shipment.source_store === WHOLESALE_SOURCE_LABEL || shipment.source === 'wholesale_danielle') {
    return <span className="pill wholesale">{WHOLESALE_SOURCE_LABEL}</span>;
  }
  return <span className="pill">{shipment.source_store ?? 'ShipStation'}</span>;
}

function orderNumber(shipment: ShipmentRow) {
  // Wholesale and manual labels have no internal order number, by design.
  return shipment.source === 'wholesale_danielle' || !shipment.order_number ? (
    <span className="dash">—</span>
  ) : (
    shipment.order_number
  );
}

function FirstScan({ shipment }: { shipment: ShipmentRow }) {
  if (shipment.first_carrier_scan_at) return <>{formatDateTimeShort(shipment.first_carrier_scan_at)}</>;
  return <span className="no-scan">No scan</span>;
}

export function ShipmentTable({
  shipments,
  now,
  allClear = false,
}: {
  shipments: ShipmentRow[];
  now: Date;
  /** True when the default attention view is legitimately empty. */
  allClear?: boolean;
}) {
  if (shipments.length === 0) {
    // An empty attention list is the best outcome the system can report, not a
    // dead end. It used to show the same "no matches" message as a mistyped
    // search.
    if (allClear) {
      return (
        <div className="empty-state is-clear">
          <div className="big">Nothing needs attention</div>
          <div>Every label has a confirmed UPS possession scan.</div>
        </div>
      );
    }
    return (
      <div className="empty-state">
        <div className="big">No shipments match this view</div>
        <div>Try a different filter, widen the date range, or reset all filters.</div>
      </div>
    );
  }

  return (
    <>
      {/* Wide screens: the full table. */}
      <div className="table-scroll desk-only">
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
              <th>Label Age</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shipments.map((shipment) => (
              <tr key={shipment.id} className={rowClass(shipment)}>
                <td>
                  <div style={{ fontWeight: 500 }}>
                    {shipment.customer_name ?? <span className="dash">—</span>}
                  </div>
                  {shipment.company_name && <div className="subtle">{shipment.company_name}</div>}
                  {(shipment.destination_city || shipment.destination_state) && (
                    <div className="subtle">
                      {[shipment.destination_city, shipment.destination_state]
                        .filter(Boolean)
                        .join(', ')}
                    </div>
                  )}
                </td>
                <td className="nowrap">{orderNumber(shipment)}</td>
                <td>
                  <SourceCell shipment={shipment} />
                </td>
                <td className="mono nowrap">
                  <Link href={`/shipments/${shipment.id}`}>{shipment.tracking_number}</Link>
                </td>
                <td className="nowrap">{formatDateTimeShort(shipment.label_created_at)}</td>
                <td className="nowrap">
                  <FirstScan shipment={shipment} />
                </td>
                <td>
                  {shipment.latest_tracking_event ? (
                    <>
                      <div>{shipment.latest_tracking_event}</div>
                      <div className="subtle">
                        {formatDateTimeShort(shipment.latest_tracking_event_at)}
                      </div>
                    </>
                  ) : (
                    <span className="dash">—</span>
                  )}
                </td>
                <td>
                  <StatusBadge
                    status={shipment.normalized_status}
                    resolved={shipment.manually_resolved}
                  />
                </td>
                <td className="nowrap">{formatAge(shipment.label_created_at, now)}</td>
                <td className="nowrap">
                  <Link href={`/shipments/${shipment.id}`} className="btn btn-sm">
                    View
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Narrow screens: one card per shipment. Ten columns in a sideways
          scroller is unusable on a phone, and dropping columns would hide the
          facts the warehouse needs. */}
      <div className="ship-cards mob-only">
        {shipments.map((shipment) => (
          <Link
            key={shipment.id}
            href={`/shipments/${shipment.id}`}
            className={`ship-card ${rowClass(shipment)}`}
          >
            <div className="ship-card-top">
              <div className="ship-card-name">
                {shipment.customer_name ?? <span className="dash">—</span>}
              </div>
              <StatusBadge
                status={shipment.normalized_status}
                resolved={shipment.manually_resolved}
              />
            </div>
            <div className="ship-card-grid">
              <span className="muted">Order #</span>
              <span>{orderNumber(shipment)}</span>
              <span className="muted">Source</span>
              <span>
                <SourceCell shipment={shipment} />
              </span>
              <span className="muted">Tracking</span>
              <span className="mono">{shipment.tracking_number}</span>
              <span className="muted">Label created</span>
              <span>{formatDateTimeShort(shipment.label_created_at)}</span>
              <span className="muted">Label age</span>
              <span>{formatAge(shipment.label_created_at, now)}</span>
              <span className="muted">First UPS scan</span>
              <span>
                <FirstScan shipment={shipment} />
              </span>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
