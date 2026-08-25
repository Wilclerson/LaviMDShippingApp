import Link from 'next/link';
import { FILTER_LABELS, type ShipmentFilter } from '@/lib/database/queries';

/**
 * Filters are plain links carrying query parameters rather than client-side
 * state: the view stays shareable, bookmarkable and back-button-correct, and
 * the page keeps working without JavaScript.
 */

const FILTER_GROUPS: { title: string; filters: ShipmentFilter[] }[] = [
  {
    title: 'Status',
    filters: [
      'needs_attention',
      'aging_24h',
      'label_created',
      'exception',
      'confirmed_shipped',
      'in_transit',
      'delivered',
      'all',
    ],
  },
  {
    title: 'Source',
    filters: ['wholesale', 'store_retail', 'store_manual', 'store_shopify'],
  },
];

const TONES: Partial<Record<ShipmentFilter, string>> = {
  needs_attention: 'critical',
  aging_24h: 'critical',
  exception: 'critical',
  label_created: 'warning',
};

function buildHref(
  filter: ShipmentFilter,
  params: { search?: string; from?: string; to?: string },
): string {
  const query = new URLSearchParams({ filter });
  if (params.search) query.set('q', params.search);
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  return `/?${query.toString()}`;
}

export function DashboardFilters({
  active,
  search,
  from,
  to,
}: {
  active: ShipmentFilter;
  search?: string;
  from?: string;
  to?: string;
}) {
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {FILTER_GROUPS.map((group) => (
        <div key={group.title} className="toolbar">
          <span
            className="subtle"
            style={{ minWidth: 52, fontWeight: 600, textTransform: 'uppercase', fontSize: 10.5, letterSpacing: '0.05em' }}
          >
            {group.title}
          </span>
          {group.filters.map((filter) => (
            <Link
              key={filter}
              href={buildHref(filter, { search, from, to })}
              className={[
                'filter-chip',
                TONES[filter] ? `tone-${TONES[filter]}` : '',
                active === filter ? 'is-active' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {FILTER_LABELS[filter]}
            </Link>
          ))}
        </div>
      ))}
    </div>
  );
}

export function SearchAndDateForm({
  filter,
  search,
  from,
  to,
}: {
  filter: ShipmentFilter;
  search?: string;
  from?: string;
  to?: string;
}) {
  return (
    <form method="get" action="/" className="toolbar" style={{ width: '100%' }}>
      <input type="hidden" name="filter" value={filter} />
      <input
        className="search-input"
        type="search"
        name="q"
        defaultValue={search ?? ''}
        placeholder="Search customer, order number or tracking number…"
        aria-label="Search shipments"
      />
      <label className="subtle nowrap" htmlFor="from">Label created</label>
      <input id="from" type="date" name="from" defaultValue={from ?? ''} style={{ width: 150 }} aria-label="From date" />
      <span className="subtle">to</span>
      <input type="date" name="to" defaultValue={to ?? ''} style={{ width: 150 }} aria-label="To date" />
      <button type="submit" className="btn btn-primary">Apply</button>
      {(search || from || to) && (
        <Link href={`/?filter=${filter}`} className="btn">Clear</Link>
      )}
    </form>
  );
}
