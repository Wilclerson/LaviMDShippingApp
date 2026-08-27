import Link from 'next/link';
import { requireUser } from '@/lib/auth/rbac';
import {
  getDashboardStats,
  listShipments,
  isShipmentFilter,
  isSourceFilter,
  type ShipmentFilter,
  type SourceFilter,
} from '@/lib/database/queries';
import { getSyncHealth, getLastSuccessfulSyncAt } from '@/lib/sync/run';
import { AppHeader } from '@/components/AppHeader';
import { ShipmentTable } from '@/components/ShipmentTable';
import { DashboardFilters, SearchAndDateForm, ActiveView, type ViewState } from '@/components/DashboardFilters';
import { RefreshDataButton } from '@/components/SyncTrigger';
import { can } from '@/lib/auth/rbac';
import { env } from '@/lib/env';
import { formatDateTime } from '@/lib/time';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;

function parseDate(value: string | undefined, endOfDay = false): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function StatCard({
  label,
  value,
  tone,
  href,
  active,
  sub,
  quiet = false,
}: {
  label: string;
  value: number;
  tone: 'critical' | 'warning' | 'success' | 'neutral';
  href: string;
  active: boolean;
  sub?: string;
  /** Context, not a call to action: rendered without colour weight. */
  quiet?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`stat-card tone-${quiet ? 'neutral' : tone} ${quiet ? 'is-quiet' : ''} ${active ? 'is-active' : ''}`}
    >
      <div className="stat-label">{label}</div>
      <div className={`stat-value tone-${quiet ? 'neutral' : tone}`}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </Link>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser('/');
  const params = await searchParams;

  const one = (key: string): string | undefined => {
    const value = params[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };

  // The default view prioritises exceptions, per the operational brief.
  const filterParam = one('filter');
  const filter: ShipmentFilter =
    filterParam && isShipmentFilter(filterParam) ? filterParam : 'needs_attention';

  const sourceParam = one('source');
  const source: SourceFilter = sourceParam && isSourceFilter(sourceParam) ? sourceParam : 'all';

  const search = one('q');
  const fromRaw = one('from');
  const toRaw = one('to');
  const page = Math.max(1, Number.parseInt(one('page') ?? '1', 10) || 1);

  const [stats, listing, syncHealth, lastSyncAt] = await Promise.all([
    getDashboardStats(),
    listShipments({
      filter,
      source,
      search,
      from: parseDate(fromRaw),
      to: parseDate(toRaw, true),
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      sort: filter === 'needs_attention' || filter === 'aging_24h' ? 'age' : 'label_created_at',
      sortDir: filter === 'needs_attention' || filter === 'aging_24h' ? 'asc' : 'desc',
    }),
    getSyncHealth(),
    getLastSuccessfulSyncAt(),
  ]);

  const view: ViewState = { filter, source, search, from: fromRaw, to: toRaw };
  const canRefresh = can(user.role, 'sync:trigger');
  const attentionSort =
    filter === 'needs_attention' || filter === 'aging_24h' || filter === 'label_created';

  const now = new Date();
  const staleSources = syncHealth.filter((h) => h.stale);
  const failedSources = syncHealth.filter((h) => h.lastStatus === 'failed');
  const totalPages = Math.max(1, Math.ceil(listing.total / PAGE_SIZE));

  const pageHref = (targetPage: number) => {
    const query = new URLSearchParams();
    if (filter !== 'needs_attention') query.set('filter', filter);
    if (source !== 'all') query.set('source', source);
    if (search) query.set('q', search);
    if (fromRaw) query.set('from', fromRaw);
    if (toRaw) query.set('to', toRaw);
    query.set('page', String(targetPage));
    return `/?${query.toString()}`;
  };

  const cardHref = (target: ShipmentFilter) =>
    `/?${new URLSearchParams({
      ...(target !== 'needs_attention' ? { filter: target } : {}),
      ...(source !== 'all' ? { source } : {}),
    }).toString()}`;

  return (
    <>
      <AppHeader user={user} lastSyncAt={lastSyncAt} />
      <main className="container">
        {/* Synchronisation warnings: a stale sync means the numbers below
            cannot be trusted, so it is stated loudly rather than hidden. */}
        {(staleSources.length > 0 || failedSources.length > 0) && (
          <div className={`banner ${failedSources.length > 0 ? 'critical' : 'warning'}`}>
            <span>⚠️</span>
            <div>
              <strong>
                {failedSources.length > 0
                  ? 'Data synchronisation is failing.'
                  : 'Data synchronisation is stale.'}
              </strong>{' '}
              {[...new Set([...failedSources, ...staleSources].map((s) => s.source))].join(', ')}{' '}
              — last successful sync{' '}
              {lastSyncAt ? formatDateTime(lastSyncAt) : 'never'}. Shipment statuses below may be out
              of date. <Link href="/system">View sync details →</Link>
            </div>
          </div>
        )}

        {syncHealth.length === 0 && (
          <div className="banner warning">
            <span>⚠️</span>
            <div>
              <strong>No sync has run yet.</strong> Configure the ShipStation and UPS credentials,
              then trigger a sync from the <Link href="/system">System page</Link>.
            </div>
          </div>
        )}

        {/* Context bar: what the data is, and how to make it fresher. Kept out
            of the header so it survives narrow screens, where .header-meta is
            hidden. */}
        <div className="context-bar">
          <div>
            <span className="muted">Last sync: </span>
            {lastSyncAt ? formatDateTime(lastSyncAt) : <span className="muted">never</span>}
          </div>
          <div className="header-spacer" />
          {canRefresh && <RefreshDataButton />}
        </div>

        {/* Triage line: the one number that decides whether anyone acts today. */}
        <div className={`triage ${stats.needsAttention > 0 ? 'is-critical' : 'is-clear'}`}>
          <div className="triage-value">{stats.needsAttention}</div>
          <div>
            <div className="triage-title">
              {stats.needsAttention > 0
                ? `shipment${stats.needsAttention === 1 ? '' : 's'} need attention`
                : 'Nothing needs attention'}
            </div>
            <div className="triage-sub">
              {stats.needsAttention > 0 ? (
                <>
                  {stats.agingLabels} overdue · {stats.exceptions} delivery problem
                  {stats.exceptions === 1 ? '' : 's'} · {stats.labelCreated} awaiting UPS
                </>
              ) : (
                'Every label has a confirmed UPS possession scan.'
              )}
            </div>
          </div>
          <div className="header-spacer" />
          {stats.needsAttention > 0 && filter !== 'needs_attention' && (
            <Link href={cardHref('needs_attention')} className="btn btn-sm">
              Review them
            </Link>
          )}
        </div>

        <div className="card-grid">
          <StatCard
            label="Overdue — No UPS Scan"
            value={stats.agingLabels}
            tone={stats.agingLabels > 0 ? 'critical' : 'success'}
            href={cardHref('aging_24h')}
            active={filter === 'aging_24h'}
            sub="Past its expected hand-over day"
          />
          <StatCard
            label="Delivery Problems"
            value={stats.exceptions}
            tone={stats.exceptions > 0 ? 'critical' : 'success'}
            href={cardHref('exception')}
            active={filter === 'exception'}
            sub="UPS reported an issue"
          />
          <StatCard
            label="Awaiting UPS"
            value={stats.labelCreated}
            tone={stats.labelCreated > 0 ? 'warning' : 'success'}
            href={cardHref('label_created')}
            active={filter === 'label_created'}
            sub="Printed, still within its window"
          />
          <StatCard
            label="In Transit"
            value={stats.inTransitTotal}
            tone="neutral"
            href={cardHref('in_transit')}
            active={filter === 'in_transit'}
            quiet
          />
        </div>

        {/* Outcomes, not actions: deliberately quiet. */}
        <div className="context-cards">
          <Link href={cardHref('delivered')} className="context-card">
            <span className="muted">Delivered</span> <strong>{stats.delivered}</strong>
          </Link>
          <Link href={cardHref('all')} className="context-card">
            <span className="muted">Total shipments</span> <strong>{stats.total}</strong>
          </Link>
          <span className="context-card is-note">
            Cards overlap and Total includes resolved shipments — they are not meant to sum.
          </span>
        </div>

        <div className="panel">
          <div className="panel-header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }}>
            <DashboardFilters state={view} />
            <SearchAndDateForm state={view} />
          </div>

          <ActiveView
            state={view}
            total={listing.total}
            sortNote={attentionSort ? 'oldest label first' : 'newest label first'}
          />

          <ShipmentTable
            shipments={listing.shipments}
            now={now}
            allClear={filter === 'needs_attention' && listing.total === 0}
          />

          {listing.total > PAGE_SIZE && (
            <div className="pagination">
              <span className="muted">
                Showing {(page - 1) * PAGE_SIZE + 1}–
                {Math.min(page * PAGE_SIZE, listing.total)} of {listing.total}
              </span>
              <span className="toolbar">
                {page > 1 && <Link href={pageHref(page - 1)} className="btn btn-sm">← Previous</Link>}
                {page < totalPages && <Link href={pageHref(page + 1)} className="btn btn-sm">Next →</Link>}
              </span>
            </div>
          )}
        </div>

        <p className="subtle" style={{ marginTop: 16, maxWidth: 760 }}>
          A shipping label being created does not mean the package shipped. A shipment is only
          reported as confirmed once UPS records a physical possession scan. Times are shown in{' '}
          {env.displayTimeZone.replace('_', ' ')}.
        </p>
      </main>
    </>
  );
}
