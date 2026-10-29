import { chromium, Browser, Page } from 'playwright';
import { Client } from 'pg';
import fs from 'fs';

const base = process.env.BASE || 'http://127.0.0.1:4317';
const desktop = { width: 1440, height: 900 };
const mobile = { width: 390, height: 844 };

async function shot(page: Page, file: string) {
  await page.screenshot({ path: file, fullPage: true });
  console.log('saved', file);
}

async function login(page: Page, email: string, password: string) {
  await page.goto(base + '/login', { waitUntil: 'networkidle' });
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 10000 }),
    page.click('button[type=submit]'),
  ]);
}

async function main() {
  fs.mkdirSync('screenshots', { recursive: true });
  const db = new Client({ connectionString: process.env.DATABASE_URL || 'postgres://penny:penny@127.0.0.1:5432/penny' });
  await db.connect();
  const live = await db.query(
    `SELECT a.id FROM auctions a WHERE a.closed = FALSE AND a.start_at <= $1 ORDER BY a.end_at LIMIT 1`,
    [Date.now()],
  );
  const liveId = live.rows[0]?.id as number;
  if (!liveId) throw new Error('no live auction to photograph');
  const win = await db.query(
    `SELECT a.id FROM auctions a JOIN users u ON u.id = a.winner_id
      WHERE u.email = 'alice@demo.test' AND a.checkout_status = 'pending' ORDER BY a.id LIMIT 1`,
  );
  const winId = win.rows[0]?.id as number;
  if (!winId) throw new Error('alice has no pending checkout');
  const armCountdown = async () => {
    const updated = await db.query(
      'UPDATE auctions SET end_at = $1 WHERE id = $2 AND closed = FALSE',
      [Date.now() + 9_000, liveId],
    );
    if (!updated.rowCount) throw new Error('live auction already closed');
  };

  const browser: Browser = await chromium.launch();
  const home = await browser.newContext({ viewport: desktop });
  const guest = await home.newPage();
  await guest.goto(base + '/', { waitUntil: 'networkidle' });
  const homeText = await guest.locator('body').innerText();
  if (!homeText.includes('Sign up for free demo bids')) throw new Error('missing signup CTA');
  if (!homeText.includes('Sample content')) throw new Error('demo homepage missing sample label');
  if (!homeText.includes('How it works') && !homeText.includes('Three moves')) throw new Error('missing how it works');
  await shot(guest, 'screenshots/homepage-desktop.png');
  await guest.setViewportSize(mobile);
  await guest.reload({ waitUntil: 'networkidle' });
  await guest.locator('.sticky-cta').waitFor();
  await shot(guest, 'screenshots/homepage-mobile.png');

  await guest.setViewportSize(desktop);
  await guest.goto(base + '/signup', { waitUntil: 'networkidle' });
  await shot(guest, 'screenshots/signup-desktop.png');
  await guest.setViewportSize(mobile);
  await shot(guest, 'screenshots/signup-mobile.png');

  const email = `shot${Date.now()}@demo.test`;
  await guest.setViewportSize(desktop);
  await guest.fill('input[name=name]', 'Screenshot');
  await guest.fill('input[name=email]', email);
  await guest.fill('input[name=password]', 'screenshot1');
  await Promise.all([
    guest.waitForURL(/\/account/, { timeout: 10000 }),
    guest.click('button[type=submit]'),
  ]);
  if (!(await guest.locator('body').innerText()).includes('Verify your email')) {
    throw new Error('signup did not land on the verify banner');
  }

  const watch = await browser.newContext({ viewport: desktop });
  const watcher = await watch.newPage();
  await watcher.goto(base + '/auction/' + liveId, { waitUntil: 'networkidle' });
  await watcher.click('#bid-btn-guest');
  await watcher.locator('#signup-prompt').waitFor();
  if (!(await watcher.locator('#signup-prompt').innerText()).includes('Sign up for free demo bids')) {
    throw new Error('guest bid did not open the signup prompt');
  }
  await watcher.keyboard.press('Escape');

  const aliceCtx = await browser.newContext({ viewport: desktop });
  const alice = await aliceCtx.newPage();
  await login(alice, 'alice@demo.test', 'demo123');
  await armCountdown();
  await alice.goto(base + '/auction/' + liveId, { waitUntil: 'networkidle' });
  await alice.waitForTimeout(600);
  const urgent = await alice.locator('#countdown').evaluate((el) => el.classList.contains('urgent'));
  if (!urgent) throw new Error('countdown did not enter the final-seconds state');
  await alice.click('#bid-btn');
  await alice.locator('#bid-msg').waitFor();
  const msg = await alice.locator('#bid-msg').innerText();
  if (!/Bid placed|already/i.test(msg)) throw new Error('bid click produced: ' + msg);
  await shot(alice, 'screenshots/auction-desktop.png');
  await alice.setViewportSize(mobile);
  await armCountdown();
  await alice.reload({ waitUntil: 'networkidle' });
  await shot(alice, 'screenshots/auction-mobile.png');

  await alice.setViewportSize(desktop);
  await alice.goto(base + '/account', { waitUntil: 'networkidle' });
  if (!(await alice.locator('body').innerText()).includes('Credit ledger')) throw new Error('account ledger missing');
  await shot(alice, 'screenshots/account-desktop.png');
  await alice.setViewportSize(mobile);
  await shot(alice, 'screenshots/account-mobile.png');

  await alice.setViewportSize(desktop);
  await alice.goto(base + '/checkout/' + winId, { waitUntil: 'networkidle' });
  if (!(await alice.locator('body').innerText()).includes('No card is charged') && !(await alice.locator('body').innerText()).includes('demo order')) {
    throw new Error('checkout does not explain that charging is off');
  }
  await shot(alice, 'screenshots/checkout-desktop.png');
  await alice.setViewportSize(mobile);
  await shot(alice, 'screenshots/checkout-mobile.png');
  await alice.setViewportSize(desktop);
  await alice.fill('input[name=line1]', '18 Mercer Street');
  await alice.fill('input[name=city]', 'New York');
  await alice.fill('input[name=region]', 'NY');
  await alice.fill('input[name=postal]', '10013');
  await Promise.all([
    alice.waitForURL(/\/account/, { timeout: 10000 }),
    alice.locator('form button', { hasText: 'Confirm demo order' }).click(),
  ]);

  const adminCtx = await browser.newContext({ viewport: desktop });
  const admin = await adminCtx.newPage();
  await login(admin, 'admin@demo.test', 'admin123');
  await admin.goto(base + '/admin', { waitUntil: 'networkidle' });
  if (!(await admin.locator('body').innerText()).includes('Dashboard')) throw new Error('admin dashboard missing');
  await shot(admin, 'screenshots/admin-desktop.png');
  await admin.setViewportSize(mobile);
  await shot(admin, 'screenshots/admin-mobile.png');

  await admin.setViewportSize(desktop);
  await admin.goto(base + '/admin/shipments', { waitUntil: 'networkidle' });
  if (!(await admin.locator('body').innerText()).includes('Shipments')) throw new Error('shipments page missing');
  await shot(admin, 'screenshots/admin-shipments-desktop.png');
  await admin.setViewportSize(mobile);
  await shot(admin, 'screenshots/admin-shipments-mobile.png');

  await admin.setViewportSize(desktop);
  await admin.goto(base + '/admin/disputes', { waitUntil: 'networkidle' });
  if (!(await admin.locator('body').innerText()).includes('Timer looked stuck')) throw new Error('seeded dispute missing');
  await shot(admin, 'screenshots/admin-disputes-desktop.png');
  await admin.setViewportSize(mobile);
  await shot(admin, 'screenshots/admin-disputes-mobile.png');

  await db.end();
  await browser.close();
  console.log('verified and saved screenshots');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
