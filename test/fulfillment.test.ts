import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUser } from '../src/auth';
import { refundOrder } from '../src/orders';
import { bearerFor, csrfFrom, jar, listenApp, login, mkAuction, mkUsers } from './helpers';

test('winner checkout, shipment, inventory, refunds, and dispute notes', async () => {
  const app = await listenApp({ closer: true, config: { paymentsEnabled: false, demoMode: true } });
  try {
    const [winner] = await mkUsers(app.pool, 1, 'win');
    const admin = await createUser(app.pool, 'ops@t.test', 'Ops', 'pw1234', { isAdmin: true, verified: true });
    await app.engine.grant(winner, 5, 'test');
    const id = await mkAuction(app.pool, Date.now() - 1000, Date.now() + 30_000, 2);
    const before = (await app.pool.query(
      'SELECT inventory FROM products WHERE id = (SELECT product_id FROM auctions WHERE id = $1)',
      [id],
    )).rows[0].inventory as number;
    assert.equal((await (await fetch(app.base + `/api/auctions/${id}/bid`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + await bearerFor(app.pool, winner), 'idempotency-key': 'win-bid' },
    })).json() as { ok: boolean }).ok, true);
    await app.pool.query('UPDATE auctions SET end_at = $1 WHERE id = $2', [Date.now() - 1, id]);
    await new Promise((r) => setTimeout(r, 700));
    const closed = (await app.pool.query('SELECT * FROM auctions WHERE id = $1', [id])).rows[0];
    assert.equal(closed.closed, true);
    assert.equal(closed.winner_id, winner);
    assert.equal(closed.stock_decremented, true);
    const after = (await app.pool.query('SELECT inventory FROM products WHERE id = $1', [closed.product_id])).rows[0].inventory;
    assert.equal(after, before - 1);

    const session = await login(app.base, 'win0@t.test', 'pw1234');
    const page = await fetch(app.base + '/checkout/' + id, { headers: { cookie: session.cookies.header() } });
    const html = await page.text();
    assert.match(html, /Winner checkout/);
    const csrf = csrfFrom(html);
    const posted = await fetch(app.base + '/checkout/' + id, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookies.header() },
      body: new URLSearchParams({
        _csrf: csrf, name: 'Win Zero', line1: '1 Drop Lane', line2: '', city: 'Austin', region: 'TX', postal: '78701', country: 'United States',
      }),
    });
    assert.equal(posted.status, 302);
    const order = (await app.pool.query(`SELECT * FROM orders WHERE auction_id = $1`, [id])).rows[0];
    assert.equal(order.status, 'fulfilled');
    assert.equal(order.provider, 'demo');
    const shipment = (await app.pool.query('SELECT * FROM shipments WHERE auction_id = $1', [id])).rows[0];
    assert.equal(shipment.status, 'pending');
    assert.equal(shipment.address.city, 'Austin');

    const adminSession = await login(app.base, 'ops@t.test', 'pw1234');
    const shipPage = await fetch(app.base + '/admin/shipments', { headers: { cookie: adminSession.cookies.header() } });
    const shipHtml = await shipPage.text();
    const shipCsrf = csrfFrom(shipHtml);
    const saved = await fetch(app.base + '/admin/shipments/' + shipment.id, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: adminSession.cookies.header() },
      body: new URLSearchParams({ _csrf: shipCsrf, status: 'shipped', carrier: 'Demo Post', tracking: 'TRACK123' }),
    });
    assert.equal(saved.status, 302);
    const shipped = (await app.pool.query('SELECT status, tracking FROM shipments WHERE id = $1', [shipment.id])).rows[0];
    assert.equal(shipped.status, 'shipped');
    assert.equal(shipped.tracking, 'TRACK123');

    const guestCookies = jar();
    const disputePage = await fetch(app.base + '/account', { headers: { cookie: session.cookies.header() } });
    guestCookies.store(disputePage);
    const disputeCsrf = csrfFrom(await disputePage.text());
    const opened = await fetch(app.base + '/disputes', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookies.header() },
      body: new URLSearchParams({ _csrf: disputeCsrf, subject: 'Where is it', message: 'Tracking has not moved.', auction_id: String(id) }),
    });
    assert.equal(opened.status, 302);
    const dispute = (await app.pool.query('SELECT * FROM disputes WHERE user_id = $1', [winner])).rows[0];
    const note = await fetch(app.base + '/admin/disputes/' + dispute.id, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: adminSession.cookies.header() },
      body: new URLSearchParams({ _csrf: shipCsrf, body: 'SECRET_NOTE_77 warehouse scanned it', status: 'investigating', refund: '0' }),
    });
    assert.equal(note.status, 302);
    const account = await fetch(app.base + '/account', { headers: { cookie: session.cookies.header() } });
    const accountHtml = await account.text();
    assert.equal(accountHtml.includes('SECRET_NOTE_77'), false);
    const adminHtml = await (await fetch(app.base + '/admin/disputes', { headers: { cookie: adminSession.cookies.header() } })).text();
    assert.match(adminHtml, /SECRET_NOTE_77/);

    await refundOrder(app.pool, app.engine, { adminId: admin, orderId: order.id, reason: 'Cannot supply the item' });
    const refunded = (await app.pool.query('SELECT status FROM orders WHERE id = $1', [order.id])).rows[0];
    assert.equal(refunded.status, 'refunded');
    const cancelled = (await app.pool.query('SELECT status FROM shipments WHERE id = $1', [shipment.id])).rows[0];
    assert.equal(cancelled.status, 'cancelled');
    const restored = (await app.pool.query('SELECT inventory FROM products WHERE id = $1', [closed.product_id])).rows[0].inventory;
    assert.equal(restored, before);
    const auction = (await app.pool.query('SELECT checkout_status, stock_decremented FROM auctions WHERE id = $1', [id])).rows[0];
    assert.equal(auction.checkout_status, 'refunded');
    assert.equal(auction.stock_decremented, false);
    await assert.rejects(
      () => refundOrder(app.pool, app.engine, { adminId: admin, orderId: order.id, reason: 'again' }),
      /already refunded/,
    );

    const creditsBefore = (await app.pool.query('SELECT balance FROM users WHERE id = $1', [winner])).rows[0].balance as number;
    await app.engine.refund(admin, winner, 4, 'goodwill');
    const creditsAfter = (await app.pool.query('SELECT balance FROM users WHERE id = $1', [winner])).rows[0].balance as number;
    assert.equal(creditsAfter, creditsBefore + 4);
    const refundRow = (await app.pool.query(`SELECT kind, credits FROM refunds WHERE kind = 'credit' AND user_id = $1`, [winner])).rows[0];
    assert.equal(refundRow.credits, 4);

    const pack = await (await import('../src/orders')).createBidPackOrder(app.pool, app.engine, app.cfg, app.provider, {
      userId: winner, credits: 10, idemKey: 'refund-pack',
    });
    const mid = (await app.pool.query('SELECT balance FROM users WHERE id = $1', [winner])).rows[0].balance as number;
    await refundOrder(app.pool, app.engine, { adminId: admin, orderId: pack.order.id, reason: 'pack refund' });
    const end = (await app.pool.query('SELECT balance FROM users WHERE id = $1', [winner])).rows[0].balance as number;
    assert.equal(end, mid - 10);
    assert.equal((await app.pool.query('SELECT status FROM orders WHERE id = $1', [pack.order.id])).rows[0].status, 'refunded');
  } finally { await app.stop(); }
});
