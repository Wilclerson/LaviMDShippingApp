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

/**
 * Every value is a getter, so the environment is read at the point of use
 * rather than frozen at import time. Module import order then cannot change
 * what the app sees, and tests can set a variable before exercising a code
 * path. Credentials stay behind explicit functions so that reading one is
 * always a deliberate act.
 */
export const env = {
  get appUrl() {
    return str('APP_URL', 'https://shipping.lavimd.store').replace(/\/+$/, '');
  },
  get nodeEnv() {
    return str('NODE_ENV', 'development');
  },
  get isProduction() {
    return str('NODE_ENV', 'development') === 'production';
  },
  get logLevel() {
    return str('LOG_LEVEL', 'info');
  },
  get displayTimeZone() {
    return str('DISPLAY_TIMEZONE', 'America/New_York');
  },

  database: {
    url: () => required('DATABASE_URL'),
    get sslNoVerify() {
      return bool('DATABASE_SSL_NO_VERIFY', false);
    },
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
    get baseUrl() {
      return str('SHIPSTATION_API_BASE_URL', 'https://api.shipstation.com').replace(/\/+$/, '');
    },
    get storeIds() {
      return list('SHIPSTATION_STORE_IDS');
    },
    get storeNames() {
      return list('SHIPSTATION_STORE_NAMES');
    },
  },

  ups: {
    clientId: () => required('UPS_CLIENT_ID'),
    clientSecret: () => required('UPS_CLIENT_SECRET'),
    configured: () => Boolean(raw('UPS_CLIENT_ID') && raw('UPS_CLIENT_SECRET')),
    get accountNumber() {
      return raw('UPS_ACCOUNT_NUMBER') ?? null;
    },
    get baseUrl() {
      return str('UPS_API_BASE_URL', 'https://onlinetools.ups.com').replace(/\/+$/, '');
    },
    get transactionSrc() {
      return str('UPS_TRANSACTION_SRC', 'lavimd-shipping-audit');
    },
    get quantumViewEnabled() {
      return bool('UPS_QUANTUM_VIEW_ENABLED', true);
    },
    get quantumViewSubscriptions() {
      return list('UPS_QUANTUM_VIEW_SUBSCRIPTIONS');
    },
  },

  email: {
    get provider() {
      return str('EMAIL_PROVIDER', 'console').toLowerCase();
    },
    get apiKey() {
      return raw('EMAIL_PROVIDER_API_KEY') ?? null;
    },
    get from() {
      return str('EMAIL_FROM', 'shipping-audit@lavimd.store');
    },
    get fromName() {
      return str('EMAIL_FROM_NAME', 'Lavi MD Shipping Audit');
    },
    get recipients() {
      return list('EMAIL_RECIPIENTS');
    },
    smtp: {
      get host() {
        return raw('SMTP_HOST') ?? null;
      },
      get port() {
        return int('SMTP_PORT', 587);
      },
      get user() {
        return raw('SMTP_USER') ?? null;
      },
      get password() {
        return raw('SMTP_PASSWORD') ?? null;
      },
    },
  },

  tuning: {
    get agingLabelHours() {
      return int('AGING_LABEL_HOURS', 24);
    },
    get syncLookbackHours() {
      return int('SYNC_LOOKBACK_HOURS', 72);
    },
    get trackingRefreshDeliveredDays() {
      return int('TRACKING_REFRESH_DELIVERED_DAYS', 7);
    },
    get trackingMaxLookupsPerRun() {
      return int('TRACKING_MAX_LOOKUPS_PER_RUN', 250);
    },
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
