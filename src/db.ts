import fs from 'fs';
import path from 'path';
import { Pool, PoolClient, types } from 'pg';
import { log } from './logger';

// int8 (counts, SUM, epoch millis stored as bigint) → number. Values stay under 2^53.
types.setTypeParser(20, (val) => Number(val));

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

export function assertSchema(schema: string): string {
  if (!SCHEMA_RE.test(schema)) throw new Error('invalid schema name');
  return schema;
}

export function sslOption(): false | { rejectUnauthorized: boolean } {
  return process.env.DATABASE_SSL === '1' ? { rejectUnauthorized: false } : false;
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  return url;
}

export async function withAdmin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: databaseUrl(), max: 1, ssl: sslOption() });
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
}

export async function createSchema(schema: string): Promise<void> {
  assertSchema(schema);
  if (schema === 'public') return;
  await withAdmin(async (c) => {
    await c.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  });
}

export async function dropSchema(schema: string): Promise<void> {
  assertSchema(schema);
  if (schema === 'public') throw new Error('refusing to drop public');
  await withAdmin(async (c) => {
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  });
}

export function createPool(schema: string): Pool {
  assertSchema(schema);
  const pool = new Pool({
    connectionString: databaseUrl(),
    max: 20,
    ssl: sslOption(),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    options: `-c search_path=${schema}`,
  });
  pool.on('error', (err) => log('error', 'pg pool error', { err: err.message }));
  return pool;
}

export async function waitForDb(pool: Pool, tries = 30): Promise<void> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('database unavailable: ' + String(last));
}

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const dir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const seen = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [file]);
      if (seen.rowCount) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log('info', 'migration applied', { file });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
    throw err;
  } finally {
    client.release();
  }
}
