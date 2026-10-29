import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBidPackOrder } from '../src/orders';
import { listenApp, mkUsers } from './helpers';

test('webhook signature is required and fulfillment is exactly once', async () => {
  const app = await listenApp({ config: { paymentsEnabled: true, demoMode: false }, webhookSecret: 'test-webhook-secret' });
  try {
    const [user] = await mkUsers(app.pool, 1, 'pay');
    const created = await createBidPackOrder(app.pool, app.engine, app.cfg, app.provider, { userId: user, credits: 10, idemKey: 'pack-once' });
    assert.equal(created.order.status, 'pending');
    assert.equal(created.demo, false);
    const event = {
      id: 'evt_pack_1',
      type: 'payment.succeeded',
      orderId: created.order.id,
      amountCents: created.order.amount_cents,
      providerRef: 'mock_pack',
    };
    const raw = JSON.stringify(event);
    const send = (body: string, signature?: string) => fetch(app.base + '/api/webhooks/payments/mock', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(signature ? { 'x-payment-signature': signature } : {}) },
      body,
    });
    const bad = await send(raw, 'deadbeef');
    assert.equal(bad.status, 401);
    const missing = await send(raw);
    assert.equal(missing.status, 401);
    assert.equal((await app.pool.query('SELECT balance FROM users WHERE id = $1', [user])).rows[0].balance, 0);

    const good = await send(raw, app.provider.sign(raw));
    assert.equal(good.status, 200);
    const first = await good.json() as { ok: boolean; duplicate: boolean; fulfilled: boolean };
    assert.equal(first.ok, true);
    assert.equal(first.duplicate, false);
    assert.equal(first.fulfilled, true);
    assert.equal((await app.pool.query('SELECT balance FROM users WHERE id = $1', [user])).rows[0].balance, 10);
    const order = (await app.pool.query('SELECT status FROM orders WHERE id = $1', [created.order.id])).rows[0];
    assert.equal(order.status, 'fulfilled');

    const replay = await send(raw, app.provider.sign(raw));
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { duplicate: boolean }).duplicate, true);
    assert.equal((await app.pool.query('SELECT balance FROM users WHERE id = $1', [user])).rows[0].balance, 10);

    const other = { ...event, id: 'evt_pack_2' };
    const otherRaw = JSON.stringify(other);
    const second = await send(otherRaw, app.provider.sign(otherRaw));
    assert.equal(second.status, 200);
    assert.equal((await second.json() as { duplicate: boolean }).duplicate, true);
    assert.equal((await app.pool.query('SELECT balance FROM users WHERE id = $1', [user])).rows[0].balance, 10);
    const events = (await app.pool.query('SELECT COUNT(*)::int AS c FROM payment_events')).rows[0].c;
    assert.equal(events, 2);

    const mismatch = { ...event, id: 'evt_bad_amount', amountCents: 1 };
    const mismatchRaw = JSON.stringify(mismatch);
    const rejected = await send(mismatchRaw, app.provider.sign(mismatchRaw));
    assert.equal(rejected.status, 400);
    assert.equal((await app.pool.query('SELECT balance FROM users WHERE id = $1', [user])).rows[0].balance, 10);
  } finally { await app.stop(); }
});

test('payments stay disabled unless configured, and the mock provider is the only one wired', async () => {
  const app = await listenApp({ config: { paymentsEnabled: false, demoMode: true } });
  try {
    const [user] = await mkUsers(app.pool, 1, 'demo');
    const created = await createBidPackOrder(app.pool, app.engine, app.cfg, app.provider, { userId: user, credits: 25, idemKey: 'demo-pack' });
    assert.equal(created.demo, true);
    assert.equal(created.order.status, 'fulfilled');
    assert.equal(created.order.provider, 'demo');
    const balance = (await app.pool.query('SELECT balance FROM users WHERE id = $1', [user])).rows[0].balance;
    assert.equal(balance, 25);
    const note = (await app.pool.query(`SELECT note FROM ledger WHERE user_id = $1 AND kind = 'demo_pack'`, [user])).rows[0].note as string;
    assert.match(note, /DEMO/);
    const raw = JSON.stringify({ id: 'evt_ignored', type: 'payment.succeeded', orderId: created.order.id, amountCents: 1, providerRef: 'x' });
    const blocked = await fetch(app.base + '/api/webhooks/payments/mock', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-payment-signature': app.provider.sign(raw) },
      body: raw,
    });
    assert.equal(blocked.status, 403);
    assert.equal(app.provider.name, 'mock');
  } finally { await app.stop(); }
});
