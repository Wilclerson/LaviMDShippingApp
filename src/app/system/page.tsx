import { requireUser, can } from '@/lib/auth/rbac';
import { getSyncHealth, getLastSuccessfulSyncAt } from '@/lib/sync/run';
import { getRecentErrors } from '@/lib/database/queries';
import { getRecentDeliveries } from '@/lib/email/daily-report';
import { AppHeader } from '@/components/AppHeader';
import { SyncButton } from '@/components/SyncButton';
import { formatDateTime, DISPLAY_TZ } from '@/lib/time';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

const SOURCE_LABELS: Record<string, string> = {
  shipstation: 'ShipStation',
  ups_quantum_view: 'UPS Quantum View',
  ups_tracking: 'UPS Tracking',
};

function ConfigRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <tr>
      <td style={{ fontWeight: 500 }}>{label}</td>
      <td>
        <span className={`badge tone-${ok ? 'success' : 'critical'}`}>
          {ok ? 'Configured' : 'Not configured'}
        </span>
      </td>
      <td className="muted">{detail}</td>
    </tr>
  );
}

export default async function SystemPage() {
  const user = await requireUser('/system');

  const [health, lastSyncAt, errors, deliveries] = await Promise.all([
    getSyncHealth(),
    getLastSuccessfulSyncAt(),
    getRecentErrors(25),
    getRecentDeliveries(10),
  ]);

  const canTriggerSync = can(user.role, 'sync:trigger');

  return (
    <>
      <AppHeader user={user} lastSyncAt={lastSyncAt} />
      <main className="container">
        <h1 style={{ fontSize: 18, margin: '0 0 16px' }}>System status</h1>

        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-header">
            <h2 className="panel-title">Data synchronisation</h2>
            <div className="header-spacer" />
            {canTriggerSync && <SyncButton />}
          </div>
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Last status</th>
                  <th>Last successful sync</th>
                  <th>Last attempt</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {health.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="muted" style={{ padding: 20 }}>
                      No sync has run yet.
                    </td>
                  </tr>
                ) : (
                  health.map((entry) => (
                    <tr key={entry.source} className={entry.stale ? 'row-critical' : ''}>
                      <td style={{ fontWeight: 500 }}>{SOURCE_LABELS[entry.source] ?? entry.source}</td>
                      <td>
                        <span
                          className={`badge tone-${
                            entry.lastStatus === 'success'
                              ? 'success'
                              : entry.lastStatus === 'partial'
                                ? 'warning'
                                : entry.lastStatus === 'failed'
                                  ? 'critical'
                                  : 'neutral'
                          }`}
                        >
                          {entry.lastStatus ?? 'unknown'}
                        </span>
                        {entry.stale && (
                          <span className="badge tone-critical" style={{ marginLeft: 6 }}>stale</span>
                        )}
                      </td>
                      <td className="nowrap">{formatDateTime(entry.lastSuccessAt)}</td>
                      <td className="nowrap">{formatDateTime(entry.lastAttemptAt)}</td>
                      <td className="muted">{entry.lastErrorMessage ?? '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-header">
            <h2 className="panel-title">Integration configuration</h2>
          </div>
          <div className="table-scroll">
            <table className="data">
              <tbody>
                {/* Only whether a credential is present is shown — never a value. */}
                <ConfigRow
                  label="ShipStation API (V2)"
                  ok={env.shipstation.configured()}
                  detail={
                    env.shipstation.storeIds.length > 0 || env.shipstation.storeNames.length > 0
                      ? `Filtering to ${env.shipstation.storeIds.length + env.shipstation.storeNames.length} configured store(s)`
                      : 'No store filter set — every store will be ingested'
                  }
                />
                <ConfigRow
                  label="UPS OAuth credentials"
                  ok={env.ups.configured()}
                  detail={env.ups.baseUrl}
                />
                <ConfigRow
                  label="UPS Quantum View"
                  ok={env.ups.configured() && env.ups.quantumViewEnabled}
                  detail={
                    !env.ups.quantumViewEnabled
                      ? 'Disabled — wholesale (Danielle) labels will NOT be discovered'
                      : env.ups.quantumViewSubscriptions.length > 0
                        ? `Subscriptions: ${env.ups.quantumViewSubscriptions.join(', ')}`
                        : 'All subscriptions on the account'
                  }
                />
                <ConfigRow
                  label="Email delivery"
                  ok={
                    env.email.recipients.length > 0 &&
                    (env.email.provider === 'console' || Boolean(env.email.apiKey))
                  }
                  detail={`Provider: ${env.email.provider} · ${env.email.recipients.length} recipient(s)`}
                />
                <tr>
                  <td style={{ fontWeight: 500 }}>Display timezone</td>
                  <td><span className="badge tone-neutral">{DISPLAY_TZ}</span></td>
                  <td className="muted">Timestamps are stored in UTC</td>
                </tr>
                <tr>
                  <td style={{ fontWeight: 500 }}>Aging threshold</td>
                  <td><span className="badge tone-neutral">{env.tuning.agingLabelHours} hours</span></td>
                  <td className="muted">Label age before escalation to high priority</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-header">
            <h2 className="panel-title">Morning report deliveries</h2>
          </div>
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Report date</th>
                  <th>Status</th>
                  <th>Sent at</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="muted" style={{ padding: 20 }}>
                      No reports have been sent yet.
                    </td>
                  </tr>
                ) : (
                  deliveries.map((delivery, index) => (
                    <tr key={index}>
                      <td className="nowrap">{delivery.report_date}</td>
                      <td>
                        <span
                          className={`badge tone-${
                            delivery.status === 'sent' ? 'success' : delivery.status === 'skipped' ? 'neutral' : 'critical'
                          }`}
                        >
                          {delivery.status}
                        </span>
                      </td>
                      <td className="nowrap">{formatDateTime(delivery.created_at)}</td>
                      <td className="muted">{delivery.error_message ?? '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2 className="panel-title">Recent errors</h2>
          </div>
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Scope</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {errors.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="muted" style={{ padding: 20 }}>
                      No errors recorded.
                    </td>
                  </tr>
                ) : (
                  errors.map((entry) => (
                    <tr key={entry.id}>
                      <td className="nowrap">{formatDateTime(entry.created_at)}</td>
                      <td><span className="pill">{entry.scope}</span></td>
                      <td>{entry.message}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </>
  );
}
