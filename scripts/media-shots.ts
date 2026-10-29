import { chromium } from 'playwright';
import { Client } from 'pg';
import fs from 'fs';

const base = process.env.BASE || 'http://127.0.0.1:4317';

async function login(page: import('playwright').Page, email: string, password: string) {
  await page.goto(base + '/login', { waitUntil: 'networkidle' });
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.endsWith('/login')),
    page.click('button.btn-cta'),
  ]);
}

async function main() {
  fs.mkdirSync('screenshots', { recursive: true });
  const db = new Client({ connectionString: process.env.DATABASE_URL || 'postgres://penny:penny@127.0.0.1:5432/penny' });
  await db.connect();
  const auction = await db.query(
    `SELECT a.id, a.product_id FROM auctions a
      JOIN product_media m ON m.product_id = a.product_id
      WHERE a.closed = FALSE
      GROUP BY a.id
      ORDER BY COUNT(*) DESC, a.id
      LIMIT 1`,
  );
  const id = auction.rows[0]?.id as number;
  const productId = auction.rows[0]?.product_id as number;
  if (!id) throw new Error('no auction with media');
  await db.end();

  const browser = await chromium.launch();
  const desktop = { width: 1440, height: 900 };
  const mobile = { width: 390, height: 844 };

  const home = await (await browser.newContext({ viewport: desktop })).newPage();
  await home.goto(base + '/', { waitUntil: 'networkidle' });
  const live = home.locator('#live');
  await live.waitFor();
  if ((await live.locator('.card-media img').count()) < 1) throw new Error('homepage cards have no images');
  await live.screenshot({ path: 'screenshots/homepage-cards-desktop.png' });
  await home.screenshot({ path: 'screenshots/homepage-desktop.png', fullPage: true });
  await home.setViewportSize(mobile);
  await home.reload({ waitUntil: 'networkidle' });
  await home.screenshot({ path: 'screenshots/homepage-mobile.png', fullPage: true });

  const page = await (await browser.newContext({ viewport: desktop })).newPage();
  await page.goto(`${base}/auction/${id}`, { waitUntil: 'networkidle' });
  await page.locator('[data-gallery]').waitFor();
  const alt = await page.locator('#main-img').getAttribute('alt');
  if (!alt) throw new Error('gallery image missing alt text');
  await page.screenshot({ path: 'screenshots/gallery-desktop.png', fullPage: true });
  await page.locator('[data-lightbox-open]').click();
  await page.locator('[data-lightbox]').waitFor();
  await page.screenshot({ path: 'screenshots/lightbox-desktop.png', fullPage: true });
  await page.keyboard.press('Escape');
  await page.setViewportSize(mobile);
  await page.reload({ waitUntil: 'networkidle' });
  await page.screenshot({ path: 'screenshots/gallery-mobile.png', fullPage: true });

  const admin = await (await browser.newContext({ viewport: desktop })).newPage();
  await login(admin, 'admin@demo.test', 'admin123');
  await admin.goto(`${base}/admin/products/${productId}/media`, { waitUntil: 'networkidle' });
  if (!(await admin.locator('body').innerText()).includes('Drop images or videos')) throw new Error('media manager missing');
  await admin.screenshot({ path: 'screenshots/admin-media-desktop.png', fullPage: true });
  await admin.setViewportSize(mobile);
  await admin.screenshot({ path: 'screenshots/admin-media-mobile.png', fullPage: true });

  await browser.close();
  console.log('media screenshots saved', { auction: id, productId });
}

main().catch((err) => { console.error(err); process.exit(1); });
