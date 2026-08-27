/**
 * Read queries powering the dashboard, search and the morning email.
 *
 * Every filter value is bound as a parameter — no string interpolation reaches
 * SQL, so a crafted search term cannot alter the query.
 */

import { query, queryOne } from './pool';
import type { ShipmentRow } from '../types';

/** The filter chips exposed in the UI and accepted by the API. */
export const SHIPMENT_FILTERS = [
  'needs_attention',
  'label_created',
  'aging_24h',
  'confirmed_shipped',
  'in_transit',
  'delivered',
  'exception',
  'wholesale',
  'store_retail',
  'store_manual',
  'store_shopify',
  'all',
] as const;

export type ShipmentFilter = (typeof SHIPMENT_FILTERS)[number];

export function isShipmentFilter(value: string): value is ShipmentFilter {
  return (SHIPMENT_FILTERS as readonly string[]).includes(value);
}

export const FILTER_LABELS: Record<ShipmentFilter, string> = {
  needs_attention: 'Needs Attention',
  label_created: 'Awaiting UPS',
  aging_24h: 'Overdue — No UPS Scan',
  confirmed_shipped: 'Confirmed Shipped',
  in_transit: 'In Transit',
  delivered: 'Delivered',
  exception: 'Delivery Problem',
  wholesale: 'Wholesale / Danielle',
  store_retail: 'Lavi MD Retail Website',
  store_manual: 'Lavi MD Manual Orders',
  store_shopify: 'Lavi MD Shopify Store',
  all: 'All Shipments',
};

/**
 * Source is a SEPARATE dimension from status, combined with AND.
 *
 * The two used to share one `filter` parameter, so choosing a store silently
 * discarded the status — the screen offered two filter rows that looked
 * independent and were not. "What needs attention in Retail?" is the question
 * the warehouse actually asks, and it was unaskable.
 */
export const SOURCE_FILTERS = ['all', 'wholesale', 'retail', 'manual', 'shopify'] as const;
export type SourceFilter = (typeof SOURCE_FILTERS)[number];

export function isSourceFilter(value: string): value is SourceFilter {
  return (SOURCE_FILTERS as readonly string[]).includes(value);
}

export const SOURCE_LABELS: Record<SourceFilter, string> = {
  all: 'All sources',
  wholesale: 'Wholesale / Danielle',
  retail: 'Lavi MD Retail Website',
  manual: 'Lavi MD Manual Orders',
  shopify: 'Lavi MD Shopify Store',
};

/** Store filters resolve to the source_store name recorded on the shipment. */
const SOURCE_STORE_NAMES: Partial<Record<SourceFilter, string>> = {
  retail: 'Lavi MD Retail Website',
  manual: 'Lavi MD Manual Orders',
  shopify: 'Lavi MD Shopify Store',
};

/** Store filters match on the ShipStation store name we recorded. */
const STORE_FILTER_NAMES: Partial<Record<ShipmentFilter, string>> = {
  store_retail: 'Lavi MD Retail Website',
  store_manual: 'Lavi MD Manual Orders',
  store_shopify: 'Lavi MD Shopify Store',
};

export interface ShipmentQueryOptions {
  filter?: ShipmentFilter;
  /** Combined with `filter` using AND. */
  source?: SourceFilter;
  search?: string;
  from?: Date;
  to?: Date;
  /** Include shipments an admin has already resolved. Default false. */
  includeResolved?: boolean;
  limit?: number;
  offset?: number;
  sort?: 'label_created_at' | 'age' | 'customer_name' | 'status';
  sortDir?: 'asc' | 'desc';
}

interface WhereClause {
  sql: string;
  params: unknown[];
}

function buildWhere(options: ShipmentQueryOptions): WhereClause {
  const conditions: string[] = [];
  const params: unknown[] = [];

  const filter = options.filter ?? 'needs_attention';

  switch (filter) {
    case 'needs_attention':
      conditions.push(
        `normalized_status IN ('LABEL_CREATED','AGING_LABEL','EXCEPTION') AND manually_resolved = FALSE`,
      );
      break;
    case 'label_created':
      conditions.push(`normalized_status IN ('LABEL_CREATED','AGING_LABEL')`);
      break;
    case 'aging_24h':
      conditions.push(`normalized_status = 'AGING_LABEL'`);
      break;
    case 'confirmed_shipped':
      conditions.push(`normalized_status = 'SHIPPED'`);
      break;
    case 'in_transit':
      // "In Transit" means everything UPS physically holds and has not yet
      // delivered. SHIPPED is the first scan of that same journey, so it
      // belongs here too; `confirmed_shipped` is the narrower chip for it.
      // This mirrors how `label_created` covers LABEL_CREATED + AGING_LABEL.
      conditions.push(`normalized_status IN ('SHIPPED','IN_TRANSIT')`);
      break;
    case 'delivered':
      conditions.push(`normalized_status = 'DELIVERED'`);
      break;
    case 'exception':
      conditions.push(`normalized_status = 'EXCEPTION'`);
      break;
    case 'wholesale':
      // Danielle's labels are purchased THROUGH ShipStation, so their `source`
      // is 'shipstation' and only `source_store` identifies them. Keying on the
      // enum returned nothing at all in production.
      conditions.push(`(source_store = 'Wholesale / Danielle' OR source = 'wholesale_danielle')`);
      break;
    case 'store_retail':
    case 'store_manual':
    case 'store_shopify': {
      params.push(STORE_FILTER_NAMES[filter]);
      conditions.push(`source_store = $${params.length}`);
      break;
    }
    case 'all':
      break;
  }

  // Source is independent of status and ANDs with it.
  const source = options.source ?? 'all';
  if (source === 'wholesale') {
    conditions.push(`source_store = 'Wholesale / Danielle'`);
  } else if (SOURCE_STORE_NAMES[source]) {
    params.push(SOURCE_STORE_NAMES[source]);
    conditions.push(`source_store = $${params.length}`);
  }

  // "Needs attention" already excludes resolved rows; elsewhere it is opt-in.
  if (!options.includeResolved && filter !== 'needs_attention' && filter !== 'all') {
    conditions.push('manually_resolved = FALSE');
  }

  if (options.search) {
    const term = options.search.trim();
    if (term) {
      // Match a tracking number prefix, an order number, or a customer/company
      // name. ILIKE with a trailing wildcard uses the prefix index for
      // tracking numbers and is fast enough for the rest at this data volume.
      params.push(`%${term}%`);
      const like = `$${params.length}`;
      params.push(`${term.replace(/\s+/g, '').toUpperCase()}%`);
      const trackingPrefix = `$${params.length}`;
      conditions.push(
        `(tracking_number LIKE ${trackingPrefix}
          OR customer_name ILIKE ${like}
          OR company_name ILIKE ${like}
          OR order_number ILIKE ${like}
          OR tracking_number ILIKE ${like})`,
      );
    }
  }

  if (options.from) {
    params.push(options.from);
    conditions.push(`label_created_at >= $${params.length}`);
  }
  if (options.to) {
    params.push(options.to);
    conditions.push(`label_created_at <= $${params.length}`);
  }

  return {
    sql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

const SHIPMENT_COLUMNS = `
  id, tracking_number, source, source_store, shipstation_store_id, customer_name,
  company_name, order_number, shipstation_order_id, shipstation_shipment_id,
  shipstation_label_id, shipstation_status, carrier, service, label_created_at,
  ship_date, first_carrier_scan_at, delivered_at, destination_city, destination_state,
  destination_postal_code, destination_country, ups_status, ups_status_code,
  ups_status_type, normalized_status, latest_tracking_event, latest_tracking_event_at,
  exception_type, has_physical_scan, first_seen_at, last_synced_at,
  last_tracking_check_at, manually_resolved, manually_resolved_by,
  manually_resolved_at, resolution_reason, resolution_note, notes,
  created_at, updated_at
`;

const SORT_COLUMNS: Record<NonNullable<ShipmentQueryOptions['sort']>, string> = {
  label_created_at: 'label_created_at',
  // Oldest label first is "most urgent first" for the attention views.
  age: 'label_created_at',
  customer_name: 'customer_name',
  status: 'normalized_status',
};

export interface ShipmentListResult {
  shipments: ShipmentRow[];
  total: number;
}

export async function listShipments(
  options: ShipmentQueryOptions = {},
): Promise<ShipmentListResult> {
  const where = buildWhere(options);
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);

  const sortColumn = SORT_COLUMNS[options.sort ?? 'label_created_at'];
  const sortDir = options.sortDir === 'asc' ? 'ASC' : 'DESC';

  const rows = await query<ShipmentRow>(
    `SELECT ${SHIPMENT_COLUMNS}
       FROM shipments
       ${where.sql}
      ORDER BY ${sortColumn} ${sortDir} NULLS LAST, id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    where.params,
  );

  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM shipments ${where.sql}`,
    where.params,
  );

  return { shipments: rows, total: Number.parseInt(countRow?.count ?? '0', 10) };
}

export interface DashboardStats {
  needsAttention: number;
  /** LABEL_CREATED only (not yet past the aging threshold). */
  labelCreated: number;
  /** LABEL_CREATED + AGING_LABEL — matches the `label_created` filter. */
  labelCreatedTotal: number;
  agingLabels: number;
  /** IN_TRANSIT only. */
  inTransit: number;
  /** SHIPPED + IN_TRANSIT — matches the `in_transit` filter. */
  inTransitTotal: number;
  confirmedShipped: number;
  delivered: number;
  exceptions: number;
  wholesale: number;
  total: number;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  // Every count except `total` excludes manually-resolved shipments, because
  // each card links to a filtered list that excludes them too. A card showing a
  // bigger number than the table it opens is a bug report waiting to happen.
  // `total` is the exception: it links to the "All Shipments" view, which
  // deliberately shows everything, resolved included.
  const row = await queryOne<Record<string, string>>(
    `SELECT
       COUNT(*) FILTER (WHERE normalized_status IN ('LABEL_CREATED','AGING_LABEL','EXCEPTION')
                          AND manually_resolved = FALSE)::text AS needs_attention,
       COUNT(*) FILTER (WHERE normalized_status = 'LABEL_CREATED'
                          AND manually_resolved = FALSE)::text  AS label_created,
       COUNT(*) FILTER (WHERE normalized_status = 'AGING_LABEL'
                          AND manually_resolved = FALSE)::text  AS aging_labels,
       COUNT(*) FILTER (WHERE normalized_status = 'IN_TRANSIT'
                          AND manually_resolved = FALSE)::text  AS in_transit,
       COUNT(*) FILTER (WHERE normalized_status = 'SHIPPED'
                          AND manually_resolved = FALSE)::text  AS confirmed_shipped,
       COUNT(*) FILTER (WHERE normalized_status = 'DELIVERED'
                          AND manually_resolved = FALSE)::text  AS delivered,
       COUNT(*) FILTER (WHERE normalized_status = 'EXCEPTION'
                          AND manually_resolved = FALSE)::text  AS exceptions,
       COUNT(*) FILTER (WHERE normalized_status IN ('LABEL_CREATED','AGING_LABEL')
                          AND manually_resolved = FALSE)::text  AS label_created_total,
       COUNT(*) FILTER (WHERE normalized_status IN ('SHIPPED','IN_TRANSIT')
                          AND manually_resolved = FALSE)::text  AS in_transit_total,
       COUNT(*) FILTER (WHERE (source_store = 'Wholesale / Danielle' OR source = 'wholesale_danielle')
                          AND manually_resolved = FALSE)::text  AS wholesale,
       COUNT(*)::text                                           AS total
     FROM shipments`,
  );

  const n = (key: string) => Number.parseInt(row?.[key] ?? '0', 10);
  return {
    needsAttention: n('needs_attention'),
    labelCreated: n('label_created'),
    labelCreatedTotal: n('label_created_total'),
    agingLabels: n('aging_labels'),
    inTransit: n('in_transit'),
    inTransitTotal: n('in_transit_total'),
    confirmedShipped: n('confirmed_shipped'),
    delivered: n('delivered'),
    exceptions: n('exceptions'),
    wholesale: n('wholesale'),
    total: n('total'),
  };
}

/**
 * Everything the morning email needs, in one pass.
 *
 * Note what is NOT filtered here: unresolved attention items are returned
 * regardless of how old they are. A label created on Monday that UPS never
 * scanned appears again on Tuesday, Wednesday and every morning after, until
 * UPS scans it or an administrator resolves it.
 */
export interface DailyReportData {
  agingLabels: ShipmentRow[];
  labelCreatedRecent: ShipmentRow[];
  exceptions: ShipmentRow[];
  confirmedCount: number;
  deliveredCount: number;
  inTransitCount: number;
  needsAttentionCount: number;
  totalActive: number;
}

export async function getDailyReportData(since: Date): Promise<DailyReportData> {
  const attention = await query<ShipmentRow>(
    `SELECT ${SHIPMENT_COLUMNS}
       FROM shipments
      WHERE manually_resolved = FALSE
        AND normalized_status IN ('LABEL_CREATED','AGING_LABEL','EXCEPTION')
      ORDER BY label_created_at ASC NULLS LAST`,
  );

  const agingLabels = attention.filter((s) => s.normalized_status === 'AGING_LABEL');
  const labelCreatedRecent = attention.filter((s) => s.normalized_status === 'LABEL_CREATED');
  const exceptions = attention.filter((s) => s.normalized_status === 'EXCEPTION');

  // The success summary covers the reporting window only — nobody wants a
  // cumulative count of every package ever shipped.
  const counts = await queryOne<Record<string, string>>(
    `SELECT
       COUNT(*) FILTER (WHERE first_carrier_scan_at >= $1)::text AS confirmed,
       COUNT(*) FILTER (WHERE delivered_at >= $1)::text          AS delivered,
       COUNT(*) FILTER (WHERE normalized_status = 'IN_TRANSIT')::text AS in_transit,
       COUNT(*)::text AS total_active
     FROM shipments
     WHERE manually_resolved = FALSE`,
    [since],
  );

  const n = (key: string) => Number.parseInt(counts?.[key] ?? '0', 10);

  return {
    agingLabels,
    labelCreatedRecent,
    exceptions,
    confirmedCount: n('confirmed'),
    deliveredCount: n('delivered'),
    inTransitCount: n('in_transit'),
    needsAttentionCount: attention.length,
    totalActive: n('total_active'),
  };
}

export async function getShipmentNotes(shipmentId: string) {
  return query<{ id: string; author_name: string; body: string; created_at: Date }>(
    `SELECT id::text, author_name, body, created_at
       FROM shipment_notes
      WHERE shipment_id = $1
      ORDER BY created_at DESC`,
    [shipmentId],
  );
}

export async function getRecentErrors(limit = 20) {
  return query<{ id: string; scope: string; message: string; created_at: Date }>(
    `SELECT id::text, scope, message, created_at
       FROM error_log
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
}
