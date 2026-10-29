import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUser } from '../src/auth';
import { bearerFor, bid, csrfFrom, jar, listenApp, login, makeSchema, mkAuction, mkUsers } from './helpers';
import { dropSchema } from '../src/db';

test('security headers, health, and admin authorization', async () => {
  const app = await listenApp();
  try {
    const home = await fetch(app.base + '/');
    assert.equal(home.headers.get('x-frame-options'), 'DENY');
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
    assert.match(home.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.match(home.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    const health = await fetch(app.base + '/healthz').then((r) => r.json() as Promise<{ ok: boolean; db: string; redis: string }>);
    assert.equal(health.ok, true);
    assert.equal(health.db, 'up');
    assert.equal(health.redis, 'up');

    const [member] = await mkUsers(app.pool, 1, 'mem');
    const admin = await createUser(app.pool, 'admin-sec@t.test', 'Admin', 'pw1234', { isAdmin: true, verified: true });
    const anon = await fetch(app.base + '/admin', { redirect: 'manual' });
    assert.equal(anon.status, 302);
    const memberLogin = await login(app.base, 'mem0@t.test', 'pw1234');
    assert.equal(memberLogin.res.status, 302);
    const forbidden = await fetch(app.base + '/admin', { headers: { cookie: memberLogin.cookies.header() } });
    assert.equal(forbidden.status, 403);
    const adminLogin = await login(app.base, 'admin-sec@t.test', 'pw1234');
    const dash = await fetch(app.base + '/admin', { headers: { cookie: adminLogin.cookies.header() } });
    assert.equal(dash.status, 200);
    assert.match(await dash.text(), /Dashboard/);
    assert.ok(member && admin);
  } finally { await app.stop(); }
});

test('cookie sessions require a CSRF token; bearer tokens do not', async () => {
  const app = await listenApp();
  try {
    const [user] = await mkUsers(app.pool, 1, 'csrf');
    await app.engine.grant(user, 5, 'test');
    const id = await mkAuction(app.pool, Date.now() - 1000, Date.now() + 60_000);
    const cookies = jar();
    const loginPage = await fetch(app.base + '/login');
    cookies.store(loginPage);
    const token = csrfFrom(await loginPage.text());
    const missing = await fetch(app.base + '/login', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookies.header() },
      body: new URLSearchParams({ email: 'csrf0@t.test', password: 'pw1234' }),
    });
    assert.equal(missing.status, 403);
    const ok = await fetch(app.base + '/login', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookies.header() },
      body: new URLSearchParams({ email: 'csrf0@t.test', password: 'pw1234', _csrf: token }),
    });
    assert.equal(ok.status, 302);
    cookies.store(ok);
    const account = await fetch(app.base + '/account', { headers: { cookie: cookies.header() } });
    const sessionCsrf = csrfFrom(await account.text());
    const noCsrf = await fetch(app.base + `/api/auctions/${id}/bid`, {
      method: 'POST',
      headers: { cookie: cookies.header(), 'content-type': 'application/json' },
    });
    assert.equal(noCsrf.status, 403);
    assert.equal((await noCsrf.json() as { error: string }).error, 'csrf');
    const withCsrf = await fetch(app.base + `/api/auctions/${id}/bid`, {
      method: 'POST',
      headers: { cookie: cookies.header(), 'content-type': 'application/json', 'x-csrf-token': sessionCsrf, 'idempotency-key': 'csrf-bid' },
    });
    assert.equal(withCsrf.status, 200);
    const bearer = await bid(app.base, id, await bearerFor(app.pool, user), 'bearer-bid');
    assert.equal(bearer.status, 409);
    assert.equal(bearer.body.error, 'already_leading');
  } finally { await app.stop(); }
});

test('redis rate limits are shared by two instances', async () => {
  const name = await makeSchema();
  const limits = {
    login: { limit: 3, windowSec: 120 },
    bid: { limit: 2, windowSec: 120 },
    signup: { limit: 2, windowSec: 120 },
  };
  const a = await listenApp({ schema: name, config: { rateLimits: limits }, ratePrefix: name });
  const b = await listenApp({ schema: name, config: { rateLimits: limits }, ratePrefix: name });
  try {
    await createUser(a.pool, 'rate@t.test', 'Rate', 'pw1234', { verified: true });
    const cookies = jar();
    const page = await fetch(a.base + '/login');
    cookies.store(page);
    const token = csrfFrom(await page.text());
    const attempt = (base: string) => fetch(base + '/login', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookies.header() },
      body: new URLSearchParams({ email: 'rate@t.test', password: 'wrong-password', _csrf: token }),
    });
    assert.equal((await attempt(a.base)).status, 401);
    assert.equal((await attempt(b.base)).status, 401);
    assert.equal((await attempt(a.base)).status, 401);
    const blocked = await attempt(b.base);
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get('retry-after'));

    const [user] = await mkUsers(a.pool, 1, 'rlb');
    await a.engine.grant(user, 5, 'test');
    const tokenB = await bearerFor(a.pool, user);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await mkAuction(a.pool, Date.now() - 1000, Date.now() + 90_000));
    assert.equal((await bid(a.base, ids[0], tokenB, 'r1')).status, 200);
    assert.equal((await bid(b.base, ids[1], tokenB, 'r2')).status, 200);
    const third = await bid(a.base, ids[2], tokenB, 'r3');
    assert.equal(third.status, 429);
    assert.equal(third.body.error, 'rate_limited');
    const balance = (await a.pool.query('SELECT balance FROM users WHERE id = $1', [user])).rows[0].balance;
    assert.equal(balance, 3);
  } finally {
    await b.stop(false);
    await a.stop(false);
    await dropSchema(name);
  }
});

test('email verification and password reset tokens expire and are single use', async () => {
  const app = await listenApp({ config: { demoMode: true, signupBonusCredits: 20 } });
  try {
    const cookies = jar();
    const signupPage = await fetch(app.base + '/signup');
    cookies.store(signupPage);
    const csrf = csrfFrom(await signupPage.text());
    const created = await fetch(app.base + '/signup', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookies.header() },
      body: new URLSearchParams({ email: 'new@t.test', name: 'New', password: 'correct-horse', _csrf: csrf }),
    });
    assert.equal(created.status, 302);
    cookies.store(created);
    const user = (await app.pool.query('SELECT * FROM users WHERE email = $1', ['new@t.test'])).rows[0];
    assert.equal(user.email_verified_at, null);
    const id = await mkAuction(app.pool, Date.now() - 1000, Date.now() + 60_000);
    const early = await bid(app.base, id, await bearerFor(app.pool, user.id), 'before-verify');
    assert.equal(early.body.error, 'email_unverified');
    const mail = (await app.pool.query(`SELECT body FROM mail_outbox WHERE to_email = $1 ORDER BY id DESC LIMIT 1`, ['new@t.test'])).rows[0].body as string;
    const token = mail.match(/token=([A-Za-z0-9_-]+)/)![1];
    const verified = await fetch(app.base + '/verify-email?token=' + token);
    assert.equal(verified.status, 200);
    assert.match(await verified.text(), /Email verified/);
    const again = await fetch(app.base + '/verify-email?token=' + token);
    assert.equal(again.status, 400);
    const balance = (await app.pool.query('SELECT balance, email_verified_at FROM users WHERE id = $1', [user.id])).rows[0];
    assert.ok(balance.email_verified_at);
    assert.equal(balance.balance, 20);
    assert.equal((await bid(app.base, id, await bearerFor(app.pool, user.id), 'after-verify')).body.ok, true);

    const forgotCookies = jar();
    const forgotPage = await fetch(app.base + '/forgot');
    forgotCookies.store(forgotPage);
    const forgotCsrf = csrfFrom(await forgotPage.text());
    const forgot = await fetch(app.base + '/forgot', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: forgotCookies.header() },
      body: new URLSearchParams({ email: 'new@t.test', _csrf: forgotCsrf }),
    });
    assert.match(await forgot.text(), /If an account exists/);
    const hidden = await fetch(app.base + '/forgot', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: forgotCookies.header() },
      body: new URLSearchParams({ email: 'nobody@t.test', _csrf: forgotCsrf }),
    });
    assert.match(await hidden.text(), /If an account exists/);
    const resetMail = (await app.pool.query(`SELECT body FROM mail_outbox WHERE to_email = $1 AND subject LIKE 'Reset%' ORDER BY id DESC LIMIT 1`, ['new@t.test'])).rows[0].body as string;
    const resetToken = resetMail.match(/token=([A-Za-z0-9_-]+)/)![1];
    const resetPage = await fetch(app.base + '/reset-password?token=' + resetToken);
    const resetCookies = jar();
    resetCookies.store(resetPage);
    const resetCsrf = csrfFrom(await resetPage.text());
    const reset = await fetch(app.base + '/reset-password', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: resetCookies.header() },
      body: new URLSearchParams({ token: resetToken, password: 'brand-new-password', _csrf: resetCsrf }),
    });
    assert.equal(reset.status, 302);
    const reuse = await fetch(app.base + '/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: resetCookies.header() },
      body: new URLSearchParams({ token: resetToken, password: 'another-password', _csrf: resetCsrf }),
    });
    assert.equal(reuse.status, 400);
    const oldLogin = await login(app.base, 'new@t.test', 'correct-horse');
    assert.equal(oldLogin.res.status, 401);
    const newLogin = await login(app.base, 'new@t.test', 'brand-new-password');
    assert.equal(newLogin.res.status, 302);

    const expiredCookies = jar();
    const expiredPage = await fetch(app.base + '/forgot');
    expiredCookies.store(expiredPage);
    const expiredCsrf = csrfFrom(await expiredPage.text());
    await fetch(app.base + '/forgot', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: expiredCookies.header() },
      body: new URLSearchParams({ email: 'new@t.test', _csrf: expiredCsrf }),
    });
    await app.pool.query(`UPDATE email_tokens SET expires_at = 1 WHERE purpose = 'reset' AND used_at IS NULL`);
    const staleMail = (await app.pool.query(`SELECT body FROM mail_outbox WHERE to_email = $1 AND subject LIKE 'Reset%' ORDER BY id DESC LIMIT 1`, ['new@t.test'])).rows[0].body as string;
    const stale = staleMail.match(/token=([A-Za-z0-9_-]+)/)![1];
    const staleRes = await fetch(app.base + '/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: expiredCookies.header() },
      body: new URLSearchParams({ token: stale, password: 'should-not-stick', _csrf: expiredCsrf }),
    });
    assert.equal(staleRes.status, 400);
    assert.equal((await login(app.base, 'new@t.test', 'brand-new-password')).res.status, 302);
  } finally { await app.stop(); }
});
