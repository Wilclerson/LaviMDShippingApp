/**
 * ShipStation API V2 client.
 *
 * Verified 2026-08-25:
 *  - Base URL:      https://api.shipstation.com
 *  - Auth:          `API-Key: <key>` request header (NOT Basic auth).
 *                   V1 keys — the key/secret pair used against
 *                   ssapi.shipstation.com — are deprecated and do not work
 *                   against V2. .env.example says so explicitly.
 *  - Rate limit:    ~200 requests/minute. Responses carry
 *                   X-Rate-Limit-Limit / -Remaining / -Reset, and a 429 carries
 *                   Retry-After. Both are honoured by the shared http helper
 *                   plus the soft throttle below.
 *  - Pagination:    `page` (1-based) and `page_size`; responses carry
 *                   `total`, `page`, `pages`.
 *
 * Endpoints used:
 *  - GET /v2/labels     — label creation is the event this whole application
 *                         audits, so labels are the primary feed.
 *  - GET /v2/shipments  — enriches a label with customer, order and store.
 *  - GET /v2/stores     — resolves configured store names to ids (best effort).
 */

import { env } from '../env';
import { logger } from '../logger';
import { request, HttpError } from '../http/fetch';

const log = logger.child({ integration: 'shipstation' });

export interface ShipStationPage<T> {
  items: T[];
  page: number;
  pages: number;
  total: number;
}

/**
 * Soft client-side throttle. The documented ceiling is ~200 req/min; we pace
 * well under it so a sync never becomes the reason ShipStation starts 429ing
 * the warehouse's own label printing.
 */
const MIN_REQUEST_INTERVAL_MS = 350;
let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function ssRequest<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  await throttle();

  const url = new URL(`${env.shipstation.baseUrl}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
  }

  const { data, headers } = await request<T>(url.toString(), {
    label: 'shipstation',
    headers: { 'API-Key': env.shipstation.apiKey() },
    timeoutMs: 25_000,
  });

  const remaining = headers.get('x-rate-limit-remaining');
  if (remaining !== null && Number.parseInt(remaining, 10) < 20) {
    log.warn('shipstation rate limit budget low', { remaining });
    // Ease off rather than sprint into a 429.
    await new Promise((r) => setTimeout(r, 1500));
  }

  return data;
}

// --- raw response shapes ------------------------------------------------------
// Typed loosely and read defensively: ShipStation adds fields over time and a
// field rename must degrade to "missing value", never to a sync crash.

export interface RawLabel {
  label_id?: string;
  status?: string;
  shipment_id?: string;
  tracking_number?: string;
  carrier_id?: string;
  carrier_code?: string;
  service_code?: string;
  ship_date?: string;
  created_at?: string;
  voided?: boolean;
  voided_at?: string | null;
  is_return_label?: boolean;
  tracking_status?: string;
  ship_to?: RawAddress;
  [key: string]: unknown;
}

export interface RawAddress {
  name?: string | null;
  company_name?: string | null;
  city_locality?: string | null;
  state_province?: string | null;
  postal_code?: string | null;
  country_code?: string | null;
  [key: string]: unknown;
}

export interface RawShipment {
  shipment_id?: string;
  shipment_number?: string;
  store_id?: string | number;
  external_shipment_id?: string;
  external_order_id?: string;
  order_number?: string;
  order_id?: string;
  sales_order_id?: string;
  shipment_status?: string;
  created_at?: string;
  modified_at?: string;
  ship_date?: string;
  carrier_id?: string;
  service_code?: string;
  ship_to?: RawAddress;
  items?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface RawStore {
  store_id?: string | number;
  name?: string;
  store_name?: string;
  marketplace_name?: string;
  active?: boolean;
  [key: string]: unknown;
}

function readPage<T>(payload: unknown, itemsKey: string): ShipStationPage<T> {
  const obj = (payload ?? {}) as Record<string, unknown>;
  const items = Array.isArray(obj[itemsKey]) ? (obj[itemsKey] as T[]) : [];
  return {
    items,
    page: typeof obj.page === 'number' ? obj.page : 1,
    pages: typeof obj.pages === 'number' ? obj.pages : 1,
    total: typeof obj.total === 'number' ? obj.total : items.length,
  };
}

export interface ListLabelsParams {
  createdAtStart?: Date;
  createdAtEnd?: Date;
  page?: number;
  pageSize?: number;
  labelStatus?: string;
}

export async function listLabels(params: ListLabelsParams): Promise<ShipStationPage<RawLabel>> {
  const payload = await ssRequest<unknown>('/v2/labels', {
    created_at_start: params.createdAtStart?.toISOString(),
    created_at_end: params.createdAtEnd?.toISOString(),
    page: params.page ?? 1,
    page_size: params.pageSize ?? 100,
    label_status: params.labelStatus,
    sort_by: 'created_at',
    sort_dir: 'desc',
  });
  return readPage<RawLabel>(payload, 'labels');
}

export interface ListShipmentsParams {
  storeId?: string;
  createdAtStart?: Date;
  createdAtEnd?: Date;
  modifiedAtStart?: Date;
  page?: number;
  pageSize?: number;
}

export async function listShipments(
  params: ListShipmentsParams,
): Promise<ShipStationPage<RawShipment>> {
  const payload = await ssRequest<unknown>('/v2/shipments', {
    store_id: params.storeId,
    created_at_start: params.createdAtStart?.toISOString(),
    created_at_end: params.createdAtEnd?.toISOString(),
    modified_at_start: params.modifiedAtStart?.toISOString(),
    page: params.page ?? 1,
    page_size: params.pageSize ?? 100,
    sort_by: 'created_at',
    sort_dir: 'desc',
  });
  return readPage<RawShipment>(payload, 'shipments');
}

export async function getShipment(shipmentId: string): Promise<RawShipment | null> {
  try {
    return await ssRequest<RawShipment>(`/v2/shipments/${encodeURIComponent(shipmentId)}`);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Best-effort store listing. ShipStation V2 exposes stores through the sales /
 * orders surface, and the exact path has moved between releases, so several
 * candidates are tried and the first that answers wins. A failure here is not
 * fatal: store filtering falls back to matching on the store name carried on
 * the shipment record.
 */
export async function listStores(): Promise<RawStore[]> {
  const candidates = ['/v2/stores', '/v2/sales/stores', '/v2/connections/stores'];
  for (const path of candidates) {
    try {
      const payload = await ssRequest<unknown>(path);
      if (Array.isArray(payload)) return payload as RawStore[];
      const obj = (payload ?? {}) as Record<string, unknown>;
      for (const key of ['stores', 'items', 'results']) {
        if (Array.isArray(obj[key])) return obj[key] as RawStore[];
      }
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 405)) continue;
      log.warn('store listing attempt failed', { path, error: err });
    }
  }
  log.warn('could not enumerate ShipStation stores; falling back to name matching');
  return [];
}

/** Cheap credential check used by the health endpoint. */
export async function verifyCredentials(): Promise<{ ok: boolean; message: string }> {
  try {
    await listLabels({ pageSize: 1, page: 1 });
    return { ok: true, message: 'ShipStation API key accepted.' };
  } catch (err) {
    const message =
      err instanceof HttpError
        ? err.status === 401 || err.status === 403
          ? 'ShipStation rejected the API key (401/403). Confirm it is a V2 key.'
          : `ShipStation returned ${err.status}.`
        : 'ShipStation unreachable.';
    return { ok: false, message };
  }
}
