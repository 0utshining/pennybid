import crypto from 'crypto';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { Pool } from 'pg';
import { createSchema, createPool, dropSchema, migrate } from '../src/db';
import { createEngine, Engine } from '../src/engine';
import { createUser, newSession } from '../src/auth';
import { Config, loadConfig } from '../src/config';
import { AppCtx, createApp } from '../src/server';

export async function makeSchema(): Promise<string> {
  const schema = 't' + crypto.randomBytes(4).toString('hex');
  await createSchema(schema);
  return schema;
}

export async function makeEngine(clock?: () => number): Promise<{ pool: Pool; engine: Engine; schema: string; close: () => Promise<void> }> {
  const schema = await makeSchema();
  const pool = createPool(schema);
  await migrate(pool);
  const engine = createEngine(pool, { clock, schema, config: loadConfig({ demoMode: false, paymentsEnabled: false }) });
  return {
    pool,
    engine,
    schema,
    async close() {
      await pool.end();
      await dropSchema(schema);
    },
  };
}

export async function listenApp(opts: {
  schema?: string;
  closer?: boolean;
  seed?: boolean;
  config?: Partial<Config>;
  ratePrefix?: string;
  webhookSecret?: string;
} = {}): Promise<AppCtx & { base: string; schema: string; server: Server; stop: (drop?: boolean) => Promise<void> }> {
  const owns = !opts.schema;
  const schema = opts.schema ?? await makeSchema();
  const ctx = await createApp({
    schema,
    seed: opts.seed ?? false,
    closer: opts.closer ?? false,
    dropSchema: false,
    config: { demoMode: false, paymentsEnabled: false, ...(opts.config || {}) },
    ratePrefix: opts.ratePrefix ?? schema,
    webhookSecret: opts.webhookSecret,
  });
  const server = ctx.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    ...ctx,
    base,
    schema,
    server,
    async stop(drop = owns) {
      await new Promise((resolve) => server.close(() => resolve(null)));
      await ctx.close();
      if (drop) await dropSchema(schema);
    },
  };
}

export async function mkProduct(pool: Pool, inventory = 5): Promise<number> {
  const row = await pool.query(
    `INSERT INTO products (name, description, retail_cents, inventory, images, created_at)
     VALUES ('Thing', '', 1000, $1, '[]'::jsonb, $2) RETURNING id`,
    [inventory, Date.now()],
  );
  return row.rows[0].id as number;
}

export async function mkAuction(pool: Pool, start: number, end: number, inventory = 5): Promise<number> {
  const pid = await mkProduct(pool, inventory);
  const row = await pool.query(
    'INSERT INTO auctions (product_id, start_at, end_at, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [pid, start, end, 0],
  );
  return row.rows[0].id as number;
}

export async function mkUsers(pool: Pool, n: number, prefix = 'u'): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(await createUser(pool, `${prefix}${i}@t.test`, `${prefix}${i}`, 'pw1234', { verified: true }));
  }
  return ids;
}

export async function bearerFor(pool: Pool, userId: number): Promise<string> {
  const session = await newSession(pool, userId, loadConfig());
  return session.token;
}

export async function bid(base: string, id: number, token: string, key?: string) {
  const res = await fetch(`${base}/api/auctions/${id}/bid`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      ...(key ? { 'idempotency-key': key } : {}),
    },
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

/** Ledger sums match balances, every bid has one debit, prices step by the increment. */
export async function checkConsistency(pool: Pool, inc = 1, cost = 1): Promise<{ bids: number }> {
  const bad = await pool.query(
    `SELECT u.id FROM users u
       LEFT JOIN (SELECT user_id, SUM(delta) s FROM ledger GROUP BY user_id) l ON l.user_id = u.id
      WHERE u.balance != COALESCE(l.s, 0)`,
  );
  if (bad.rows.length) throw new Error('balance != ledger sum for ' + JSON.stringify(bad.rows));
  const lastRow = await pool.query(
    `SELECT COUNT(*)::int AS c FROM users u
      WHERE u.balance != COALESCE((SELECT balance_after FROM ledger WHERE user_id = u.id ORDER BY id DESC LIMIT 1), 0)`,
  );
  if (lastRow.rows[0].c) throw new Error('balance_after mismatch');
  const bids = (await pool.query('SELECT COUNT(*)::int AS c FROM bids')).rows[0].c as number;
  const debits = (await pool.query(`SELECT COUNT(*)::int AS c, COALESCE(SUM(delta), 0)::int AS s FROM ledger WHERE kind = 'bid'`)).rows[0];
  if (debits.c !== bids || debits.s !== -bids * cost) throw new Error(`bids ${bids} vs debits ${debits.c}/${debits.s}`);
  const auctions = (await pool.query('SELECT * FROM auctions')).rows;
  for (const a of auctions) {
    const prices = (await pool.query('SELECT price_after_cents AS p FROM bids WHERE auction_id = $1 ORDER BY id', [a.id])).rows.map((r) => r.p as number);
    if (prices.length !== a.bid_count) throw new Error('bid_count mismatch on ' + a.id);
    if (a.price_cents !== prices.length * inc) throw new Error('price mismatch on ' + a.id);
    prices.forEach((p, i) => { if (p !== (i + 1) * inc) throw new Error('price sequence broken'); });
  }
  return { bids };
}

export function jar() {
  const map = new Map<string, string>();
  return {
    store(res: Response) {
      const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const cookie of list) {
        const pair = cookie.split(';')[0];
        const i = pair.indexOf('=');
        map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
    header() {
      return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
  };
}

export function csrfFrom(html: string): string {
  const meta = html.match(/name="csrf-token" content="([^"]+)"/);
  if (meta) return meta[1];
  const input = html.match(/name="_csrf" value="([^"]+)"/);
  if (!input) throw new Error('csrf token not found');
  return input[1];
}

export async function login(base: string, email: string, password: string) {
  const cookies = jar();
  const page = await fetch(base + '/login');
  cookies.store(page);
  const html = await page.text();
  const token = csrfFrom(html);
  const res = await fetch(base + '/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookies.header() },
    body: new URLSearchParams({ email, password, _csrf: token, next: '/' }),
  });
  cookies.store(res);
  return { res, cookies, token };
}
