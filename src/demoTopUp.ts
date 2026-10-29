import { Pool } from 'pg';
import { Config } from './config';
import { log } from './logger';

// Demo mode only: keep a few long-running live auctions and a couple of upcoming ones so a
// hosted demo is always testable, including after the host wakes from sleep. Only INSERTs
// new auction rows (and restocks demo products); it never touches bids, the ledger, or
// closed auctions, so append-only and exactly-once close guarantees are unaffected.
export const DEMO_TOPUP_LOCK = 874522;
export const DEMO_LIVE_TARGET = 4;
export const DEMO_UPCOMING_TARGET = 2;
const HOUR = 60 * 60_000;
// Live auctions ending sooner than this don't count toward the target (seeded short ones).
const LONG_ENOUGH_MS = 30 * 60_000;

export async function topUpDemoAuctions(pool: Pool, cfg: Config, now: number = Date.now()): Promise<number> {
  if (!cfg.demoMode) return 0;
  const client = await pool.connect();
  let created = 0;
  try {
    const got = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [DEMO_TOPUP_LOCK]);
    if (!got.rows[0].ok) return 0; // another instance is topping up
    try {
      await client.query('BEGIN');
      const live = await client.query(
        'SELECT COUNT(*)::int AS c FROM auctions WHERE closed = FALSE AND start_at <= $1 AND end_at > $2',
        [now, now + LONG_ENOUGH_MS],
      );
      const upcoming = await client.query(
        'SELECT COUNT(*)::int AS c FROM auctions WHERE closed = FALSE AND start_at > $1', [now],
      );
      const needLive = Math.max(0, DEMO_LIVE_TARGET - (live.rows[0].c as number));
      const needUp = Math.max(0, DEMO_UPCOMING_TARGET - (upcoming.rows[0].c as number));
      if (needLive + needUp > 0) {
        // Prefer products with media and the fewest open auctions.
        const products = await client.query(
          `SELECT p.id FROM products p
             LEFT JOIN auctions a ON a.product_id = p.id AND a.closed = FALSE
            GROUP BY p.id
            ORDER BY (SELECT COUNT(*) FROM product_media m WHERE m.product_id = p.id) = 0, COUNT(a.id), p.id`,
        );
        const ids = products.rows.map((r) => r.id as number);
        if (ids.length) {
          const plan: [number, number][] = [];
          for (let i = 0; i < needLive; i++) plan.push([now - 60_000, now + (3 + i) * HOUR]);
          for (let i = 0; i < needUp; i++) {
            const start = now + (i + 1) * 30 * 60_000;
            plan.push([start, start + 4 * HOUR]);
          }
          for (let i = 0; i < plan.length; i++) {
            const pid = ids[i % ids.length];
            const p = await client.query('SELECT inventory FROM products WHERE id = $1 FOR UPDATE', [pid]);
            const open = await client.query('SELECT COUNT(*)::int AS c FROM auctions WHERE product_id = $1 AND closed = FALSE', [pid]);
            const short = (open.rows[0].c as number) + 1 - (p.rows[0].inventory as number);
            if (short > 0) await client.query('UPDATE products SET inventory = inventory + $2 WHERE id = $1', [pid, short]);
            await client.query(
              'INSERT INTO auctions (product_id, start_at, end_at, created_at) VALUES ($1, $2, $3, $4)',
              [pid, plan[i][0], plan[i][1], now],
            );
            created++;
          }
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [DEMO_TOPUP_LOCK]).catch(() => {});
    }
    if (created) log('info', 'demo auctions topped up', { created });
    return created;
  } finally {
    client.release();
  }
}
