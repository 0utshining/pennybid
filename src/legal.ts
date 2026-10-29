import { Config } from './config';

const money = (cents: number) => '$' + (cents / 100).toFixed(2);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export type LegalDoc = { slug: string; title: string; html: string };

function shell(title: string, body: string, cfg: Config): string {
  return `<p class="draft-banner"><strong>DRAFT FOR LEGAL REVIEW.</strong> Version ${cfg.legalDraftVersion}. This page is generated from the live rules config and is not in effect. It is not legal advice. Have counsel review it for every jurisdiction you operate in before launch. Penny auctions are regulated as gambling or sweepstakes in some places.</p>
<h1>${title}</h1>
${body}
<p class="muted">Operator: ${esc(cfg.companyName)}. Contact: ${esc(cfg.supportEmail)}. Governing-law placeholder: ${esc(cfg.jurisdiction)}. Payments enabled: ${cfg.paymentsEnabled ? 'yes' : 'no'}.</p>`;
}

export function legalDocs(cfg: Config): LegalDoc[] {
  const bid = `${cfg.creditsPerBid} credit${cfg.creditsPerBid === 1 ? '' : 's'}`;
  const nominal = money(cfg.nominalBidPriceCents);
  const inc = money(cfg.priceIncrementCents);
  const ship = money(cfg.shippingCents);
  const resetS = cfg.resetThresholdMs / 1000;
  const resetTo = cfg.resetToMs / 1000;
  const packs = cfg.bidPacks.map((n) => `${n} credits (nominal ${money(n * cfg.nominalBidPriceCents)})`).join(', ');
  const email = esc(cfg.supportEmail);
  const law = esc(cfg.jurisdiction);
  const site = esc(cfg.siteName);

  const terms = shell('Terms of use', `
<h2>1. Who may use ${site}</h2>
<p>You must be an adult in your place of residence and able to form a contract. You are responsible for the activity on your account. We may refuse service, close an account, or void an auction where we believe these terms, the auction rules, or the law require it.</p>
<h2>2. What this service is</h2>
<p>${esc(cfg.siteName)} runs bidding-fee auctions. A bid is not a bid in a traditional auction: each accepted bid spends ${bid} and raises the item price by ${inc}. Credits are a limited license to place bids. They are not stored value, a bank balance, or cash, except where a statute says otherwise.</p>
<p>The nominal price shown next to a credit (${nominal} per bid) is a reference price. ${cfg.paymentsEnabled
    ? 'Paid credit packs are sold only through the configured payment provider.'
    : '<strong>Real card charging is disabled.</strong> Until an approved processor is connected, credits issued by this deployment are free demo credits and are labeled as such in your ledger. Do not describe them to customers as a purchase.'}</p>
<h2>3. Accounts</h2>
<p>You must give a working email and verify it before bidding or checking out a win. You are responsible for keeping your password private. Tell ${email} if you believe the account is compromised.</p>
<h2>4. No promise that you will win</h2>
<p>Most bidders on a given auction will not win the item. Credits spent on accepted bids are consumed whether or not you win. The person who places the last accepted bid before the server clock reaches the deadline wins the right to buy the item at the final price plus shipping, subject to the refund and outage policy.</p>
<h2>5. Winner's purchase</h2>
<p>A win is an offer to purchase the item for the final auction price plus ${ship} shipping. You must complete checkout with a shippable address within the time we state on the win (default 72 hours). If you do not, we may re-list the item and the credits already spent stay spent. Title passes when we ship, or when we deliver a digital code, unless the law says otherwise.</p>
<h2>6. Acceptable use</h2>
<p>You will not attack the service, probe other accounts, automate bids in a way that bypasses the published rate limits, use another person's payment instrument, or harass staff or members. We log bids, sessions, and checkout events to operate and secure the service.</p>
<h2>7. Disputes with us</h2>
<p>Contact ${email} and open a ticket in your account first. This draft does not choose a court, class-action waiver, or arbitration clause — counsel must add one that is enforceable in ${law} and in the customer's location. Nothing here limits a non-waivable consumer right.</p>
<h2>8. Liability</h2>
<p>The service is provided as available. We do not warrant uninterrupted operation. Our liability for a voided or interrupted auction is limited to the remedy in the refund and outage policy (restoring credits spent on that auction, and cancelling a winner checkout that had not shipped). We are not liable for lost profits or for the gap between a final price and a retail price you hoped to save.</p>
<h2>9. Changes</h2>
<p>We may update these terms by posting a new version. If you keep bidding after the effective date, you accept the new version, except where the law requires affirmative consent. The current rules numbers are generated from configuration so the published rules match the engine.</p>
`, cfg);

  const rules = shell('Auction rules', `
<p>These are the rules the server enforces. The server clock is the only clock that counts. Your countdown is a display.</p>
<ul>
<li>Each accepted bid consumes <strong>${bid}</strong>. Nominal reference price: <strong>${nominal}</strong> per bid. ${cfg.paymentsEnabled ? 'That nominal price is what a credit pack is priced from.' : 'No card is charged for credits while payments are disabled.'}</li>
<li>Each accepted bid raises the price by <strong>${inc}</strong>.</li>
<li>A bid placed when less than <strong>${resetS} seconds</strong> remain resets the remaining time to <strong>${resetTo} seconds</strong>. A bid with ${resetS} seconds or more left does not move the deadline.</li>
<li>Bids that reach the server at or after the deadline are rejected and are not charged. The deadline is the <code>end_at</code> stored for that auction.</li>
<li>${cfg.allowConsecutiveBids ? 'The current high bidder may bid again.' : 'The current high bidder cannot bid again until someone else bids.'}</li>
<li>The winner is the user who placed the last accepted bid. If nobody bid, the auction closes with no winner and the item stays in inventory.</li>
<li>Exactly one close is recorded. Restarting the service, or running more than one server, does not close an auction twice and does not pick a second winner.</li>
<li>Placing the same bid twice (same idempotency key) charges one credit.</li>
<li>Winning price is the final auction price. Checkout adds <strong>${ship}</strong> flat shipping per item.</li>
<li>Credit pack sizes currently offered: ${packs}.</li>
<li>New accounts ${cfg.demoMode ? `receive ${cfg.signupBonusCredits} free demo credits after the email address is verified.` : 'do not receive free credits unless a promotion says so in writing.'}</li>
<li>Inventory for a won item is decremented once, when the auction closes with a winner.</li>
</ul>
<h2>Demo versus paid</h2>
<p>${cfg.demoMode
    ? 'This deployment is in demo mode. Credits, pack grants, and any testimonial marked “Sample content” are demonstration material. Sample content is not a customer statement and is not shown when demo mode is off.'
    : 'Demo mode is off. Counts on the site are aggregates of rows in this database. Testimonials marked as samples are not displayed.'}</p>
`, cfg);

  const refunds = shell('Refunds and outages', `
<h2>Credits</h2>
<p>Credits spent on an accepted bid are not refundable, except in the cases below. Credits still sitting on the account unused may be refunded to the original payment method where a real charge was taken, minus any non-refundable processing fee our processor keeps, within 14 days of purchase, if no bid has been placed with that pack. ${cfg.paymentsEnabled ? '' : 'No real charge is taken while payments are disabled, so there is nothing to refund to a card. Demo credits can be reversed by an operator in the ledger.'}</p>
<h2>When we void an auction</h2>
<p>We may void an auction if the item cannot be supplied, if a technical fault changed the outcome, if we reasonably believe bids were placed in breach of the rules, or if the law requires it. On a void we:</p>
<ul>
<li>restore every credit spent on accepted bids in that auction, as a ledger credit;</li>
<li>cancel a winner checkout that has not shipped, and refund any amount actually captured for that order;</li>
<li>do not restore credits for other auctions.</li>
</ul>
<h2>Outages</h2>
<p>If the service is unavailable, or rejects bids, during the final ${resetS} seconds of an auction because of a failure on our side (not your network), we will void that auction and restore the credits bid on it. We decide this from server logs and the auction event record. A client countdown that disagrees with the server is not an outage.</p>
<p>Scheduled maintenance announced at least 12 hours ahead is not an outage. Auctions that would end inside that window are extended or rescheduled, and the new deadline is shown on the auction.</p>
<h2>Winner orders</h2>
<p>If we cannot ship the item you won, we cancel the order, refund any amount captured for the item and shipping, and restore the inventory unit. Credits you spent bidding are restored only when we void the auction under the section above, not merely because you changed your mind after winning.</p>
<h2>Chargebacks</h2>
<p>A chargeback on a credit pack may cause us to freeze the account, reverse the credits, and void auctions those credits won, to the extent the law allows. Contact ${email} before disputing a charge so we can refund a qualifying order directly.</p>
<h2>How to ask</h2>
<p>Open a dispute from your account, or email ${email}. Include the auction number. We aim to answer within 5 business days. This timeline is a target, not a statutory deadline.</p>
`, cfg);

  const privacy = shell('Privacy notice', `
<h2>Who we are</h2>
<p>${esc(cfg.companyName)} operates ${esc(cfg.siteName)}. Privacy contact: ${esc(cfg.supportEmail)}. This draft describes what this software actually stores. Counsel must add the legal basis, international transfer terms, and any state-specific notice (including CCPA/CPRA “sale” and “share” language) before it is shown as a live policy.</p>
<h2>Data we store</h2>
<ul>
<li><strong>Account:</strong> name, email, password hash (argon2id), email verification time, admin flag.</li>
<li><strong>Session:</strong> a hash of the session token, a CSRF token, expiry, IP address, and user agent.</li>
<li><strong>Bids and ledger:</strong> every accepted bid and every credit change. These tables are append-only so the history of a balance can be audited. We do not delete individual bid rows on request if we must keep them to show that an auction was fair; we can delete or anonymize the display name where the law requires and the accounting record can survive.</li>
<li><strong>Orders and shipping:</strong> address, order status, shipment tracking, refunds.</li>
<li><strong>Disputes and reviews:</strong> the text you submit. Reviews are public only after a moderator approves them. Sample reviews seeded for a demo are labeled and are not shown when demo mode is off.</li>
<li><strong>Mail:</strong> a copy of verification and password-reset emails is kept in an operator outbox so a misconfigured mail server can be debugged. Restrict admin access.</li>
<li><strong>Security logs:</strong> request id, path, status, and error messages. We do not log passwords or session tokens.</li>
</ul>
<h2>Cookies</h2>
<p>We set a first-party session cookie (<code>pb_sid</code>, HttpOnly, SameSite=Lax) and a CSRF cookie (<code>pb_csrf</code>, SameSite=Lax). They are not advertising cookies. ${process.env.COOKIE_SECURE === '1' ? 'The secure flag is on.' : 'Set COOKIE_SECURE=1 behind HTTPS.'}</p>
<h2>Why we use it</h2>
<p>To run auctions, take checkout details, prevent fraud and duplicate bids, send the emails you asked for (verification, password reset), moderate reviews, and ship a won item. We do not sell personal information. This draft does not authorize selling or “sharing” for cross-context advertising.</p>
<h2>Processors</h2>
<p>The database, Redis, the host, and — only once payments are enabled — the payment processor you configure, will handle data on our behalf. ${cfg.paymentsEnabled ? 'Payments are enabled; name the processor in this paragraph before launch.' : 'Payments are disabled, so no card data is collected by this application. The mock provider does not accept card numbers.'}</p>
<h2>Retention</h2>
<p>Account data is kept while the account is open and for up to 24 months after closure, unless a longer period is required for tax, chargebacks, or a legal claim. Append-only bid and ledger rows are kept for 7 years as accounting records unless counsel sets a different period. Mail outbox rows may be deleted after 90 days.</p>
<h2>Your requests</h2>
<p>Email ${email} to access, correct, or delete account data, or to object. We will verify the request against the account email. You may also lodge a complaint with a regulator. This draft does not list a supervisory authority — add one.</p>
<h2>Children</h2>
<p>The service is not for anyone under 18. We delete an account we learn belongs to a child.</p>
`, cfg);

  return [
    { slug: 'terms', title: 'Terms of use', html: terms },
    { slug: 'rules', title: 'Auction rules', html: rules },
    { slug: 'refunds', title: 'Refunds and outages', html: refunds },
    { slug: 'privacy', title: 'Privacy notice', html: privacy },
  ];
}

export function legalBySlug(cfg: Config, slug: string): LegalDoc | undefined {
  return legalDocs(cfg).find((d) => d.slug === slug);
}
