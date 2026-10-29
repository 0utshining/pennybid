import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BidError } from '../src/engine';
import { loadConfig } from '../src/config';
import { bearerFor, bid, checkConsistency, listenApp, makeEngine, mkAuction, mkUsers } from './helpers';

const cfg = loadConfig();
const code = async (fn: () => Promise<unknown>) => {
  try { await fn(); return 'ok'; } catch (err) {
    if (err instanceof BidError) return err.code;
    throw err;
  }
};

test('deadline rules: reset in final 10s, reject at/after deadline, close exactly once', async () => {
  const ctx = await makeEngine(() => t);
  let t = 1_000_000;
  try {
    const [a, b] = await mkUsers(ctx.pool, 2);
    await ctx.engine.grant(a, 10, 'test');
    await ctx.engine.grant(b, 10, 'test');
    const id = await mkAuction(ctx.pool, t - 1000, t + 60_000);
    t += 30_000;
    await ctx.engine.placeBid(id, a, 'k1');
    assert.equal((await ctx.engine.auctionState(id))!.endAt, 1_060_000);
    t = 1_057_000;
    const reset = await ctx.engine.placeBid(id, b, 'k2');
    assert.equal(reset.endAt, t + cfg.resetToMs);
    assert.equal(await code(() => ctx.engine.placeBid(id, b, 'k3')), 'already_leading');
    t = reset.endAt - 1;
    const again = await ctx.engine.placeBid(id, a, 'k4');
    assert.equal(again.endAt, t + 10_000);
    t = again.endAt;
    const before = (await ctx.engine.auctionState(id))!;
    assert.equal(await code(() => ctx.engine.placeBid(id, b, 'k5')), 'ended');
    t += 5000;
    assert.equal(await code(() => ctx.engine.placeBid(id, b, 'k6')), 'ended');
    assert.equal((await ctx.engine.auctionState(id))!.priceCents, before.priceCents);
    assert.deepEqual(await ctx.engine.closeDue(), [id]);
    assert.deepEqual(await ctx.engine.closeDue(), []);
    const { createEngine } = await import('../src/engine');
    const eng2 = createEngine(ctx.pool, { clock: () => t, schema: ctx.schema });
    assert.deepEqual(await eng2.closeDue(), []);
    const row = (await ctx.pool.query('SELECT * FROM auctions WHERE id = $1', [id])).rows[0];
    assert.equal(row.winner_id, a);
    assert.equal(row.final_price_cents, 3);
    assert.equal(row.closed, true);
    assert.equal(row.stock_decremented, true);
    const product = (await ctx.pool.query('SELECT inventory FROM products WHERE id = $1', [row.product_id])).rows[0];
    assert.equal(product.inventory, 4);
    const events = (await ctx.pool.query(`SELECT COUNT(*)::int AS c FROM auction_events WHERE kind = 'closed'`)).rows[0];
    assert.equal(events.c, 1);
    assert.equal(await code(() => ctx.engine.placeBid(id, b, 'k7')), 'ended');
    await checkConsistency(ctx.pool);
  } finally { await ctx.close(); }
});

test('not started, insufficient credits, append-only ledger and bids', async () => {
  const ctx = await makeEngine(() => t);
  let t = 5000;
  try {
    const [a] = await mkUsers(ctx.pool, 1);
    const id = await mkAuction(ctx.pool, 10_000, 100_000);
    await ctx.engine.grant(a, 1, 'test');
    assert.equal(await code(() => ctx.engine.placeBid(id, a, 'x')), 'not_started');
    t = 20_000;
    await ctx.engine.placeBid(id, a, 'y');
    const id2 = await mkAuction(ctx.pool, 0, 100_000);
    assert.equal(await code(() => ctx.engine.placeBid(id2, a, 'z')), 'insufficient');
    assert.equal((await ctx.engine.auctionState(id2))!.bidCount, 0);
    await assert.rejects(() => ctx.pool.query('UPDATE ledger SET delta = 999'), /append-only/);
    await assert.rejects(() => ctx.pool.query('DELETE FROM bids'), /append-only/);
    await checkConsistency(ctx.pool);
  } finally { await ctx.close(); }
});

test('many concurrent bidders on one auction over HTTP keep balances and prices consistent', async () => {
  const app = await listenApp({ closer: true });
  try {
    const users = await mkUsers(app.pool, 60);
    for (const u of users) await app.engine.grant(u, 5, 'test');
    const tokens = [];
    for (const u of users) tokens.push(await bearerFor(app.pool, u));
    const id = await mkAuction(app.pool, Date.now() - 1000, Date.now() + 120_000);
    const results = await Promise.all(tokens.flatMap((token) => Array.from({ length: 8 }, () => bid(app.base, id, token))));
    const ok = results.filter((r) => r.body.ok).length;
    assert.ok(ok > 0);
    const bad = results.find((r) => !r.body.ok && !['already_leading', 'insufficient'].includes(String(r.body.error)));
    assert.equal(bad, undefined, JSON.stringify(bad));
    const { bids: n } = await checkConsistency(app.pool);
    assert.equal(n, ok);
    assert.equal((await app.engine.auctionState(id))!.priceCents, ok);
    const total = (await app.pool.query('SELECT COALESCE(SUM(balance), 0)::int AS s FROM users')).rows[0].s;
    assert.equal(total, 60 * 5 - ok);
  } finally { await app.stop(); }
});

test('double-submitted bids with the same idempotency key charge once', async () => {
  const app = await listenApp({ closer: true });
  try {
    const [u] = await mkUsers(app.pool, 1);
    await app.engine.grant(u, 10, 'test');
    const token = await bearerFor(app.pool, u);
    const id = await mkAuction(app.pool, Date.now() - 1000, Date.now() + 60_000);
    const results = await Promise.all(Array.from({ length: 20 }, () => bid(app.base, id, token, 'tap-123')));
    const bad = results.filter((r) => !(r.status === 200 && r.body.ok));
    assert.deepEqual(bad, []);
    assert.equal(new Set(results.map((r) => r.body.bidId)).size, 1);
    assert.equal(results.filter((r) => !r.body.duplicate).length, 1);
    const again = await bid(app.base, id, token, 'tap-123');
    assert.equal(again.body.bidId, results[0].body.bidId);
    const balance = (await app.pool.query('SELECT balance FROM users WHERE id = $1', [u])).rows[0].balance;
    assert.equal(balance, 9);
    assert.equal((await app.engine.auctionState(id))!.bidCount, 1);
    await checkConsistency(app.pool);
  } finally { await app.stop(); }
});

test('bid arriving after the deadline over HTTP is rejected and the closer records the winner once', async () => {
  const app = await listenApp({ closer: true });
  try {
    const [u, v] = await mkUsers(app.pool, 2);
    await app.engine.grant(u, 5, 'test');
    await app.engine.grant(v, 5, 'test');
    const id = await mkAuction(app.pool, Date.now() - 10_000, Date.now() + 400);
    assert.equal((await bid(app.base, id, await bearerFor(app.pool, u))).body.ok, true);
    await app.pool.query('UPDATE auctions SET end_at = $1 WHERE id = $2', [Date.now() - 1, id]);
    const late = await bid(app.base, id, await bearerFor(app.pool, v));
    assert.equal(late.body.error, 'ended');
    await new Promise((r) => setTimeout(r, 800));
    const row = (await app.pool.query('SELECT * FROM auctions WHERE id = $1', [id])).rows[0];
    assert.equal(row.closed, true);
    assert.equal(row.winner_id, u);
    const events = (await app.pool.query(`SELECT COUNT(*)::int AS c FROM auction_events WHERE auction_id = $1 AND kind = 'closed'`, [id])).rows[0].c;
    assert.equal(events, 1);
    await checkConsistency(app.pool);
  } finally { await app.stop(); }
});
