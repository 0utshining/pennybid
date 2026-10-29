import crypto from 'crypto';
import { Pool, PoolClient } from 'pg';
import { Config } from './config';
import { withTx } from './db';
import { BidError, Engine } from './engine';
import { PaymentProvider, WebhookEvent } from './payments';
import { Address } from './validate';
import { log } from './logger';

export type OrderRow = {
  id: number;
  user_id: number;
  kind: string;
  auction_id: number | null;
  credits: number | null;
  amount_cents: number;
  status: string;
  provider: string | null;
  provider_ref: string | null;
  idempotency_key: string;
  shipping: Address | null;
  created_at: number;
  fulfilled_at: number | null;
};

async function insertShipment(c: PoolClient, order: OrderRow, address: Address, at: number): Promise<void> {
  await c.query(
    `INSERT INTO shipments (order_id, auction_id, user_id, status, address, created_at, updated_at)
     VALUES ($1, $2, $3, 'pending', $4::jsonb, $5, $5)`,
    [order.id, order.auction_id, order.user_id, JSON.stringify(address), at],
  );
  await c.query(
    `UPDATE auctions SET shipping_status = 'pending', checkout_status = $2 WHERE id = $1`,
    [order.auction_id, order.provider === 'demo' ? 'demo_confirmed' : 'paid'],
  );
}

async function fulfillLocked(c: PoolClient, engine: Engine, order: OrderRow, at: number): Promise<void> {
  if (order.kind === 'bid_pack') {
    const kind = order.provider === 'demo' ? 'demo_pack' : 'bid_pack';
    const note = order.provider === 'demo'
      ? `DEMO pack of ${order.credits} (no payment taken)`
      : `Bid pack of ${order.credits}`;
    await engine.applyBalance(c, order.user_id, order.credits || 0, kind, `order:${order.id}`, note, at);
  } else if (order.kind === 'winner_checkout') {
    const address = order.shipping;
    if (!address) throw new BidError('bad_amount', 'Missing shipping address');
    await insertShipment(c, order, address, at);
  } else {
    throw new BidError('bad_amount', 'Unknown order kind');
  }
  await c.query(
    `UPDATE orders SET status = 'fulfilled', fulfilled_at = $2 WHERE id = $1 AND status = 'pending'`,
    [order.id, at],
  );
}

export async function createBidPackOrder(
  pool: Pool,
  engine: Engine,
  cfg: Config,
  provider: PaymentProvider,
  input: { userId: number; credits: number; idemKey?: string },
): Promise<{ order: OrderRow; checkoutPath: string | null; demo: boolean }> {
  if (!cfg.bidPacks.includes(input.credits)) throw new BidError('bad_amount', 'Unknown pack');
  if (!cfg.paymentsEnabled && !cfg.demoMode) {
    throw new BidError('bad_amount', 'Credit sales are unavailable until a payment processor is approved');
  }
  const idem = (input.idemKey || `pack:${input.userId}:${input.credits}:${crypto.randomUUID()}`).slice(0, 120);
  const amount = input.credits * cfg.nominalBidPriceCents;
  const at = Date.now();

  const existing = await pool.query('SELECT * FROM orders WHERE idempotency_key = $1', [idem]);
  if (existing.rows[0]) {
    const order = existing.rows[0] as OrderRow;
    return {
      order,
      demo: order.provider === 'demo',
      checkoutPath: order.status === 'pending' ? `/pay/mock/${order.id}` : null,
    };
  }

  const order = await withTx(pool, async (c) => {
    const ins = await c.query(
      `INSERT INTO orders (user_id, kind, credits, amount_cents, status, provider, idempotency_key, created_at)
       VALUES ($1, 'bid_pack', $2, $3, 'pending', $4, $5, $6) RETURNING *`,
      [input.userId, input.credits, amount, cfg.paymentsEnabled ? provider.name : 'demo', idem, at],
    );
    const row = ins.rows[0] as OrderRow;
    if (!cfg.paymentsEnabled) {
      await fulfillLocked(c, engine, row, at);
      const again = await c.query('SELECT * FROM orders WHERE id = $1', [row.id]);
      return again.rows[0] as OrderRow;
    }
    return row;
  });

  if (!cfg.paymentsEnabled) return { order, checkoutPath: null, demo: true };
  const pay = await provider.createPayment({
    orderId: order.id,
    amountCents: order.amount_cents,
    kind: order.kind,
    userId: order.user_id,
    description: `${input.credits} bid credits`,
  });
  await pool.query('UPDATE orders SET provider_ref = $2 WHERE id = $1', [order.id, pay.providerRef]);
  return { order, checkoutPath: pay.checkoutPath, demo: false };
}

export async function createWinnerOrder(
  pool: Pool,
  engine: Engine,
  cfg: Config,
  provider: PaymentProvider,
  input: { userId: number; auctionId: number; address: Address; idemKey?: string },
): Promise<{ order: OrderRow; checkoutPath: string | null; demo: boolean }> {
  const idem = (input.idemKey || `winner:${input.auctionId}`).slice(0, 120);
  const at = Date.now();

  const created = await withTx(pool, async (c) => {
    const ares = await c.query(
      `SELECT * FROM auctions WHERE id = $1 AND winner_id = $2 FOR UPDATE`,
      [input.auctionId, input.userId],
    );
    const a = ares.rows[0];
    if (!a) throw new BidError('not_found', 'No winning auction found');
    if (a.checkout_status === 'refunded') throw new BidError('bad_amount', 'This win was refunded');
    const existing = await c.query(
      `SELECT * FROM orders WHERE auction_id = $1 AND kind = 'winner_checkout'`,
      [input.auctionId],
    );
    if (existing.rows[0]) return { order: existing.rows[0] as OrderRow, fresh: false };

    const amount = (a.final_price_cents as number) + cfg.shippingCents;
    const ins = await c.query(
      `INSERT INTO orders (user_id, kind, auction_id, credits, amount_cents, status, provider, idempotency_key, shipping, created_at)
       VALUES ($1, 'winner_checkout', $2, NULL, $3, 'pending', $4, $5, $6::jsonb, $7) RETURNING *`,
      [
        input.userId,
        input.auctionId,
        amount,
        cfg.paymentsEnabled ? provider.name : 'demo',
        idem,
        JSON.stringify(input.address),
        at,
      ],
    );
    let order = ins.rows[0] as OrderRow;
    if (!cfg.paymentsEnabled) {
      await fulfillLocked(c, engine, order, at);
      order = (await c.query('SELECT * FROM orders WHERE id = $1', [order.id])).rows[0] as OrderRow;
    }
    return { order, fresh: true };
  });

  if (!cfg.paymentsEnabled || created.order.status !== 'pending') {
    return { order: created.order, checkoutPath: null, demo: created.order.provider === 'demo' };
  }
  const pay = await provider.createPayment({
    orderId: created.order.id,
    amountCents: created.order.amount_cents,
    kind: 'winner_checkout',
    userId: input.userId,
    description: `Winner checkout #${input.auctionId}`,
  });
  await pool.query('UPDATE orders SET provider_ref = $2 WHERE id = $1', [created.order.id, pay.providerRef]);
  return { order: created.order, checkoutPath: pay.checkoutPath, demo: false };
}

export type WebhookResult = { status: number; body: Record<string, unknown> };

/**
 * Verify the signature, then fulfill at most once.
 * A repeated event id is a no-op. A second event for an order that is already
 * fulfilled does not grant credits or create another shipment.
 */
export async function handlePaymentWebhook(
  pool: Pool,
  engine: Engine,
  cfg: Config,
  provider: PaymentProvider,
  raw: Buffer,
  signature: string | undefined,
): Promise<WebhookResult> {
  if (!cfg.paymentsEnabled) return { status: 403, body: { ok: false, error: 'payments_disabled' } };
  if (!provider.verify(raw, signature)) return { status: 401, body: { ok: false, error: 'bad_signature' } };
  let event: WebhookEvent;
  try {
    event = provider.parseEvent(raw);
  } catch (err) {
    return { status: 400, body: { ok: false, error: 'bad_payload', message: err instanceof Error ? err.message : 'bad payload' } };
  }
  if (provider.name !== 'mock' && provider.name !== cfg.paymentProvider) {
    return { status: 400, body: { ok: false, error: 'unknown_provider' } };
  }

  try {
    const result = await withTx(pool, async (c) => {
      const ins = await c.query(
        `INSERT INTO payment_events (provider, event_id, order_id, payload, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (provider, event_id) DO NOTHING
         RETURNING id`,
        [provider.name, event.id, event.orderId, raw.toString('utf8'), Date.now()],
      );
      if (ins.rowCount === 0) return { duplicate: true as const, fulfilled: false };

      const locked = await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [event.orderId]);
      const order = locked.rows[0] as OrderRow | undefined;
      if (!order) {
        log('warn', 'webhook for missing order', { orderId: event.orderId, eventId: event.id });
        return { duplicate: false as const, missing: true as const };
      }
      if (order.amount_cents !== event.amountCents) throw new BidError('bad_amount', 'Amount does not match the order');
      if (order.status !== 'pending') return { duplicate: true as const, fulfilled: false };
      if (event.type === 'payment.failed') {
        await c.query(`UPDATE orders SET status = 'failed' WHERE id = $1`, [order.id]);
        return { duplicate: false as const, fulfilled: false };
      }
      if (!order.provider_ref) {
        await c.query('UPDATE orders SET provider_ref = $2 WHERE id = $1', [order.id, event.providerRef]);
      }
      await fulfillLocked(c, engine, { ...order, provider: provider.name }, Date.now());
      return { duplicate: false as const, fulfilled: true };
    });
    if ('missing' in result && result.missing) return { status: 404, body: { ok: false, error: 'not_found' } };
    return { status: 200, body: { ok: true, duplicate: result.duplicate, fulfilled: result.fulfilled } };
  } catch (err) {
    if (err instanceof BidError) return { status: 400, body: { ok: false, error: err.code, message: err.message } };
    log('error', 'webhook failed', { err: err instanceof Error ? err.message : String(err) });
    return { status: 500, body: { ok: false, error: 'server_error' } };
  }
}

export async function refundOrder(pool: Pool, engine: Engine, input: { adminId: number; orderId: number; reason: string }): Promise<void> {
  const reason = input.reason.slice(0, 500);
  const at = Date.now();
  await withTx(pool, async (c) => {
    const locked = await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [input.orderId]);
    const order = locked.rows[0] as OrderRow | undefined;
    if (!order) throw new BidError('not_found', 'Order not found');
    if (order.status === 'refunded') throw new BidError('bad_amount', 'Order already refunded');
    if (order.status !== 'fulfilled') throw new BidError('bad_amount', 'Only a fulfilled order can be refunded');

    if (order.kind === 'bid_pack') {
      await engine.applyBalance(
        c,
        order.user_id,
        -(order.credits || 0),
        'order_refund',
        `refund-order:${order.id}`,
        reason,
        at,
      );
    }
    if (order.kind === 'winner_checkout' && order.auction_id) {
      await c.query(
        `UPDATE shipments SET status = 'cancelled', updated_at = $2 WHERE order_id = $1 AND status <> 'cancelled'`,
        [order.id, at],
      );
      const ares = await c.query('SELECT * FROM auctions WHERE id = $1 FOR UPDATE', [order.auction_id]);
      const a = ares.rows[0];
      if (a?.stock_decremented) {
        await c.query('UPDATE products SET inventory = inventory + 1 WHERE id = $1', [a.product_id]);
        await c.query(
          `UPDATE auctions SET stock_decremented = FALSE, checkout_status = 'refunded', shipping_status = 'cancelled' WHERE id = $1`,
          [a.id],
        );
      } else {
        await c.query(
          `UPDATE auctions SET checkout_status = 'refunded', shipping_status = 'cancelled' WHERE id = $1`,
          [order.auction_id],
        );
      }
    }
    await c.query(`UPDATE orders SET status = 'refunded' WHERE id = $1`, [order.id]);
    await c.query(
      `INSERT INTO refunds (user_id, order_id, auction_id, kind, credits, amount_cents, reason, admin_id, created_at)
       VALUES ($1, $2, $3, 'order', $4, $5, $6, $7, $8)`,
      [order.user_id, order.id, order.auction_id, order.credits || 0, order.amount_cents, reason, input.adminId, at],
    );
  });
}

export async function updateShipment(
  pool: Pool,
  id: number,
  patch: { status: string; tracking: string; carrier: string },
): Promise<void> {
  if ((patch.status === 'shipped' || patch.status === 'delivered') && !patch.tracking) {
    throw new BidError('bad_amount', 'Tracking is required once a parcel ships');
  }
  const at = Date.now();
  const row = await pool.query('SELECT * FROM shipments WHERE id = $1', [id]);
  if (!row.rows[0]) throw new BidError('not_found', 'Shipment not found');
  await pool.query(
    `UPDATE shipments SET status = $2, tracking = NULLIF($3, ''), carrier = NULLIF($4, ''), updated_at = $5 WHERE id = $1`,
    [id, patch.status, patch.tracking, patch.carrier, at],
  );
  await pool.query(
    `UPDATE auctions SET shipping_status = $2, tracking = NULLIF($3, '') WHERE id = $1`,
    [row.rows[0].auction_id, patch.status, patch.tracking],
  );
}
