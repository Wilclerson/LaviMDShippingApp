import Link from 'next/link';
import { requireUser } from '@/lib/auth/rbac';
import { getDashboardStats, listShipments, isShipmentFilter, type ShipmentFilter } from '@/lib/database/queries';
import { getSyncHealth, getLastSuccessfulSyncAt } from '@/lib/sync/run';
import { AppHeader } from '@/components/AppHeader';
import { ShipmentTable } from '@/components/ShipmentTable';
import { DashboardFilters, SearchAndDateForm } from '@/components/DashboardFilters';
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
  filter,
  active,
  sub,
}: {
  label: string;
  value: number;
  tone: 'critical' | 'warning' | 'success' | 'neutral';
  filter: ShipmentFilter;
  active: boolean;
  sub?: string;
}) {
  return (
    <Link
      href={`/?filter=${filter}`}
      className={`stat-card tone-${tone} ${active ? 'is-active' : ''}`}
    >
      <div className="stat-label">{label}</div>
      <div className={`stat-value tone-${tone}`}>{value}</div>
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

  const search = one('q');
  const fromRaw = one('from');
  const toRaw = one('to');
  const page = Math.max(1, Number.parseInt(one('page') ?? '1', 10) || 1);

  const [stats, listing, syncHealth, lastSyncAt] = await Promise.all([
    getDashboardStats(),
    listShipments({
      filter,
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

  const now = new Date();
  const staleSources = syncHealth.filter((h) => h.stale);
  const failedSources = syncHealth.filter((h) => h.lastStatus === 'failed');
  const totalPages = Math.max(1, Math.ceil(listing.total / PAGE_SIZE));

  const pageHref = (targetPage: number) => {
    const query = new URLSearchParams({ filter });
    if (search) query.set('q', search);
    if (fromRaw) query.set('from', fromRaw);
    if (toRaw) query.set('to', toRaw);
    query.set('page', String(targetPage));
    return `/?${query.toString()}`;
  };

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

        <div className="card-grid">
          <StatCard
            label="Needs Attention"
            value={stats.needsAttention}
            tone={stats.needsAttention > 0 ? 'critical' : 'success'}
            filter="needs_attention"
            active={filter === 'needs_attention'}
            sub={stats.agingLabels > 0 ? `${stats.agingLabels} over 24 hours` : 'All labels scanned'}
          />
          <StatCard
            label="Label Created"
            value={stats.labelCreated + stats.agingLabels}
            tone={stats.labelCreated + stats.agingLabels > 0 ? 'warning' : 'success'}
            filter="label_created"
            active={filter === 'label_created'}
            sub="No UPS possession scan"
          />
          <StatCard
            label="In Transit"
            value={stats.inTransit + stats.confirmedShipped}
            tone="success"
            filter="in_transit"
            active={filter === 'in_transit'}
            sub={`${stats.confirmedShipped} newly confirmed`}
          />
          <StatCard
            label="Delivered"
            value={stats.delivered}
            tone="success"
            filter="delivered"
            active={filter === 'delivered'}
          />
          <StatCard
            label="Total Shipments"
            value={stats.total}
            tone="neutral"
            filter="all"
            active={filter === 'all'}
            sub={`${stats.wholesale} wholesale`}
          />
        </div>

        <div className="panel">
          <div className="panel-header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }}>
            <DashboardFilters active={filter} search={search} from={fromRaw} to={toRaw} />
            <SearchAndDateForm filter={filter} search={search} from={fromRaw} to={toRaw} />
          </div>

          <ShipmentTable shipments={listing.shipments} now={now} />

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
