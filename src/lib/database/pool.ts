import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { env } from '../env';
import { logger } from '../logger';

/**
 * A single pooled connection per process. Next.js dev mode re-evaluates modules
 * on every change, so the pool is stashed on globalThis to avoid leaking
 * connections during development.
 */
declare global {
  // eslint-disable-next-line no-var
  var __lavimdPool: Pool | undefined;
}

function createPool(): Pool {
  const connectionString = env.database.url();
  const needsSsl = /sslmode=require|supabase|neon|render|amazonaws|railway/i.test(connectionString);

  const pool = new Pool({
    connectionString,
    // Serverless functions are short-lived; a small pool avoids exhausting
    // the database's connection limit across many concurrent invocations.
    max: env.isProduction ? 5 : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: needsSsl ? { rejectUnauthorized: !env.database.sslNoVerify } : undefined,
  });

  pool.on('error', (err) => {
    logger.error('postgres idle client error', { error: err });
  });

  return pool;
}

export function getPool(): Pool {
  if (!globalThis.__lavimdPool) globalThis.__lavimdPool = createPool();
  return globalThis.__lavimdPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const started = Date.now();
  try {
    const result = await getPool().query<T>(text, params as unknown[]);
    const elapsed = Date.now() - started;
    if (elapsed > 1000) {
      logger.warn('slow query', { ms: elapsed, sql: text.slice(0, 160) });
    }
    return result.rows;
  } catch (err) {
    // The SQL text is logged, never the parameters — parameters can contain
    // customer data and, in the users table, password hashes.
    logger.error('query failed', { error: err, sql: text.slice(0, 300) });
    throw err;
  }
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Runs `fn` inside a transaction, rolling back on any thrown error. */
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('rollback failed', { error: rollbackErr });
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (globalThis.__lavimdPool) {
    await globalThis.__lavimdPool.end();
    globalThis.__lavimdPool = undefined;
  }
}
