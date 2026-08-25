import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logger';
import { getPool } from './pool';

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

export async function runMigrations(): Promise<string[]> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      // Each migration is atomic: either the whole file lands or none of it.
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      newlyApplied.push(file);
      logger.info('migration applied', { file });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('migration failed', { file, error: err });
      throw err;
    } finally {
      client.release();
    }
  }

  if (newlyApplied.length === 0) logger.info('database schema already up to date');
  return newlyApplied;
}
