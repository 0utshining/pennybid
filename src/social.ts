import { Pool } from 'pg';

export type PublicTestimonial = {
  id: number;
  display_name: string;
  body: string;
  rating: number | null;
  is_sample: boolean;
  created_at: number;
};

export type SocialStats = {
  members: number;
  bids: number;
  wins: number;
  savedCents: number;
};

export async function getSocialProof(pool: Pool, demoMode: boolean): Promise<{
  demoMode: boolean;
  stats: SocialStats;
  testimonials: PublicTestimonial[];
}> {
  const statsRow = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM users WHERE is_admin = FALSE) AS members,
      (SELECT COUNT(*)::int FROM bids) AS bids,
      (SELECT COUNT(*)::int FROM auctions WHERE closed = TRUE AND winner_id IS NOT NULL) AS wins,
      (SELECT COALESCE(SUM(GREATEST(p.retail_cents - a.final_price_cents, 0)), 0)::int
         FROM auctions a JOIN products p ON p.id = a.product_id
        WHERE a.closed = TRUE AND a.winner_id IS NOT NULL AND a.final_price_cents IS NOT NULL) AS saved
  `);
  const s = statsRow.rows[0];
  // Sample rows are returned only while demoMode is on. Callers must label them.
  const testimonials = await pool.query(
    `SELECT id, display_name, body, rating, is_sample, created_at
       FROM testimonials
      WHERE status = 'approved' AND (is_sample = FALSE OR $1::boolean = TRUE)
      ORDER BY id DESC
      LIMIT 12`,
    [demoMode],
  );
  return {
    demoMode,
    stats: {
      members: s.members as number,
      bids: s.bids as number,
      wins: s.wins as number,
      savedCents: s.saved as number,
    },
    testimonials: testimonials.rows as PublicTestimonial[],
  };
}

export async function recentTicker(pool: Pool, limit = 12): Promise<{ text: string; at: number }[]> {
  const bids = await pool.query(
    `SELECT b.created_at AS at, b.price_after_cents, u.name AS who, p.name AS item
       FROM bids b
       JOIN users u ON u.id = b.user_id
       JOIN auctions a ON a.id = b.auction_id
       JOIN products p ON p.id = a.product_id
      ORDER BY b.id DESC LIMIT $1`,
    [limit],
  );
  const wins = await pool.query(
    `SELECT a.closed_at AS at, a.final_price_cents, w.name AS who, p.name AS item
       FROM auctions a
       JOIN products p ON p.id = a.product_id
       LEFT JOIN users w ON w.id = a.winner_id
      WHERE a.closed = TRUE AND a.winner_id IS NOT NULL
      ORDER BY a.closed_at DESC LIMIT 6`,
  );
  const items = [
    ...bids.rows.map((b) => ({
      at: b.at as number,
      text: `${b.who} bid $${((b.price_after_cents as number) / 100).toFixed(2)} on ${b.item}`,
    })),
    ...wins.rows.map((w) => ({
      at: (w.at as number) || 0,
      text: `${w.who} won ${w.item} at $${((w.final_price_cents as number) / 100).toFixed(2)}`,
    })),
  ];
  items.sort((a, b) => b.at - a.at);
  return items.slice(0, limit);
}
