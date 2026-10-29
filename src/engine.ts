import crypto from 'crypto';
import { Pool, PoolClient } from 'pg';
import { Config, loadConfig } from './config';
import { withTx } from './db';
import { log } from './logger';

export type Clock = () => number;
export class BidError extends Error {
  constructor(public code: string, msg: string) { super(msg); }
}

export type ChangeKind = 'bid' | 'closed';

type Queryable = Pool | PoolClient;

function lockKey(schema: string): number {
  let h = 2166136261;
  const s = 'closer:' + schema;
  for (const ch of s) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

export function createEngine(
  pool: Pool,
  opts: { clock?: Clock; config?: Config; onChange?: (auctionId: number, kind: ChangeKind) => Promise<void> | void; schema?: string } = {},
) {
  const now: Clock = opts.clock ?? Date.now;
  const cfg = opts.config ?? loadConfig();
  const schema = opts.schema || 'public';
  const advisory = lockKey(schema);

  /** Append a ledger row and move the balance. Caller must already be inside a transaction. */
  async function applyBalance(
    client: PoolClient,
    userId: number,
    delta: number,
    kind: string,
    ref: string | null,
    note: string | null,
    at: number,
  ): Promise<number> {
    if (!Number.isInteger(delta) || delta === 0) throw new BidError('bad_amount', 'Invalid amount');
    const u = await client.query('SELECT id, balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!u.rows[0]) throw new BidError('no_user', 'User not found');
    const bal = (u.rows[0].balance as number) + delta;
    if (bal < 0) throw new BidError('insufficient', 'Not enough credits');
    await client.query('UPDATE users SET balance = $1 WHERE id = $2', [bal, userId]);
    await client.query(
      `INSERT INTO ledger (user_id, delta, balance_after, kind, ref, note, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, delta, bal, kind, ref, note, at],
    );
    return bal;
  }

  async function placeBid(auctionId: number, userId: number, idemKey?: string) {
    const key = (idemKey && String(idemKey).slice(0, 100)) || crypto.randomUUID();
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await withTx(pool, async (c) => {
          // Lock the auction first so writers on one auction serialize, then re-read
          // the idempotency key. A check before the lock can miss a bid that commits
          // while this transaction is waiting.
          const ares = await c.query('SELECT * FROM auctions WHERE id = $1 FOR UPDATE', [auctionId]);
          const prior = await c.query('SELECT * FROM bids WHERE user_id = $1 AND idem_key = $2', [userId, key]);
          if (prior.rows[0]) {
            const p = prior.rows[0];
            if (p.auction_id !== auctionId) throw new BidError('key_reuse', 'Idempotency key already used for another auction');
            return {
              duplicate: true as const,
              bidId: p.id as number,
              priceCents: p.price_after_cents as number,
              endAt: p.end_at_after as number,
            };
          }
          const a = ares.rows[0];
          if (!a) throw new BidError('not_found', 'Auction not found');
          const t = now();
          if (a.closed || t >= a.end_at) throw new BidError('ended', 'Auction has ended');
          if (t < a.start_at) throw new BidError('not_started', 'Auction has not started');
          if (!cfg.allowConsecutiveBids && a.last_bidder_id === userId) {
            throw new BidError('already_leading', 'You are already the high bidder');
          }
          const price = (a.price_cents as number) + cfg.priceIncrementCents;
          const endAt = (a.end_at as number) - t < cfg.resetThresholdMs
            ? Math.max(a.end_at as number, t + cfg.resetToMs)
            : (a.end_at as number);
          const ins = await c.query(
            `INSERT INTO bids (auction_id, user_id, price_after_cents, end_at_after, idem_key, created_at)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [auctionId, userId, price, endAt, key, t],
          );
          const bidId = ins.rows[0].id as number;
          await applyBalance(c, userId, -cfg.creditsPerBid, 'bid', `bid:${bidId}`, `Bid on auction #${auctionId}`, t);
          const upd = await c.query(
            `UPDATE auctions SET price_cents = $1, bid_count = bid_count + 1, last_bidder_id = $2, end_at = $3
             WHERE id = $4 AND closed = FALSE`,
            [price, userId, endAt, auctionId],
          );
          if (upd.rowCount !== 1) throw new BidError('ended', 'Auction has ended');
          return { duplicate: false as const, bidId, priceCents: price, endAt };
        });
        if (!res.duplicate) await opts.onChange?.(auctionId, 'bid');
        return res;
      } catch (err) {
        if (err instanceof BidError) throw err;
        const e = err as { code?: string };
        if (e.code === '23505') {
          const prior = await pool.query('SELECT * FROM bids WHERE user_id = $1 AND idem_key = $2', [userId, key]);
          if (prior.rows[0]) {
            const p = prior.rows[0];
            if (p.auction_id !== auctionId) throw new BidError('key_reuse', 'Idempotency key already used for another auction');
            return {
              duplicate: true as const,
              bidId: p.id as number,
              priceCents: p.price_after_cents as number,
              endAt: p.end_at_after as number,
            };
          }
        }
        if ((e.code === '40P01' || e.code === '40001') && attempt < 3) continue;
        throw err;
      }
    }
    throw new Error('bid failed after retries');
  }

  async function closeOne(client: PoolClient, id: number, t: number): Promise<boolean> {
    const cur = await client.query('SELECT * FROM auctions WHERE id = $1 FOR UPDATE', [id]);
    const a = cur.rows[0];
    if (!a || a.closed || (a.end_at as number) > t) return false;
    const winnerId = (a.last_bidder_id as number | null) ?? null;
    const upd = await client.query(
      `UPDATE auctions
         SET closed = TRUE,
             winner_id = $2,
             final_price_cents = price_cents,
             closed_at = $3,
             checkout_status = CASE WHEN $2::int IS NULL THEN 'none' ELSE 'pending' END
       WHERE id = $1 AND closed = FALSE AND end_at <= $3`,
      [id, winnerId, t],
    );
    if (upd.rowCount !== 1) return false;
    let stock = false;
    if (winnerId) {
      const inv = await client.query(
        'UPDATE products SET inventory = inventory - 1 WHERE id = $1 AND inventory > 0 RETURNING id',
        [a.product_id],
      );
      stock = inv.rowCount === 1;
      if (!stock) log('warn', 'inventory not decremented on win', { auctionId: id, productId: a.product_id });
    }
    await client.query('UPDATE auctions SET stock_decremented = $2 WHERE id = $1', [id, stock]);
    await client.query(
      `INSERT INTO auction_events (auction_id, kind, data, created_at) VALUES ($1, 'closed', $2::jsonb, $3)`,
      [id, JSON.stringify({ winner_id: winnerId, final_price_cents: a.price_cents }), t],
    );
    return true;
  }

  /** Close every auction whose deadline has passed. Safe across instances and restarts. */
  async function closeDue(): Promise<number[]> {
    const client = await pool.connect();
    const closedIds: number[] = [];
    try {
      const lock = await client.query('SELECT pg_try_advisory_lock($1::int) AS ok', [advisory]);
      if (!lock.rows[0].ok) return [];
      try {
        const t = now();
        const due = await client.query(
          'SELECT id FROM auctions WHERE closed = FALSE AND end_at <= $1 ORDER BY id',
          [t],
        );
        for (const row of due.rows) {
          await client.query('BEGIN');
          try {
            const did = await closeOne(client, row.id as number, t);
            await client.query('COMMIT');
            if (did) closedIds.push(row.id as number);
          } catch (err) {
            try { await client.query('ROLLBACK'); } catch { /* ignore */ }
            log('error', 'close failed', { id: row.id, err: err instanceof Error ? err.message : String(err) });
          }
        }
      } finally {
        await client.query('SELECT pg_advisory_unlock($1::int)', [advisory]);
      }
    } finally {
      client.release();
    }
    for (const id of closedIds) await opts.onChange?.(id, 'closed');
    return closedIds;
  }

  async function startCloser(): Promise<() => void> {
    let stopped = false;
    let running = false;
    const tick = async () => {
      if (stopped || running) return;
      running = true;
      try { await closeDue(); } catch (err) {
        log('error', 'closer', { err: err instanceof Error ? err.message : String(err) });
      } finally { running = false; }
    };
    await tick();
    const handle = setInterval(() => { void tick(); }, cfg.closerIntervalMs);
    handle.unref?.();
    return () => { stopped = true; clearInterval(handle); };
  }

  async function grant(userId: number, credits: number, kind: string, note: string | null = null, ref: string | null = null) {
    if (!Number.isInteger(credits) || credits <= 0) throw new BidError('bad_amount', 'Invalid amount');
    return withTx(pool, (c) => applyBalance(c, userId, credits, kind, ref, note, now()));
  }

  async function refund(adminId: number, userId: number, credits: number, note: string) {
    if (!Number.isInteger(credits) || credits <= 0) throw new BidError('bad_amount', 'Invalid amount');
    const clean = String(note || 'refund').slice(0, 500);
    return withTx(pool, async (c) => {
      const bal = await applyBalance(c, userId, credits, 'refund', `admin:${adminId}`, `admin:${adminId}: ${clean}`, now());
      await c.query(
        `INSERT INTO refunds (user_id, kind, credits, amount_cents, reason, admin_id, created_at)
         VALUES ($1, 'credit', $2, 0, $3, $4, $5)`,
        [userId, credits, clean, adminId, now()],
      );
      return bal;
    });
  }

  async function auctionState(id: number) {
    const row = await pool.query(
      `SELECT a.*, p.name, p.retail_cents, p.images, p.description,
              u.name AS leader, w.name AS winner
         FROM auctions a
         JOIN products p ON p.id = a.product_id
         LEFT JOIN users u ON u.id = a.last_bidder_id
         LEFT JOIN users w ON w.id = a.winner_id
        WHERE a.id = $1`,
      [id],
    );
    const a = row.rows[0];
    if (!a) return null;
    const bids = await pool.query(
      `SELECT b.id, b.price_after_cents, b.created_at, u.name
         FROM bids b JOIN users u ON u.id = b.user_id
        WHERE b.auction_id = $1 ORDER BY b.id DESC LIMIT 15`,
      [id],
    );
    const t = now();
    const status = a.closed ? 'closed' : t < a.start_at ? 'upcoming' : t >= a.end_at ? 'closing' : 'live';
    return {
      id: a.id as number,
      name: a.name as string,
      description: a.description as string,
      retailCents: a.retail_cents as number,
      images: Array.isArray(a.images) ? a.images as string[] : [],
      priceCents: a.price_cents as number,
      bidCount: a.bid_count as number,
      startAt: a.start_at as number,
      endAt: a.end_at as number,
      status,
      leader: (a.leader as string | null) ?? null,
      winner: (a.winner as string | null) ?? null,
      winnerId: (a.winner_id as number | null) ?? null,
      serverNow: t,
      bids: bids.rows as { id: number; price_after_cents: number; created_at: number; name: string }[],
    };
  }

  return { placeBid, closeDue, startCloser, grant, refund, applyBalance, auctionState, now, cfg, pool };
}

export type Engine = ReturnType<typeof createEngine>;

export async function queryOne<T = Record<string, unknown>>(q: Queryable, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await q.query(sql, params);
  return (r.rows[0] as T) ?? null;
}
