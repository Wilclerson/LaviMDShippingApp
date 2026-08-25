/**
 * UPS OAuth 2.0 — client credentials grant.
 *
 * Verified 2026-08-25 against UPS-API/api-documentation
 * (OAuthClientCredentials.yaml):
 *
 *   POST {base}/security/v1/oauth/token
 *   Authorization: Basic base64(client_id:client_secret)
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: grant_type=client_credentials
 *
 *   Response: { access_token, token_type: "Bearer", expires_in: "<seconds>", ... }
 *
 * Production base: https://onlinetools.ups.com
 * CIE/test base:   https://wwwcie.ups.com
 *
 * Tokens are cached in-process and refreshed a minute before expiry. The token
 * itself is never logged.
 */

import { env } from '../env';
import { logger } from '../logger';
import { HttpError } from '../http/fetch';

const log = logger.child({ integration: 'ups-oauth' });

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __upsToken: CachedToken | undefined;
}

/** Refresh this many ms before the token actually expires. */
const EXPIRY_MARGIN_MS = 60_000;

export class UpsAuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'UpsAuthError';
    this.status = status;
  }
}

export async function getAccessToken(forceRefresh = false): Promise<string> {
  const cached = globalThis.__upsToken;
  if (!forceRefresh && cached && cached.expiresAt > Date.now() + EXPIRY_MARGIN_MS) {
    return cached.accessToken;
  }

  const credentials = Buffer.from(
    `${env.ups.clientId()}:${env.ups.clientSecret()}`,
  ).toString('base64');

  const url = `${env.ups.baseUrl}/security/v1/oauth/token`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
      signal: controller.signal,
    });

    const text = await response.text();

    if (!response.ok) {
      // 401/403 here means bad credentials or an app that has not been granted
      // the requested API. Surfaced distinctly so the dashboard can say so.
      log.error('UPS token request rejected', {
        status: response.status,
        body: text.slice(0, 400),
      });
      throw new UpsAuthError(
        response.status === 401 || response.status === 403
          ? 'UPS rejected the client credentials. Check UPS_CLIENT_ID / UPS_CLIENT_SECRET and that the app is subscribed to the required APIs.'
          : `UPS token endpoint returned ${response.status}.`,
        response.status,
      );
    }

    const payload = JSON.parse(text) as { access_token?: string; expires_in?: string | number };
    const accessToken = payload.access_token;
    if (!accessToken) throw new UpsAuthError('UPS token response contained no access_token.', 502);

    // UPS documents expires_in as a string of seconds; tolerate a number too.
    const expiresInSeconds = Number.parseInt(String(payload.expires_in ?? '3600'), 10);
    const ttl = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 3600;

    globalThis.__upsToken = {
      accessToken,
      expiresAt: Date.now() + ttl * 1000,
    };

    log.info('UPS access token obtained', { expiresInSeconds: ttl });
    return accessToken;
  } catch (err) {
    if (err instanceof UpsAuthError) throw err;
    if (err instanceof HttpError) throw new UpsAuthError(err.message, err.status);
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new UpsAuthError(
      aborted ? 'UPS token request timed out.' : 'UPS token request failed.',
      0,
    );
  } finally {
    clearTimeout(timer);
  }
}

export function clearTokenCache(): void {
  globalThis.__upsToken = undefined;
}

/** Standard headers for any authenticated UPS REST call. */
export async function upsAuthHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return {
    Authorization: `Bearer ${token}`,
    // UPS requires a unique transaction id per request and a source label.
    transId: crypto.randomUUID(),
    transactionSrc: env.ups.transactionSrc,
  };
}
