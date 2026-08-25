/**
 * Centralised environment access.
 *
 * Rules enforced here:
 *  - No credential is ever read outside this module.
 *  - Nothing in here may be imported from a Client Component. Every consumer
 *    lives in a server module (route handler, server component, or script).
 *  - Missing optional integrations degrade gracefully; the dashboard reports
 *    them as "not configured" rather than crashing the app.
 */

function raw(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed === '' ? undefined : trimmed;
}

function str(name: string, fallback: string): string {
  return raw(name) ?? fallback;
}

function required(name: string): string {
  const v = raw(name);
  if (!v) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example for the full list.`,
    );
  }
  return v;
}

function int(name: string, fallback: number): number {
  const v = raw(name);
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = raw(name)?.toLowerCase();
  if (v === undefined) return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

function list(name: string): string[] {
  const v = raw(name);
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const env = {
  appUrl: str('APP_URL', 'https://shipping.lavimd.store').replace(/\/+$/, ''),
  nodeEnv: str('NODE_ENV', 'development'),
  isProduction: str('NODE_ENV', 'development') === 'production',
  logLevel: str('LOG_LEVEL', 'info'),
  displayTimeZone: str('DISPLAY_TIMEZONE', 'America/New_York'),

  database: {
    url: () => required('DATABASE_URL'),
    sslNoVerify: bool('DATABASE_SSL_NO_VERIFY', false),
  },

  session: {
    secret: () => required('SESSION_SECRET'),
  },

  cron: {
    secret: () => required('CRON_SECRET'),
  },

  shipstation: {
    apiKey: () => required('SHIPSTATION_API_KEY'),
    configured: () => Boolean(raw('SHIPSTATION_API_KEY')),
    baseUrl: str('SHIPSTATION_API_BASE_URL', 'https://api.shipstation.com').replace(/\/+$/, ''),
    storeIds: list('SHIPSTATION_STORE_IDS'),
    storeNames: list('SHIPSTATION_STORE_NAMES'),
  },

  ups: {
    clientId: () => required('UPS_CLIENT_ID'),
    clientSecret: () => required('UPS_CLIENT_SECRET'),
    configured: () => Boolean(raw('UPS_CLIENT_ID') && raw('UPS_CLIENT_SECRET')),
    accountNumber: raw('UPS_ACCOUNT_NUMBER') ?? null,
    baseUrl: str('UPS_API_BASE_URL', 'https://onlinetools.ups.com').replace(/\/+$/, ''),
    transactionSrc: str('UPS_TRANSACTION_SRC', 'lavimd-shipping-audit'),
    quantumViewEnabled: bool('UPS_QUANTUM_VIEW_ENABLED', true),
    quantumViewSubscriptions: list('UPS_QUANTUM_VIEW_SUBSCRIPTIONS'),
  },

  email: {
    provider: str('EMAIL_PROVIDER', 'console').toLowerCase(),
    apiKey: raw('EMAIL_PROVIDER_API_KEY') ?? null,
    from: str('EMAIL_FROM', 'shipping-audit@lavimd.store'),
    fromName: str('EMAIL_FROM_NAME', 'Lavi MD Shipping Audit'),
    recipients: list('EMAIL_RECIPIENTS'),
    smtp: {
      host: raw('SMTP_HOST') ?? null,
      port: int('SMTP_PORT', 587),
      user: raw('SMTP_USER') ?? null,
      password: raw('SMTP_PASSWORD') ?? null,
    },
  },

  tuning: {
    agingLabelHours: int('AGING_LABEL_HOURS', 24),
    syncLookbackHours: int('SYNC_LOOKBACK_HOURS', 72),
    trackingRefreshDeliveredDays: int('TRACKING_REFRESH_DELIVERED_DAYS', 7),
    trackingMaxLookupsPerRun: int('TRACKING_MAX_LOOKUPS_PER_RUN', 250),
  },
} as const;

/** Names of secrets that must never appear in logs or API responses. */
export const SECRET_ENV_NAMES = [
  'SESSION_SECRET',
  'CRON_SECRET',
  'DATABASE_URL',
  'SHIPSTATION_API_KEY',
  'UPS_CLIENT_ID',
  'UPS_CLIENT_SECRET',
  'EMAIL_PROVIDER_API_KEY',
  'SMTP_PASSWORD',
] as const;
