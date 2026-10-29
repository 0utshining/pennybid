import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUser } from '../src/auth';
import { parseEmbed } from '../src/media';
import { csrfFrom, listenApp } from './helpers';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function adminJar(app: Awaited<ReturnType<typeof listenApp>>) {
  await createUser(app.pool, 'media-admin@t.test', 'Media', 'pw1234', { isAdmin: true, verified: true });
  const page = await fetch(app.base + '/login');
  const token = csrfFrom(await page.text());
  const cookies = new Map<string, string>();
  for (const raw of page.headers.getSetCookie()) {
    const pair = raw.split(';')[0];
    const i = pair.indexOf('=');
    cookies.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const login = await fetch(app.base + '/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    body: new URLSearchParams({ email: 'media-admin@t.test', password: 'pw1234', _csrf: token }),
  });
  for (const raw of login.headers.getSetCookie()) {
    const pair = raw.split(';')[0];
    const i = pair.indexOf('=');
    cookies.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const header = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const mediaPage = async (id: number) => {
    const res = await fetch(`${app.base}/admin/products/${id}/media`, { headers: { cookie: header } });
    const html = await res.text();
    return { res, html, csrf: csrfFrom(html) };
  };
  return { header, mediaPage };
}

test('embed URLs only accept YouTube and Vimeo', () => {
  assert.equal(parseEmbed('https://www.youtube.com/watch?v=abcdefghijk')?.embedUrl, 'https://www.youtube-nocookie.com/embed/abcdefghijk');
  assert.equal(parseEmbed('https://vimeo.com/1234567')?.provider, 'vimeo');
  assert.equal(parseEmbed('https://evil.example/watch?v=abcdefghijk'), null);
  assert.equal(parseEmbed('http://youtube.com/watch?v=abcdefghijk'), null);
});

test('uploads are validated, ordered, and a single cover is enforced', async () => {
  const app = await listenApp();
  try {
    const { header, mediaPage } = await adminJar(app);
    const product = await app.pool.query(
      `INSERT INTO products (name, description, retail_cents, inventory, images, created_at)
       VALUES ('Demo Can', '', 1000, 1, '[]'::jsonb, $1) RETURNING id`,
      [Date.now()],
    );
    const id = product.rows[0].id as number;
    const page = await mediaPage(id);

    const bad = new FormData();
    bad.set('_csrf', page.csrf);
    bad.set('alt', 'Not an image');
    bad.set('files', new Blob([Buffer.from('hello world')], { type: 'image/png' }), 'note.png');
    const rejected = await fetch(`${app.base}/admin/products/${id}/media`, { method: 'POST', headers: { cookie: header }, body: bad });
    assert.equal(rejected.status, 400);
    assert.match(await rejected.text(), /PNG, JPEG, WebP, GIF/);

    const missingAlt = new FormData();
    missingAlt.set('_csrf', page.csrf);
    missingAlt.set('alt', '   ');
    missingAlt.set('files', new Blob([PNG], { type: 'image/png' }), 'one.png');
    const noAlt = await fetch(`${app.base}/admin/products/${id}/media`, { method: 'POST', headers: { cookie: header }, body: missingAlt });
    assert.equal(noAlt.status, 400);
    assert.match(await noAlt.text(), /Alt text is required/);

    const upload = async (name: string) => {
      const fresh = await mediaPage(id);
      const body = new FormData();
      body.set('_csrf', fresh.csrf);
      body.set('alt', `Demo can, ${name}`);
      body.set('files', new Blob([PNG], { type: 'image/png' }), name);
      const res = await fetch(`${app.base}/admin/products/${id}/media`, { method: 'POST', redirect: 'manual', headers: { cookie: header }, body });
      assert.equal(res.status, 302, await res.text());
    };
    await upload('one.png');
    await upload('two.png');
    let rows = (await app.pool.query('SELECT id, alt, is_cover, sort_order, url, variants FROM product_media WHERE product_id = $1 ORDER BY sort_order', [id])).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((r) => r.is_cover).length, 1);
    assert.equal(rows[0].is_cover, true);
    assert.match(rows[0].url, /\.webp$/);
    assert.ok(rows[0].variants.thumb);
    assert.ok(rows[0].variants.lg);

    const manager = await mediaPage(id);
    const second = rows[1].id as number;
    const cover = await fetch(`${app.base}/admin/products/${id}/media/${second}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: header, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: manager.csrf, action: 'cover', alt: rows[1].alt }),
    });
    assert.equal(cover.status, 302);
    rows = (await app.pool.query('SELECT id, is_cover FROM product_media WHERE product_id = $1 ORDER BY sort_order', [id])).rows;
    assert.deepEqual(rows.map((r) => r.is_cover), [false, true]);

    const order = await fetch(`${app.base}/admin/products/${id}/media/reorder`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: header, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: manager.csrf, order: `${rows[1].id},${rows[0].id}` }),
    });
    assert.equal(order.status, 302);
    const ordered = (await app.pool.query('SELECT id FROM product_media WHERE product_id = $1 ORDER BY sort_order', [id])).rows.map((r) => r.id);
    assert.deepEqual(ordered, [rows[1].id, rows[0].id]);

    const auction = await app.pool.query(
      'INSERT INTO auctions (product_id, start_at, end_at, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
      [id, Date.now() - 1000, Date.now() + 60_000, Date.now()],
    );
    const html = await (await fetch(`${app.base}/auction/${auction.rows[0].id}`)).text();
    assert.match(html, /data-gallery/);
    assert.match(html, /srcset=/);
    assert.match(html, /Demo can, two/);
    assert.match(html, /property="og:image"/);
    assert.match(html, /name="twitter:image"/);
    assert.match(html, /aria-label="Open fullscreen gallery"/);
  } finally { await app.stop(); }
});
