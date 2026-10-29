import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { createPool, dropSchema, migrate } from '../src/db';
import { createEngine } from '../src/engine';
import { bearerFor, checkConsistency, makeSchema, mkAuction, mkUsers } from './helpers';

const root = path.join(__dirname, '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startServer(schema: string): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: root,
      env: {
        ...process.env,
        PORT: '0',
        DB_SCHEMA: schema,
        SEED: '0',
        DEMO_MODE: '0',
        PAYMENTS_ENABLED: '0',
        NODE_ENV: 'test',
      },
    });
    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error('start timeout ' + out.slice(-2000)));
    }, 30_000);
    const onData = (d: Buffer) => {
      out += d.toString();
      const match = out.match(/"port":(\d+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ proc, port: Number(match[1]) });
      }
    };
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', onData);
    proc.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('server exited ' + code + ' ' + out.slice(-2000)));
      }
    });
  });
}

const kill = (proc: ChildProcess) => new Promise((resolve) => {
  if (proc.exitCode !== null) return resolve(null);
  proc.once('exit', () => resolve(null));
  proc.kill('SIGKILL');
});

test('two processes share Postgres: bids stay consistent, and a restart closes exactly once', { timeout: 90_000 }, async () => {
  const schema = await makeSchema();
  const pool = createPool(schema);
  await migrate(pool);
  const engine = createEngine(pool, { schema });
  const procs: { proc: ChildProcess; port: number }[] = [];
  try {
    const users = await mkUsers(pool, 20);
    for (const u of users) await engine.grant(u, 10, 'test');
    const tokens: string[] = [];
    for (const u of users) tokens.push(await bearerFor(pool, u));
    const id = await mkAuction(pool, Date.now() - 1000, Date.now() + 60_000);
    procs.push(...await Promise.all([startServer(schema), startServer(schema)]));

    const results = await Promise.all(tokens.flatMap((token, i) => [0, 1, 2].map((k) =>
      fetch(`http://127.0.0.1:${procs[(i + k) % 2].port}/api/auctions/${id}/bid`, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'idempotency-key': `b${i}-${k}` },
      }).then((r) => r.json() as Promise<Record<string, unknown>>),
    )));
    const ok = results.filter((r) => r.ok).length;
    assert.ok(ok > 0, JSON.stringify(results.find((r) => !r.ok)));
    await checkConsistency(pool);
    const st = (await pool.query('SELECT * FROM auctions WHERE id = $1', [id])).rows[0];
    assert.equal(st.bid_count, ok);
    assert.equal(st.closed, false);

    await Promise.all(procs.map((p) => kill(p.proc)));
    procs.length = 0;
    assert.equal((await pool.query('SELECT closed FROM auctions WHERE id = $1', [id])).rows[0].closed, false, 'nothing closes while servers are down');
    await pool.query('UPDATE auctions SET end_at = $1 WHERE id = $2', [Date.now() - 1000, id]);
    assert.equal((await pool.query('SELECT closed FROM auctions WHERE id = $1', [id])).rows[0].closed, false);

    procs.push(...await Promise.all([startServer(schema), startServer(schema)]));
    await sleep(800);
    const late = await fetch(`http://127.0.0.1:${procs[0].port}/api/auctions/${id}/bid`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + tokens[0] },
    }).then((r) => r.json() as Promise<Record<string, unknown>>);
    assert.equal(late.error, 'ended');
    await Promise.all(procs.map((p) => kill(p.proc)));
    procs.length = 0;
    procs.push(await startServer(schema));
    await sleep(500);
    await Promise.all(procs.map((p) => kill(p.proc)));
    procs.length = 0;

    const row = (await pool.query('SELECT * FROM auctions WHERE id = $1', [id])).rows[0];
    assert.equal(row.closed, true);
    assert.equal(row.winner_id, st.last_bidder_id);
    assert.equal(row.final_price_cents, ok);
    const events = (await pool.query(`SELECT COUNT(*)::int AS c FROM auction_events WHERE auction_id = $1 AND kind = 'closed'`, [id])).rows[0].c;
    assert.equal(events, 1);
    await checkConsistency(pool);
  } finally {
    for (const p of procs) if (p.proc.exitCode === null) p.proc.kill('SIGKILL');
    await pool.end();
    await dropSchema(schema);
  }
});
