import Link from 'next/link';
import {
  FILTER_LABELS,
  SOURCE_LABELS,
  type ShipmentFilter,
  type SourceFilter,
} from '@/lib/database/queries';

/**
 * Filters are plain links carrying query parameters rather than client-side
 * state: the view stays shareable, bookmarkable and back-button-correct, and
 * the page keeps working without JavaScript.
 *
 * Status and source are SEPARATE parameters that combine. They used to share
 * one, so picking a store silently threw away the status — two rows that looked
 * independent and were not.
 */

export interface ViewState {
  filter: ShipmentFilter;
  source: SourceFilter;
  search?: string;
  from?: string;
  to?: string;
}

const DEFAULT_FILTER: ShipmentFilter = 'needs_attention';

/** The status refinements that have no stat card of their own. */
const STATUS_CHIPS: ShipmentFilter[] = [
  'aging_24h',
  'exception',
  'label_created',
  'confirmed_shipped',
  'all',
];

const SOURCE_CHIPS: SourceFilter[] = ['all', 'retail', 'manual', 'shopify', 'wholesale'];

const TONES: Partial<Record<ShipmentFilter, string>> = {
  needs_attention: 'critical',
  aging_24h: 'critical',
  exception: 'critical',
  label_created: 'warning',
};

export function buildHref(state: Partial<ViewState>): string {
  const query = new URLSearchParams();
  if (state.filter && state.filter !== DEFAULT_FILTER) query.set('filter', state.filter);
  if (state.source && state.source !== 'all') query.set('source', state.source);
  if (state.search) query.set('q', state.search);
  if (state.from) query.set('from', state.from);
  if (state.to) query.set('to', state.to);
  const qs = query.toString();
  return qs ? `/?${qs}` : '/';
}

/** True when anything at all is narrowing the view. */
export function isFiltered(state: ViewState): boolean {
  return (
    state.filter !== DEFAULT_FILTER ||
    state.source !== 'all' ||
    Boolean(state.search) ||
    Boolean(state.from) ||
    Boolean(state.to)
  );
}

export function DashboardFilters({ state }: { state: ViewState }) {
  return (
    <div className="filter-rows">
      <div className="filter-row">
        <span className="filter-row-label">Status</span>
        {STATUS_CHIPS.map((filter) => (
          <Link
            key={filter}
            href={buildHref({ ...state, filter })}
            className={[
              'filter-chip',
              TONES[filter] ? `tone-${TONES[filter]}` : '',
              state.filter === filter ? 'is-active' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {FILTER_LABELS[filter]}
          </Link>
        ))}
      </div>

      <div className="filter-row">
        <span className="filter-row-label">Source</span>
        {SOURCE_CHIPS.map((source) => (
          <Link
            key={source}
            href={buildHref({ ...state, source })}
            className={`filter-chip ${state.source === source ? 'is-active' : ''}`}
          >
            {SOURCE_LABELS[source]}
          </Link>
        ))}
      </div>
    </div>
  );
}

/** Quick ranges cover the questions asked daily; the pickers cover the rest. */
function quickRanges(): { label: string; from: string; to: string }[] {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const shift = (days: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - days);
    return d;
  };
  return [
    { label: 'Today', from: iso(today), to: iso(today) },
    { label: 'Last 7 days', from: iso(shift(6)), to: iso(today) },
    { label: 'Last 30 days', from: iso(shift(29)), to: iso(today) },
  ];
}

export function SearchAndDateForm({ state }: { state: ViewState }) {
  const ranges = quickRanges();
  return (
    <div className="search-block">
      <form method="get" action="/" className="toolbar" style={{ width: '100%' }}>
        {state.filter !== DEFAULT_FILTER && (
          <input type="hidden" name="filter" value={state.filter} />
        )}
        {state.source !== 'all' && <input type="hidden" name="source" value={state.source} />}
        <input
          className="search-input"
          type="search"
          name="q"
          defaultValue={state.search ?? ''}
          placeholder="Search customer, order number or tracking number…"
          aria-label="Search shipments"
        />
        <label className="subtle nowrap" htmlFor="from">
          Label created
        </label>
        <input
          id="from"
          type="date"
          name="from"
          defaultValue={state.from ?? ''}
          style={{ width: 148 }}
          aria-label="From date"
        />
        <span className="subtle">to</span>
        <input
          type="date"
          name="to"
          defaultValue={state.to ?? ''}
          style={{ width: 148 }}
          aria-label="To date"
        />
        <button type="submit" className="btn btn-primary">
          Apply
        </button>
      </form>

      <div className="toolbar" style={{ marginTop: 8 }}>
        <span className="filter-row-label">Quick range</span>
        {ranges.map((range) => (
          <Link
            key={range.label}
            href={buildHref({ ...state, from: range.from, to: range.to })}
            className={`filter-chip ${state.from === range.from && state.to === range.to ? 'is-active' : ''}`}
          >
            {range.label}
          </Link>
        ))}
        {(state.from || state.to) && (
          <Link href={buildHref({ ...state, from: undefined, to: undefined })} className="filter-chip">
            Any date
          </Link>
        )}
      </div>
    </div>
  );
}

/**
 * What the current view is actually showing, with every narrowing shown as a
 * removable token. Previously the only clue was which chip was dark, and the
 * "Clear" link kept the status filter — so there was no single way back.
 */
export function ActiveView({
  state,
  total,
  sortNote,
}: {
  state: ViewState;
  total: number;
  sortNote: string;
}) {
  const tokens: { label: string; href: string }[] = [];
  if (state.filter !== DEFAULT_FILTER) {
    tokens.push({ label: FILTER_LABELS[state.filter], href: buildHref({ ...state, filter: DEFAULT_FILTER }) });
  }
  if (state.source !== 'all') {
    tokens.push({ label: SOURCE_LABELS[state.source], href: buildHref({ ...state, source: 'all' }) });
  }
  if (state.search) {
    tokens.push({ label: `“${state.search}”`, href: buildHref({ ...state, search: undefined }) });
  }
  if (state.from || state.to) {
    tokens.push({
      label: `${state.from ?? 'any'} → ${state.to ?? 'today'}`,
      href: buildHref({ ...state, from: undefined, to: undefined }),
    });
  }

  return (
    <div className="active-view">
      <div>
        <span className="active-view-title">{FILTER_LABELS[state.filter]}</span>
        <span className="muted">
          {' · '}
          {total} shipment{total === 1 ? '' : 's'}
          {' · '}
          {sortNote}
        </span>
      </div>
      <div className="header-spacer" />
      <div className="toolbar">
        {tokens.map((token) => (
          <Link key={token.label} href={token.href} className="token" title="Remove this filter">
            {token.label} <span aria-hidden>✕</span>
          </Link>
        ))}
        {isFiltered(state) && (
          <Link href="/" className="btn btn-sm">
            Reset all
          </Link>
        )}
      </div>
    </div>
  );
}
