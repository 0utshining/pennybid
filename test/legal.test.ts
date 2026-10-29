import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legalDocs } from '../src/legal';
import { loadConfig } from '../src/config';

test('legal pages are generated from config and marked draft', () => {
  const cfg = loadConfig({
    paymentsEnabled: false,
    demoMode: false,
    priceIncrementCents: 1,
    resetThresholdMs: 10_000,
    shippingCents: 799,
    companyName: 'Example <Co>',
  });
  const docs = legalDocs(cfg);
  assert.deepEqual(docs.map((d) => d.slug), ['terms', 'rules', 'refunds', 'privacy']);
  for (const doc of docs) {
    assert.match(doc.html, /DRAFT FOR LEGAL REVIEW/);
    assert.match(doc.html, /not in effect/);
    assert.equal(doc.html.includes('<Co>'), false);
    assert.match(doc.html, /Example &lt;Co&gt;/);
  }
  const rules = docs.find((d) => d.slug === 'rules')!;
  assert.match(rules.html, /\$0\.01/);
  assert.match(rules.html, /10 seconds/);
  assert.match(rules.html, /\$7\.99/);
  assert.match(rules.html, /Demo mode is off/);
});
