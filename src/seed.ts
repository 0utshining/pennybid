import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { Config } from './config';
import { createUser } from './auth';
import { createEngine, Engine } from './engine';
import { createWinnerOrder } from './orders';
import { createMockProvider } from './payments';
import { SAMPLE_TESTIMONIALS } from './sampleContent';
import { createStorage } from './storage';
import { addImage, addVideo } from './media';
import { demoProductPng } from './demoArt';

const items = [
  ['Studio Headphones', 'Over-ear, 30-hour battery, the pair the group chat argues about.', 34900, '#4a1d6a'],
  ['4K Stream Stick', 'Voice remote, 4K HDR, plugs into the hotel TV.', 4999, '#0f6e56'],
  ['Pulse Smartwatch', 'GPS, heart-rate, two-day battery, night-out proof.', 39900, '#8c1d40'],
  ['Barista Espresso', '15-bar pump and a steam wand that actually textures milk.', 22900, '#8a4b12'],
  ['Demo Gift Card', 'A $100 demo card. Not redeemable for cash. Labeled so nobody mistakes it.', 10000, '#3d2a86'],
  ['Mech Keyboard', 'Hot-swap switches, aluminum deck, RGB you can turn off.', 15900, '#0e5870'],
] as const;

export async function seed(pool: Pool, engine: Engine, uploadDir: string, cfg: Config): Promise<boolean> {
  const existing = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  if (existing.rows[0].c > 0) return false;
  fs.mkdirSync(uploadDir, { recursive: true });

  const adminPassword = cfg.demoMode ? 'admin123' : process.env.ADMIN_PASSWORD;
  if (!adminPassword) return false;
  const admin = await createUser(pool, process.env.ADMIN_EMAIL || 'admin@demo.test', 'Admin', adminPassword, { isAdmin: true, verified: true });

  let alice = 0;
  let bob = 0;
  let carol = 0;
  if (cfg.demoMode) {
    alice = await createUser(pool, 'alice@demo.test', 'Alice', 'demo123', { verified: true });
    bob = await createUser(pool, 'bob@demo.test', 'Bob', 'demo123', { verified: true });
    carol = await createUser(pool, 'carol@demo.test', 'Carol', 'demo123', { verified: true });
    for (const id of [admin, alice, bob, carol]) {
      await engine.grant(id, 100, 'signup_bonus', 'Seed demo credits');
    }
  }

  const now = Date.now();
  const productIds: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const [name, desc, retail] = items[i];
    const row = await pool.query(
      `INSERT INTO products (name, description, retail_cents, inventory, images, created_at)
       VALUES ($1, $2, $3, 3, '[]'::jsonb, $4) RETURNING id`,
      [name, desc, retail, now],
    );
    productIds.push(row.rows[0].id as number);
  }

  const storage = createStorage(uploadDir);
  const shots = [
    { angle: -12, label: 'Front three-quarter' },
    { angle: 18, label: 'Side profile' },
    { angle: 0, label: 'Straight on' },
  ];
  const accents = ['#ff4d8d', '#7af6ea', '#c4a2ff', '#ffd60a', '#ff7ad9', '#7af6ea'];
  for (let i = 0; i < items.length; i++) {
    const [name, , , color] = items[i];
    const pid = productIds[i];
    for (let n = 0; n < shots.length; n++) {
      const png = await demoProductPng({ title: name, color, accent: accents[i], angle: shots[n].angle, label: shots[n].label });
      await addImage(pool, storage, pid, png, `${name}, ${shots[n].label.toLowerCase()}. Generated demo placeholder, not a photograph of a real product.`, { cover: n === 0 });
    }
    if (i === 0) {
      for (let frame = 0; frame < 6; frame++) {
        const png = await demoProductPng({ title: name, color, accent: accents[0], angle: -36 + frame * 14, label: `Spin ${frame + 1}` });
        await addImage(pool, storage, pid, png, `${name} turntable frame ${frame + 1} of 6. Generated demo placeholder.`, { spin: true });
      }
    }
    if (i === 2) {
      const video = fs.readFileSync(path.join(__dirname, 'demo', 'pulse-preview.mp4'));
      await addVideo(pool, storage, pid, video, `${name} two-second demo clip. Generated color preview, not a recording of a real product.`);
    }
  }

  async function addAuction(productId: number, start: number, end: number) {
    const row = await pool.query(
      'INSERT INTO auctions (product_id, start_at, end_at, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
      [productId, start, end, now],
    );
    return row.rows[0].id as number;
  }

  if (cfg.demoMode) {
    let t = now - 5 * 24 * 60 * 60 * 1000;
    const past = createEngine(pool, { clock: () => t, config: cfg, schema: 'seed' });
    const headphones = await addAuction(productIds[0], t - 60_000, t + 60_000);
    const watch = await addAuction(productIds[2], t - 60_000, t + 90_000);
    const script: [number, number, string][] = [
      [headphones, alice, 'hist-a1'],
      [headphones, bob, 'hist-b1'],
      [headphones, alice, 'hist-a2'],
      [watch, bob, 'hist-w1'],
      [watch, alice, 'hist-w2'],
      [watch, carol, 'hist-w3'],
      [watch, bob, 'hist-w4'],
    ];
    for (const [auctionId, userId, key] of script) {
      t += 1000;
      await past.placeBid(auctionId, userId, key);
    }
    t += 120_000;
    await past.closeDue();

    const liveEnds = [90_000, 3 * 60_000, 5 * 60_000, 8 * 60_000];
    const liveProducts = [productIds[0], productIds[1], productIds[2], productIds[4]];
    const liveIds: number[] = [];
    for (let i = 0; i < liveProducts.length; i++) {
      liveIds.push(await addAuction(liveProducts[i], now - 60_000, now + liveEnds[i]));
    }
    await addAuction(productIds[3], now + 30 * 60_000, now + 90 * 60_000);
    await addAuction(productIds[5], now + 60 * 60_000, now + 2 * 60 * 60_000);
    await engine.placeBid(liveIds[0], alice, 'live-a');
    await engine.placeBid(liveIds[0], bob, 'live-b');
    await engine.placeBid(liveIds[0], carol, 'live-c');
    await engine.placeBid(liveIds[1], bob, 'live-b2');
    await engine.placeBid(liveIds[1], alice, 'live-a2');

    const provider = createMockProvider(process.env.PAYMENT_WEBHOOK_SECRET || 'dev-webhook-secret');
    await createWinnerOrder(pool, engine, cfg, provider, {
      userId: bob,
      auctionId: watch,
      address: {
        name: 'Bob Demo',
        line1: '18 Mercer Street',
        line2: 'Apt 4',
        city: 'New York',
        region: 'NY',
        postal: '10013',
        country: 'United States',
      },
    });
    await pool.query(
      `UPDATE shipments SET status = 'shipped', carrier = 'Demo Post', tracking = '1Z999SAMPLE', updated_at = $1
        WHERE auction_id = $2`,
      [now, watch],
    );
    await pool.query(
      `UPDATE auctions SET shipping_status = 'shipped', tracking = '1Z999SAMPLE' WHERE id = $1`,
      [watch],
    );

    const dispute = await pool.query(
      `INSERT INTO disputes (user_id, auction_id, subject, message, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'open', $5, $5) RETURNING id`,
      [carol, headphones, 'Timer looked stuck', 'The countdown on my screen froze for a second in the final stretch. Please check the server clock against my last bid.', now],
    );
    await pool.query(
      `INSERT INTO dispute_notes (dispute_id, author_id, body, internal, created_at)
       VALUES ($1, $2, $3, TRUE, $4)`,
      [dispute.rows[0].id, admin, 'Checked auction_events. Close matches the last accepted bid. Waiting on Carol before resolving.', now],
    );

    for (const sample of SAMPLE_TESTIMONIALS) {
      await pool.query(
        `INSERT INTO testimonials (display_name, body, rating, status, is_sample, created_at)
         VALUES ($1, $2, $3, 'approved', TRUE, $4)`,
        [sample.name, sample.body, sample.rating, now],
      );
    }
    await pool.query(
      `INSERT INTO testimonials (user_id, display_name, body, rating, status, is_sample, created_at)
       VALUES ($1, 'Bob', 'Pending note from a seeded account — moderate me before I am public.', 4, 'pending', TRUE, $2)`,
      [bob, now],
    );
  } else {
    const start = now + 60 * 60_000;
    for (const pid of productIds) await addAuction(pid, start, start + 60 * 60_000);
  }
  return true;
}
