/**
 * Shared outbound HTTP helper for the ShipStation and UPS clients.
 *
 * Responsibilities:
 *  - timeouts (a hung upstream must not hold a serverless invocation open)
 *  - bounded retry with exponential backoff + jitter on 429/5xx/network errors
 *  - honouring Retry-After
 *  - throwing a typed error carrying status + body so callers can log usefully
 *
 * It deliberately does NOT log request headers — those carry credentials.
 */

import { logger } from '../logger';

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly url: string;
  readonly retryable: boolean;

  constructor(message: string, opts: { status: number; body: string; url: string; retryable: boolean }) {
    super(message);
    this.name = 'HttpError';
    this.status = opts.status;
    this.body = opts.body;
    this.url = opts.url;
    this.retryable = opts.retryable;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  maxRetries?: number;
  /** Label used in logs; never include secrets. */
  label?: string;
  /** Treat these statuses as a normal result rather than an error. */
  acceptStatuses?: number[];
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number.parseInt(retryAfterHeader, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      // Cap so one upstream cannot stall an entire sync run.
      return Math.min(seconds * 1000, 30_000);
    }
  }
  const base = Math.min(1000 * 2 ** attempt, 15_000);
  // Full jitter: avoids a thundering herd when many lookups fail together.
  return Math.floor(Math.random() * base) + 250;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export interface HttpResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

export async function request<T = unknown>(
  url: string,
  options: RequestOptions = {},
): Promise<HttpResponse<T>> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    label = 'http',
    acceptStatuses = [],
  } = options;

  const log = logger.child({ integration: label });
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      const elapsed = Date.now() - startedAt;

      if (response.ok || acceptStatuses.includes(response.status)) {
        let data: T;
        try {
          data = (text ? JSON.parse(text) : null) as T;
        } catch {
          data = text as unknown as T;
        }
        log.debug('request ok', { method, status: response.status, ms: elapsed, path: pathOf(url) });
        return { status: response.status, data, headers: response.headers };
      }

      const retryable = isRetryableStatus(response.status);
      log.warn('request failed', {
        method,
        status: response.status,
        ms: elapsed,
        path: pathOf(url),
        attempt,
        retryable,
        // Bodies from these APIs carry error codes, not credentials, but they
        // still pass through the logger's redaction before being written.
        body: text.slice(0, 500),
      });

      if (!retryable || attempt === maxRetries) {
        throw new HttpError(`${label} responded ${response.status}`, {
          status: response.status,
          body: text.slice(0, 2000),
          url: pathOf(url),
          retryable,
        });
      }

      await sleep(backoffDelay(attempt, response.headers.get('retry-after')));
      continue;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof HttpError) throw err;

      lastError = err;
      const aborted = err instanceof Error && err.name === 'AbortError';
      log.warn('request error', {
        method,
        path: pathOf(url),
        attempt,
        timedOut: aborted,
        error: err,
      });

      if (attempt === maxRetries) break;
      await sleep(backoffDelay(attempt, null));
      continue;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new HttpError(`${label} request failed after ${maxRetries + 1} attempts`, {
    status: 0,
    body: lastError instanceof Error ? lastError.message : String(lastError),
    url: pathOf(url),
    retryable: true,
  });
}

/** Strip query strings from URLs before logging — they can carry identifiers. */
function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('?')[0] ?? url;
  }
}
