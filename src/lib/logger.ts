/**
 * Structured JSON logging with hard redaction of credentials.
 *
 * Anything that looks like a secret is scrubbed before it reaches stdout:
 *  - values of any env var listed in SECRET_ENV_NAMES (exact substring match)
 *  - fields whose key matches SENSITIVE_KEY_RE at any depth
 *  - bearer tokens and Basic auth headers inside free-form strings
 */

import { SECRET_ENV_NAMES, env } from './env';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY_RE =
  /(secret|password|passwd|token|api[-_]?key|apikey|authorization|auth|credential|client[-_]?secret|cookie|session)/i;

const REDACTED = '[REDACTED]';

/** Collected once per process; env vars do not change at runtime. */
function secretValues(): string[] {
  const out: string[] = [];
  for (const name of SECRET_ENV_NAMES) {
    const v = process.env[name];
    // Ignore very short values — redacting them would mangle unrelated text.
    if (v && v.trim().length >= 8) out.push(v.trim());
  }
  return out;
}

let cachedSecrets: string[] | null = null;
function getSecrets(): string[] {
  if (cachedSecrets === null) cachedSecrets = secretValues();
  return cachedSecrets;
}

/** Exposed for tests. */
export function resetSecretCache(): void {
  cachedSecrets = null;
}

function scrubString(input: string): string {
  let out = input;
  for (const secret of getSecrets()) {
    if (secret && out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ' + REDACTED);
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: value.stack ? scrubString(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return '[unserialisable]';
}

function emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  const configured = (env.logLevel as LogLevel) in LEVEL_ORDER ? (env.logLevel as LogLevel) : 'info';
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configured]) return;

  const record = {
    level,
    time: new Date().toISOString(),
    msg: scrubString(message),
    ...(context ? { ctx: redact(context) as Record<string, unknown> } : {}),
  };

  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function build(bindings: Record<string, unknown>): Logger {
  const merge = (ctx?: Record<string, unknown>) =>
    Object.keys(bindings).length || ctx ? { ...bindings, ...ctx } : undefined;
  return {
    debug: (m, c) => emit('debug', m, merge(c)),
    info: (m, c) => emit('info', m, merge(c)),
    warn: (m, c) => emit('warn', m, merge(c)),
    error: (m, c) => emit('error', m, merge(c)),
    child: (b) => build({ ...bindings, ...b }),
  };
}

export const logger: Logger = build({});
