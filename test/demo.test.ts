import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_TESTIMONIALS } from '../src/sampleContent';
import { listenApp } from './helpers';

const SAMPLE = SAMPLE_TESTIMONIALS[0].body;
const REAL = 'REAL_REVIEW_ALPHA the drop was legitimate.';

test('sample testimonials and the sample label never render when demo mode is off', async () => {
  const app = await listenApp({ config: { demoMode: false }, seed: false });
  try {
    const now = Date.now();
    await app.pool.query(
      `INSERT INTO testimonials (display_name, body, rating, status, is_sample, created_at)
       VALUES ('Jordan', $1, 5, 'approved', TRUE, $2), ('Ava', $3, 5, 'approved', FALSE, $2)`,
      [SAMPLE, now, REAL],
    );
    const html = await (await fetch(app.base + '/')).text();
    const auction = await fetch(app.base + '/auction/1');
    const social = await (await fetch(app.base + '/api/social?demoMode=true')).json() as {
      demoMode: boolean;
      testimonials: { body: string; is_sample: boolean }[];
    };
    assert.equal(html.includes(SAMPLE), false);
    assert.equal(html.includes('Sample content'), false);
    assert.equal(html.includes(REAL), true);
    assert.equal(html.includes('data-sample="1"'), false);
    assert.equal(social.demoMode, false);
    assert.equal(social.testimonials.some((t) => t.is_sample), false);
    assert.equal(social.testimonials.some((t) => t.body === SAMPLE), false);
    assert.equal(social.testimonials.some((t) => t.body === REAL), true);
    assert.notEqual(auction.status, 500);
  } finally { await app.stop(); }
});

test('demo mode shows sample testimonials and stats with a visible sample label', async () => {
  const app = await listenApp({ config: { demoMode: true }, seed: true });
  try {
    const html = await (await fetch(app.base + '/')).text();
    assert.equal(html.includes('Sample content'), true);
    assert.equal(html.includes(SAMPLE), true);
    assert.match(html, /data-sample="1"[\s\S]*Sample content/);
    assert.match(html, /data-sample-stats="1"/);
    const social = await (await fetch(app.base + '/api/social')).json() as {
      demoMode: boolean;
      stats: { members: number; bids: number; wins: number };
      testimonials: { is_sample: boolean; body: string }[];
    };
    assert.equal(social.demoMode, true);
    assert.ok(social.stats.members >= 3);
    assert.ok(social.stats.bids >= 1);
    assert.ok(social.stats.wins >= 1);
    assert.ok(social.testimonials.some((t) => t.is_sample && t.body === SAMPLE));
    const rules = await (await fetch(app.base + '/legal/rules')).text();
    const terms = await (await fetch(app.base + '/legal/terms')).text();
    const refunds = await (await fetch(app.base + '/legal/refunds')).text();
    const privacy = await (await fetch(app.base + '/legal/privacy')).text();
    for (const doc of [rules, terms, refunds, privacy]) assert.match(doc, /DRAFT FOR LEGAL REVIEW/);
    assert.match(rules, /\$0\.01/);
    assert.match(rules, /10 seconds/);
    assert.match(rules, /\$7\.99/);
  } finally { await app.stop(); }
});
