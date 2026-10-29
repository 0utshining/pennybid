import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { topUpDemoAuctions, DEMO_LIVE_TARGET, DEMO_UPCOMING_TARGET } from '../src/demoTopUp';
import { makeEngine } from './helpers';

async function counts(pool: import('pg').Pool, now: number) {
  const r = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE start_at <= $1 AND end_at > $1 + 1800000)::int AS live,
            COUNT(*) FILTER (WHERE start_at > $1)::int AS upcoming
       FROM auctions WHERE closed = FALSE`, [now]);
  return r.rows[0] as { live: number; upcoming: number };
}

async function addProducts(pool: import('pg').Pool, n: number) {
  for (let i = 0; i < n; i++) {
    await pool.query(`INSERT INTO products (name, description, retail_cents, inventory, images, created_at)
      VALUES ($1, 'demo', 1000, 1, '[]'::jsonb, $2)`, ['P' + i, Date.now()]);
  }
}

test('demo top-up never creates auctions when demo mode is off', async () => {
  const ctx = await makeEngine();
  try {
    await addProducts(ctx.pool, 3);
    const created = await topUpDemoAuctions(ctx.pool, loadConfig({ demoMode: false }));
    assert.equal(created, 0);
    const r = await ctx.pool.query('SELECT COUNT(*)::int AS c FROM auctions');
    assert.equal(r.rows[0].c, 0);
  } finally { await ctx.close(); }
});

test('demo mode tops up long live and upcoming auctions idempotently and across instances', async () => {
  const ctx = await makeEngine();
  try {
    await addProducts(ctx.pool, 3);
    const cfg = loadConfig({ demoMode: true });
    const now = Date.now();
    // Two "instances" race; the advisory lock plus re-counting keeps the total exact.
    await Promise.all([topUpDemoAuctions(ctx.pool, cfg, now), topUpDemoAuctions(ctx.pool, cfg, now)]);
    await topUpDemoAuctions(ctx.pool, cfg, now);
    let c = await counts(ctx.pool, now);
    assert.equal(c.live, DEMO_LIVE_TARGET);
    assert.equal(c.upcoming, DEMO_UPCOMING_TARGET);
    const ends = await ctx.pool.query('SELECT MIN(end_at - $1)::bigint AS m FROM auctions WHERE start_at <= $1', [now]);
    assert.ok(Number(ends.rows[0].m) >= 60 * 60_000, 'live auctions last hours, not minutes');
    // Inventory is restocked so every open auction is backed by stock.
    const inv = await ctx.pool.query(`SELECT bool_and(p.inventory >= (SELECT COUNT(*) FROM auctions a WHERE a.product_id = p.id AND NOT a.closed)) AS ok FROM products p`);
    assert.equal(inv.rows[0].ok, true);
    // Later (e.g. after a wake from sleep) the engine closes ended ones and top-up refills.
    const later = now + 12 * 60 * 60_000;
    await ctx.pool.query('UPDATE auctions SET closed = TRUE, closed_at = $1 WHERE end_at <= $1', [later]);
    await topUpDemoAuctions(ctx.pool, cfg, later);
    c = await counts(ctx.pool, later);
    assert.equal(c.live, DEMO_LIVE_TARGET);
    assert.equal(c.upcoming, DEMO_UPCOMING_TARGET);
  } finally { await ctx.close(); }
});
