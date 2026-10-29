import { Config } from './config';
import { SocialStats, PublicTestimonial } from './social';

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const money = (cents: number | null | undefined) => {
  const n = Number(cents ?? 0);
  return (n < 0 ? '-' : '') + '$' + (Math.abs(n) / 100).toFixed(2);
};
export const when = (ms: number | null | undefined) => ms
  ? new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) + ' ET'
  : '—';

export type Viewer = {
  id: number;
  name: string;
  email: string;
  balance: number;
  is_admin: boolean;
  email_verified_at: number | null;
} | null;

type Frame = { cfg: Config; csrf: string; user: Viewer; title: string; main: string; bare?: boolean; meta?: string };

export function page(f: Frame): string {
  const { cfg, user, csrf } = f;
  const demo = cfg.demoMode;
  const nav = user
    ? `<a href="/buy">Credits</a><a href="/account">Account <b class="bal" id="bal">${user.balance}</b></a>${user.is_admin ? '<a href="/admin">Admin</a>' : ''}
       <form method="post" action="/logout" class="inline">${csrfField(csrf)}<button class="link" type="submit">Log out</button></form>`
    : `<a href="/login">Log in</a><a class="btn btn-cta btn-small" href="/signup">Sign up for free demo bids</a>`;
  const banner = demo
    ? `<div class="demo-banner">Demo mode — credits are free demo credits. Real card charging is off. Anything marked as a sample is not a customer.</div>`
    : (!cfg.paymentsEnabled ? `<div class="pay-banner">Payments are disabled until an approved processor is connected. No cards are charged.</div>` : '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="csrf-token" content="${esc(csrf)}">
${demo ? '<meta name="robots" content="noindex">' : ''}
<title>${esc(f.title)} · ${esc(cfg.siteName)}</title>
${f.meta || ''}
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${banner}
<header class="site-header">
  <a class="logo" href="/">PENNY<span>BID</span></a>
  <nav aria-label="Primary">${nav}</nav>
</header>
<main id="main">${f.main}</main>
${!user ? `<div class="sticky-cta"><a class="btn btn-cta" href="/signup">Sign up for free demo bids</a></div>` : ''}
<footer class="site-footer">
  <nav aria-label="Legal">
    <a href="/legal/terms">Terms</a>
    <a href="/legal/rules">Auction rules</a>
    <a href="/legal/refunds">Refunds &amp; outages</a>
    <a href="/legal/privacy">Privacy</a>
  </nav>
  <p>Draft policies are for legal review and are not in effect. Server clock decides every auction.</p>
</footer>
<script src="/static/app.js"></script>
</body>
</html>`;
}

export const csrfField = (token: string) => `<input type="hidden" name="_csrf" value="${esc(token)}">`;

function safeImg(src: string): string {
  if (src.startsWith('/uploads/') || src.startsWith('/static/')) return esc(src);
  if (/^https:\/\/[^\s"'<>]+$/.test(src)) return esc(src);
  return '';
}

export type MediaView = {
  id: number;
  kind: 'image' | 'video' | 'embed';
  url: string;
  posterUrl: string | null;
  alt: string;
  isCover: boolean;
  isSpin: boolean;
  variants: { thumb?: string; sm?: string; md?: string; lg?: string };
};

function srcset(m: MediaView): string {
  const parts = [
    m.variants.sm ? `${m.variants.sm} 640w` : '',
    m.variants.md ? `${m.variants.md} 960w` : '',
    m.variants.lg ? `${m.variants.lg} 1600w` : '',
  ].filter(Boolean);
  return parts.join(', ');
}

function coverOf(media: MediaView[] | undefined, fallback: string[]): MediaView | null {
  if (media?.length) return media.find((m) => m.isCover) || media.find((m) => m.kind === 'image') || media[0];
  if (fallback[0]) return { id: 0, kind: 'image', url: fallback[0], posterUrl: null, alt: '', isCover: true, isSpin: false, variants: {} };
  return null;
}

function cardMedia(name: string, media: MediaView[] | undefined, fallback: string[], status: 'live' | 'upcoming' | 'closed'): string {
  const images = (media || []).filter((m) => m.kind === 'image');
  const cover = coverOf(media, fallback);
  const next = images.find((m) => m.url !== cover?.url);
  const video = (media || []).find((m) => m.kind === 'video');
  const src = cover ? (cover.variants.sm || cover.variants.lg || cover.posterUrl || cover.url) : '';
  const safe = safeImg(src);
  const set = cover ? srcset(cover) : '';
  const alt = esc(cover?.alt || name);
  return `<div class="card-media">
    ${safe ? `<img class="cover" src="${safe}" ${set ? `srcset="${esc(set)}" sizes="(max-width: 860px) 100vw, 320px"` : ''} alt="${alt}" loading="lazy" width="640" height="400">` : '<div class="ph" aria-hidden="true"></div>'}
    ${next ? `<img class="next" src="${safeImg(next.variants.sm || next.url)}" alt="" loading="lazy">` : ''}
    ${video ? `<video class="preview" muted loop playsinline preload="none" poster="${safeImg(video.posterUrl || '')}" data-src="${safeImg(video.url)}" aria-hidden="true"></video>` : ''}
    ${status === 'live' ? '<span class="media-badge live">LIVE</span><span class="media-badge final">Final seconds</span>' : ''}
    ${status === 'upcoming' ? '<span class="media-badge soon">Upcoming</span>' : ''}
  </div>`;
}

export type CardAuction = {
  id: number;
  name: string;
  images: string[] | unknown;
  media?: MediaView[];
  price_cents: number;
  retail_cents: number;
  end_at: number;
  start_at: number;
  closed: boolean;
  bid_count?: number;
};

function imgs(a: { images: unknown }): string[] {
  if (Array.isArray(a.images)) return a.images as string[];
  return [];
}

export function auctionCard(a: CardAuction): string {
  const t = Date.now();
  const status = a.closed ? 'closed' : t < a.start_at ? 'upcoming' : 'live';
  return `<a class="card" href="/auction/${a.id}">
    ${cardMedia(a.name, a.media, imgs(a), status)}
    <div class="card-body">
      <h3>${esc(a.name)}</h3>
      <div class="price" data-price="${a.id}">${money(a.price_cents)}</div>
      <div class="muted">Retail ${money(a.retail_cents)}</div>
      <div class="countdown" data-auction="${a.id}" data-end="${a.end_at}" data-start="${a.start_at}" data-closed="${a.closed ? '1' : '0'}"><span class="cd-text"></span> <span class="urgent-label"></span></div>
    </div>
  </a>`;
}

function statsStrip(stats: SocialStats, demo: boolean): string {
  const cells = [
    [stats.members.toLocaleString('en-US'), 'Members'],
    [stats.bids.toLocaleString('en-US'), 'Bids placed'],
    [stats.wins.toLocaleString('en-US'), 'Auctions won'],
    [money(stats.savedCents), 'Saved vs retail'],
  ];
  return `<section data-sample-stats="${demo ? '1' : '0'}" aria-label="Live totals from the database">
    ${demo ? '<p class="sample-badge">Sample content</p>' : ''}
    <div class="stats-strip">${cells.map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('')}</div>
  </section>`;
}

function quoteCard(t: PublicTestimonial): string {
  return `<article class="quote" data-sample="${t.is_sample ? '1' : '0'}">
    ${t.is_sample ? '<p class="sample-badge">Sample content</p>' : ''}
    <blockquote>${esc(t.body)}</blockquote>
    <p class="who">${esc(t.display_name)}${t.rating ? ` · ${t.rating}/5` : ''}</p>
  </article>`;
}

export function homePage(f: Omit<Frame, 'title' | 'main'> & {
  live: CardAuction[];
  upcoming: CardAuction[];
  won: { id: number; name: string; images: unknown; media?: MediaView[]; final_price_cents: number; retail_cents: number; winner: string | null }[];
  ticker: { text: string; at: number }[];
  stats: SocialStats;
  testimonials: PublicTestimonial[];
}): string {
  const { cfg } = f;
  const soon = f.live.slice(0, 3);
  const tickerItems = f.ticker.length ? f.ticker : [{ text: 'No bids yet — the tape starts with the first real bid.', at: 0 }];
  const loop = tickerItems.map((t) => `<li>${esc(t.text)}</li>`).join('');
  const cta = f.user
    ? `<a class="btn btn-cta" href="/#live">Jump into a live drop</a>`
    : `<a class="btn btn-cta" href="/signup">Sign up for free demo bids</a>`;
  const main = `
  <section class="hero">
    <div class="hero-copy">
      <p class="eyebrow"><span class="live-dot" aria-hidden="true"></span> Live bidding drops</p>
      <h1>Win the drop.<br><span class="grad">Pay pennies.</span></h1>
      <p class="lede">Every accepted bid is ${cfg.creditsPerBid} credit and lifts the price by ${money(cfg.priceIncrementCents)}. Inside the last ${cfg.resetThresholdMs / 1000} seconds the clock snaps back to ${cfg.resetToMs / 1000}. Last bidder takes the checkout.</p>
      <div class="hero-cta">${cta}<a class="btn btn-ghost" href="#how">How it works</a></div>
      <p class="fine">${cfg.demoMode ? `${cfg.signupBonusCredits} free demo credits after you verify your email. No card.` : 'Verify your email before you bid.'} Nominal reference ${money(cfg.nominalBidPriceCents)} per bid. ${cfg.paymentsEnabled ? '' : 'Real charging is off.'}</p>
    </div>
    <div class="hero-live">
      <h2>Ending soon</h2>
      <div class="stack">${soon.map(auctionCard).join('') || '<p class="empty">Nothing is live yet. Scheduled drops show up here the moment they start.</p>'}</div>
    </div>
  </section>
  <section class="ticker" aria-label="Recent bids and wins">
    <span class="ticker-label" id="conn">Live</span>
    <div class="marquee"><ul class="marquee-track" id="ticker">${loop}${loop}</ul></div>
  </section>
  ${statsStrip(f.stats, cfg.demoMode)}
  <section id="how" class="steps-wrap">
    <h2>Three moves. Then the clock is yours.</h2>
    <ol class="steps">
      <li><span>01</span><h3>Grab demo credits</h3><p>${cfg.demoMode ? `Sign up and verify your email. We drop ${cfg.signupBonusCredits} demo bids on the account. No card on file.` : 'Create an account and verify your email before the bid button will arm.'}</p></li>
      <li><span>02</span><h3>Bid the clock</h3><p>Each bid is ${money(cfg.priceIncrementCents)} on the price. With under ${cfg.resetThresholdMs / 1000}s left, the timer resets to ${cfg.resetToMs / 1000}s. You cannot outbid yourself.</p></li>
      <li><span>03</span><h3>Checkout the win</h3><p>Final price plus ${money(cfg.shippingCents)} shipping. ${cfg.paymentsEnabled ? 'The mock checkout stands in until a real processor is approved.' : 'In this build, confirming a win records an order and does not charge a card.'}</p></li>
    </ol>
  </section>
  <section id="live">
    <h2>Live now</h2>
    <div class="grid" data-live-grid>${f.live.map(auctionCard).join('') || '<p class="empty">No live auctions. Check upcoming — the board fills when an admin schedules a drop.</p>'}</div>
  </section>
  <section>
    <h2>Upcoming</h2>
    <div class="grid">${f.upcoming.map(auctionCard).join('') || '<p class="empty">Nothing on the calendar.</p>'}</div>
  </section>
  <section>
    <h2>Recently won</h2>
    <div class="showcase">${f.won.map((a) => {
      const saved = Math.max(0, a.retail_cents - a.final_price_cents);
      const pct = a.retail_cents > 0 ? Math.round((saved / a.retail_cents) * 100) : 0;
      const url = `${cfg.siteUrl}/auction/${a.id}`;
      return `<article class="won-card">
        <a href="/auction/${a.id}">${cardMedia(a.name, a.media, imgs(a), 'closed')}</a>
        <div>
          <h3><a href="/auction/${a.id}">${esc(a.name)}</a></h3>
          <p class="muted">Won by ${esc(a.winner || '—')}</p>
          <p class="vs"><b>${money(a.final_price_cents)}</b> <s class="retail-strike">${money(a.retail_cents)}</s> ${pct > 0 ? `<span class="save-chip">${pct}% under retail</span>` : ''}</p>
          <div class="share">
            <button type="button" class="btn btn-ghost btn-small" data-copy="${esc(url)}">Copy link</button>
            <a class="btn btn-ghost btn-small" target="_blank" rel="noopener noreferrer" href="https://twitter.com/intent/tweet?text=${encodeURIComponent(`${a.name} closed at ${money(a.final_price_cents)}`)}&url=${encodeURIComponent(url)}">Share</a>
          </div>
        </div>
      </article>`;
    }).join('') || '<p class="empty">No wins yet. The showcase fills from closed auctions only.</p>'}</div>
  </section>
  <section id="reviews">
    <h2>What people say</h2>
    ${f.testimonials.length ? `<div class="quotes">${f.testimonials.map(quoteCard).join('')}</div>` : '<p class="empty">No published reviews yet. Winners can leave one after checkout; it goes public only after moderation.</p>'}
  </section>`;
  return page({ ...f, title: 'Live drops', main });
}

function absUrl(site: string, src: string): string {
  if (!src) return '';
  if (src.startsWith('http://') || src.startsWith('https://')) return src;
  return site.replace(/\/$/, '') + (src.startsWith('/') ? src : '/' + src);
}

function galleryHtml(name: string, media: MediaView[]): string {
  const images = media.filter((m) => m.kind === 'image');
  const first = media[0];
  const cover = images.find((m) => m.isCover) || images[0] || first;
  if (!cover) {
    return `<div class="gallery"><div class="ph" aria-hidden="true"></div><p class="muted">No media yet.</p></div>`;
  }
  const spin = images.filter((m) => m.isSpin);
  const payload = media.map((m) => ({
    id: m.id,
    kind: m.kind,
    url: m.kind === 'image' ? (m.variants.lg || m.url) : m.url,
    poster: m.posterUrl || m.variants.lg || '',
    alt: m.alt,
    srcset: srcset(m),
    thumb: m.variants.thumb || m.posterUrl || m.url,
    spin: m.isSpin,
  }));
  const initial = payload.find((p) => p.id === cover.id) || payload[0];
  const thumbs = payload.map((m, i) => `<button type="button" class="thumb${m.id === initial.id ? ' is-active' : ''}" data-index="${i}" role="option" aria-selected="${m.id === initial.id ? 'true' : 'false'}" aria-label="${esc(m.alt)}">
      <img src="${safeImg(m.thumb)}" alt="" loading="lazy" width="120" height="80">
    </button>`).join('');
  return `<div class="gallery" data-gallery data-media="${esc(JSON.stringify(payload))}">
    <div class="stage">
      <img id="main-img" class="stage-img" src="${safeImg(initial.url)}" ${initial.srcset ? `srcset="${esc(initial.srcset)}" sizes="(max-width: 860px) 100vw, 640px"` : ''} alt="${esc(initial.alt || name)}" width="1600" height="1000">
      <video id="main-video" class="stage-video" controls playsinline preload="none" hidden></video>
      <iframe id="main-embed" class="stage-embed" title="" hidden allow="fullscreen; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin"></iframe>
      <div class="stage-tools">
        <button type="button" class="btn btn-ghost btn-small" data-zoom aria-pressed="false" aria-label="Toggle hover zoom">Zoom</button>
        <button type="button" class="btn btn-ghost btn-small" data-lightbox-open aria-label="Open fullscreen gallery">Fullscreen</button>
        ${spin.length >= 4 ? '<button type="button" class="btn btn-ghost btn-small" data-spin-toggle aria-pressed="false" aria-label="Show 360 spin">360</button>' : ''}
      </div>
      ${spin.length >= 4 ? `<label class="spin-label">Rotation <input type="range" data-spin-range min="0" max="${spin.length - 1}" value="0" aria-label="Rotate ${esc(name)}"></label>` : ''}
    </div>
    <div class="thumbs" role="listbox" aria-label="Product media">${thumbs}</div>
    <dialog class="lightbox" data-lightbox aria-label="Fullscreen product gallery">
      <div class="lightbox-bar">
        <button type="button" class="btn btn-ghost btn-small" data-lightbox-prev aria-label="Previous media">Previous</button>
        <p class="lightbox-count" data-lightbox-count></p>
        <button type="button" class="btn btn-ghost btn-small" data-lightbox-next aria-label="Next media">Next</button>
        <button type="button" class="btn btn-ghost btn-small" data-lightbox-close aria-label="Close fullscreen gallery">Close</button>
      </div>
      <img class="lightbox-img" alt="" data-lightbox-img>
      <video class="lightbox-video" controls playsinline hidden data-lightbox-video></video>
      <iframe class="lightbox-embed" title="" hidden allow="fullscreen; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" data-lightbox-embed></iframe>
      <p class="lightbox-alt" data-lightbox-alt></p>
    </dialog>
  </div>`;
}

export function auctionPage(f: Omit<Frame, 'title' | 'main'> & {
  auction: {
    id: number; name: string; description: string; retail_cents: number; images: unknown;
    media?: MediaView[];
    price_cents: number; end_at: number; start_at: number; closed: boolean; bid_count: number;
  };
}): string {
  const a = f.auction;
  const media: MediaView[] = a.media?.length ? a.media : imgs(a).map((url, i) => ({
    id: i + 1, kind: 'image' as const, url, posterUrl: null, alt: a.name, isCover: i === 0, isSpin: false, variants: {},
  }));
  const cover = media.find((m) => m.isCover && m.kind === 'image') || media.find((m) => m.kind === 'image');
  const image = cover ? absUrl(f.cfg.siteUrl, cover.variants.lg || cover.url) : '';
  const description = a.description || `${a.name} on ${f.cfg.siteName}`;
  const pageUrl = `${f.cfg.siteUrl}/auction/${a.id}`;
  const meta = `<meta property="og:type" content="website">
<meta property="og:title" content="${esc(a.name)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(pageUrl)}">
${image ? `<meta property="og:image" content="${esc(image)}">` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${esc(a.name)}">
<meta name="twitter:description" content="${esc(description)}">
${image ? `<meta name="twitter:image" content="${esc(image)}">` : ''}`;
  const verified = !!f.user?.email_verified_at;
  let bid: string;
  if (!f.user) {
    bid = `<button type="button" class="btn btn-cta bid-btn" id="bid-btn-guest">BID</button>
      <dialog id="signup-prompt">
        <h2>Sign up to bid</h2>
        <p>Watching is free. Bidding spends demo credits, and the button stays locked until you have an account.</p>
        <a class="btn btn-cta" href="/signup?next=${encodeURIComponent('/auction/' + a.id)}">Sign up for free demo bids</a>
        <form method="dialog"><button class="btn btn-ghost" type="submit">Keep watching</button></form>
      </dialog>`;
  } else if (!verified) {
    bid = `<a class="btn btn-cta bid-btn" href="/account">Verify your email to bid</a>`;
  } else {
    bid = `<button type="button" class="btn btn-cta bid-btn" id="bid-btn">BID · ${f.cfg.creditsPerBid} credit</button>`;
  }
  const url = `${f.cfg.siteUrl}/auction/${a.id}`;
  const main = `<div class="auction-layout" data-auction-page="${a.id}" data-user="${f.user?.id ?? ''}">
    ${galleryHtml(a.name, media)}
    <div class="panel">
      <p class="eyebrow">Auction #${a.id}</p>
      <h1>${esc(a.name)}</h1>
      <p>${esc(a.description)}</p>
      <p class="muted">Retail ${money(a.retail_cents)} · Shipping ${money(f.cfg.shippingCents)} · ${f.cfg.allowConsecutiveBids ? 'Leader may rebid' : 'Leader cannot rebid'}</p>
      <div class="big-price price" id="price" data-price="${a.id}">${money(a.price_cents)}</div>
      <div class="big-countdown countdown" id="countdown" data-auction="${a.id}" data-end="${a.end_at}" data-start="${a.start_at}" data-closed="${a.closed ? '1' : '0'}" role="timer"><span class="cd-text"></span> <span class="urgent-label"></span></div>
      <p id="leader" class="muted"></p>
      ${bid}
      <p id="bid-msg" class="msg" role="status"></p>
      <p class="muted small" id="conn">Connecting to the live feed…</p>
      <div id="winner-box"></div>
      <div class="share">
        <button type="button" class="btn btn-ghost btn-small" data-copy="${esc(url)}">Copy link</button>
        <a class="btn btn-ghost btn-small" target="_blank" rel="noopener noreferrer" href="https://twitter.com/intent/tweet?text=${encodeURIComponent(a.name + ' is live on PennyBid')}&url=${encodeURIComponent(url)}">Share</a>
      </div>
      <h2>Bid history <span class="muted" id="bidcount">(${a.bid_count})</span></h2>
      <ol id="history" class="history"></ol>
    </div>
  </div>`;
  return page({ ...f, title: a.name, main, meta });
}

function formCard(title: string, body: string, extra = ''): string {
  return `<div class="form-card"><h1>${title}</h1>${body}${extra}</div>`;
}

export function loginPage(f: Omit<Frame, 'title' | 'main'> & { error?: string; next?: string }): string {
  const main = formCard('Log in', `${f.error ? `<p class="err" role="alert">${esc(f.error)}</p>` : ''}
    <form method="post" action="/login">
      ${csrfField(f.csrf)}
      <input type="hidden" name="next" value="${esc(f.next || '/')}">
      <label class="field">Email<input name="email" type="email" autocomplete="username" required></label>
      <label class="field">Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn btn-cta" type="submit">Log in</button>
    </form>
    <p class="muted"><a href="/forgot">Forgot password</a> · <a href="/signup">Create an account</a></p>
    ${f.cfg.demoMode ? '<p class="muted small">Demo: alice@demo.test / demo123 · admin@demo.test / admin123</p>' : ''}`);
  return page({ ...f, title: 'Log in', main });
}

export function signupPage(f: Omit<Frame, 'title' | 'main'> & { error?: string }): string {
  const main = formCard('Create your account', `${f.error ? `<p class="err" role="alert">${esc(f.error)}</p>` : ''}
    <p class="lede">${f.cfg.demoMode ? `Verify your email and ${f.cfg.signupBonusCredits} demo bids land on the account. No card.` : 'Verify your email before the bid button arms.'}</p>
    <form method="post" action="/signup">
      ${csrfField(f.csrf)}
      <label class="field">Display name<input name="name" autocomplete="nickname" required maxlength="40"></label>
      <label class="field">Email<input name="email" type="email" autocomplete="email" required></label>
      <label class="field">Password<input name="password" type="password" autocomplete="new-password" required minlength="${f.cfg.minPasswordLength}"></label>
      <button class="btn btn-cta" type="submit">Sign up for free demo bids</button>
    </form>
    <p class="muted">Already in? <a href="/login">Log in</a></p>`);
  return page({ ...f, title: 'Sign up', main });
}

export function forgotPage(f: Omit<Frame, 'title' | 'main'> & { notice?: string; error?: string }): string {
  const main = formCard('Reset password', `${f.notice ? `<p class="ok" role="status">${esc(f.notice)}</p>` : ''}${f.error ? `<p class="err" role="alert">${esc(f.error)}</p>` : ''}
    <form method="post" action="/forgot">
      ${csrfField(f.csrf)}
      <label class="field">Email<input name="email" type="email" required></label>
      <button class="btn btn-cta" type="submit">Email me a link</button>
    </form>`);
  return page({ ...f, title: 'Forgot password', main });
}

export function resetPage(f: Omit<Frame, 'title' | 'main'> & { token: string; error?: string }): string {
  const main = formCard('Choose a new password', `${f.error ? `<p class="err" role="alert">${esc(f.error)}</p>` : ''}
    <form method="post" action="/reset-password">
      ${csrfField(f.csrf)}
      <input type="hidden" name="token" value="${esc(f.token)}">
      <label class="field">New password<input name="password" type="password" autocomplete="new-password" required minlength="${f.cfg.minPasswordLength}"></label>
      <button class="btn btn-cta" type="submit">Update password</button>
    </form>`);
  return page({ ...f, title: 'Reset password', main });
}

export function messagePage(f: Omit<Frame, 'title' | 'main'> & { heading: string; body: string }): string {
  return page({ ...f, title: f.heading, main: `<div class="form-card"><h1>${esc(f.heading)}</h1><p>${f.body}</p></div>` });
}

export function accountPage(f: Omit<Frame, 'title' | 'main'> & {
  ledger: { id: number; created_at: number; kind: string; delta: number; balance_after: number; note: string | null }[];
  bids: number;
  won: { id: number; name: string; final_price_cents: number; checkout_status: string; shipping_status: string; tracking: string | null }[];
  disputes: { id: number; auction_id: number | null; subject: string; message: string; status: string }[];
  reviewable: { id: number; name: string }[];
  verifyUrl?: string | null;
}): string {
  const u = f.user!;
  const verify = u.email_verified_at ? '' : `<div class="notice" role="status">
      <p><strong>Verify your email</strong> before bidding or buying credits. We sent a link to ${esc(u.email)}.</p>
      ${f.cfg.demoMode && f.verifyUrl ? `<p>Demo inbox: <a href="${esc(f.verifyUrl)}">open the verification link</a></p>` : ''}
      <form method="post" action="/account/resend-verification">${csrfField(f.csrf)}<button class="btn btn-ghost btn-small" type="submit">Resend email</button></form>
    </div>`;
  const main = `${verify}
    <h1>Hey, ${esc(u.name)}</h1>
    <div class="stats-strip">
      <div class="stat"><b>${u.balance}</b><span>${f.cfg.demoMode ? 'Demo credits' : 'Credits'}</span></div>
      <div class="stat"><b>${f.bids}</b><span>Bids placed</span></div>
      <div class="stat"><b>${money(f.bids * f.cfg.nominalBidPriceCents)}</b><span>Nominal bid value</span></div>
      <div class="stat"><b>${f.won.length}</b><span>Auctions won</span></div>
    </div>
    <h2>Won auctions</h2>
    <div class="table-wrap"><table>
      <tr><th>Item</th><th>Final</th><th>Checkout</th><th>Shipping</th></tr>
      ${f.won.map((a) => `<tr><td><a href="/auction/${a.id}">${esc(a.name)}</a></td><td>${money(a.final_price_cents)}</td><td>${a.checkout_status === 'pending' ? `<a class="btn btn-small btn-cta" href="/checkout/${a.id}">Checkout</a>` : esc(a.checkout_status)}</td><td>${esc(a.shipping_status)} ${esc(a.tracking || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No wins yet.</td></tr>'}
    </table></div>
    ${f.reviewable.length ? `<h2>How did the win feel?</h2><p class="muted">Reviews stay private until an admin approves them. They are never marked as sample content.</p>
      ${f.reviewable.map((a) => `<form method="post" action="/account/reviews" class="form-card narrow">
        ${csrfField(f.csrf)}
        <input type="hidden" name="auction_id" value="${a.id}">
        <h3>${esc(a.name)}</h3>
        <label class="field">Rating
          <select name="rating"><option>5</option><option>4</option><option>3</option><option>2</option><option>1</option></select>
        </label>
        <label class="field">Review<textarea name="body" required minlength="8" maxlength="600" placeholder="What happened in the last ten seconds?"></textarea></label>
        <button class="btn btn-cta" type="submit">Submit for review</button>
      </form>`).join('')}` : ''}
    <h2>Credit ledger</h2>
    <div class="table-wrap"><table>
      <tr><th>#</th><th>When</th><th>Type</th><th>Change</th><th>Balance</th><th>Note</th></tr>
      ${f.ledger.map((l) => `<tr><td>${l.id}</td><td>${when(l.created_at)}</td><td>${esc(l.kind)}</td><td class="${l.delta < 0 ? 'neg' : 'pos'}">${l.delta > 0 ? '+' : ''}${l.delta}</td><td>${l.balance_after}</td><td>${esc(l.note)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No ledger rows.</td></tr>'}
    </table></div>
    <h2>Open a dispute</h2>
    <form method="post" action="/disputes" class="form-card narrow">
      ${csrfField(f.csrf)}
      <label class="field">Subject<input name="subject" required maxlength="120"></label>
      <label class="field">Auction #<input name="auction_id" inputmode="numeric" placeholder="optional"></label>
      <label class="field">What happened?<textarea name="message" required maxlength="2000"></textarea></label>
      <button class="btn btn-cta" type="submit">Submit ticket</button>
    </form>
    ${f.disputes.length ? `<div class="table-wrap"><table><tr><th>#</th><th>Auction</th><th>Subject</th><th>Status</th></tr>
      ${f.disputes.map((d) => `<tr><td>${d.id}</td><td>${d.auction_id ?? ''}</td><td>${esc(d.subject)}</td><td>${esc(d.status)}</td></tr>`).join('')}
    </table></div>` : ''}`;
  return page({ ...f, title: 'Account', main });
}

export function buyPage(f: Omit<Frame, 'title' | 'main'> & { error?: string }): string {
  const locked = !f.cfg.paymentsEnabled && !f.cfg.demoMode;
  const main = `<h1>Bid credits</h1>
    ${f.error ? `<p class="err" role="alert">${esc(f.error)}</p>` : ''}
    ${locked ? '<p class="notice">Credit sales are unavailable until a payment processor that allows bidding-fee auctions is approved.</p>' : ''}
    ${!f.cfg.paymentsEnabled && f.cfg.demoMode ? '<p class="notice">Payments are disabled. Packs below are free demo credits and show up in your ledger as DEMO. The nominal price is a reference only.</p>' : ''}
    ${f.cfg.paymentsEnabled ? '<p class="notice">Checkout uses the mock provider. No card number is collected and no bank is charged. A signed webhook fulfills the order once.</p>' : ''}
    <div class="grid packs">${f.cfg.bidPacks.map((n) => `<form method="post" action="/buy" class="pack">
      ${csrfField(f.csrf)}
      <h2>${n} credits</h2>
      <p class="muted">nominal ${money(n * f.cfg.nominalBidPriceCents)}</p>
      <input type="hidden" name="pack" value="${n}">
      <input type="hidden" name="idem" value="pack-${n}-${f.user?.id}-${Math.random().toString(36).slice(2, 10)}">
      <button class="btn btn-cta" type="submit" ${locked ? 'disabled' : ''}>${f.cfg.paymentsEnabled ? `Continue to mock pay` : `Add ${n} DEMO credits — free`}</button>
    </form>`).join('')}</div>`;
  return page({ ...f, title: 'Credits', main });
}

export function checkoutPage(f: Omit<Frame, 'title' | 'main'> & {
  auction: { id: number; name: string; final_price_cents: number; checkout_status: string };
  error?: string;
}): string {
  const a = f.auction;
  const total = a.final_price_cents + f.cfg.shippingCents;
  const done = a.checkout_status !== 'pending';
  const main = `<div class="form-card">
    <p class="eyebrow">Winner checkout</p>
    <h1>${esc(a.name)}</h1>
    <table><tr><td>Final price</td><td>${money(a.final_price_cents)}</td></tr>
    <tr><td>Shipping</td><td>${money(f.cfg.shippingCents)}</td></tr>
    <tr><th>Total</th><th>${money(total)}</th></tr></table>
    ${f.cfg.paymentsEnabled
      ? '<p class="notice">The next step is the mock provider. It does not ask for a card. Fulfillment runs from a signed webhook, once.</p>'
      : '<p class="notice">Payments are disabled. Confirming records a demo order and a shipment. No card is charged.</p>'}
    ${f.error ? `<p class="err" role="alert">${esc(f.error)}</p>` : ''}
    ${done ? `<p>Status: <strong>${esc(a.checkout_status)}</strong></p><p><a href="/account">Back to account</a></p>` : `<form method="post">
      ${csrfField(f.csrf)}
      <label class="field">Full name<input name="name" required autocomplete="name" value="${esc(f.user?.name || '')}"></label>
      <label class="field">Address line 1<input name="line1" required autocomplete="address-line1"></label>
      <label class="field">Address line 2<input name="line2" autocomplete="address-line2"></label>
      <label class="field">City<input name="city" required autocomplete="address-level2"></label>
      <label class="field">State / region<input name="region" required autocomplete="address-level1"></label>
      <label class="field">Postal code<input name="postal" required autocomplete="postal-code"></label>
      <label class="field">Country<input name="country" required autocomplete="country-name" value="United States"></label>
      <button class="btn btn-cta" type="submit">${f.cfg.paymentsEnabled ? 'Continue to mock pay' : 'Confirm demo order'}</button>
    </form>`}
  </div>`;
  return page({ ...f, title: 'Checkout', main });
}

export function mockPayPage(f: Omit<Frame, 'title' | 'main'> & { order: { id: number; amount_cents: number; kind: string; status: string; description: string } }): string {
  const o = f.order;
  const main = `<div class="form-card">
    <p class="eyebrow">Mock provider</p>
    <h1>Simulate payment</h1>
    <p>No card is charged. This page stands in for a processor that has agreed to bidding-fee auctions. Submitting posts a signed webhook and fulfills the order once.</p>
    <p><strong>${money(o.amount_cents)}</strong> · ${esc(o.description)} · order #${o.id}</p>
    <p>Status: ${esc(o.status)}</p>
    ${o.status === 'pending' ? `<form method="post" action="/pay/mock/${o.id}/complete">${csrfField(f.csrf)}<button class="btn btn-cta" type="submit">Simulate successful payment</button></form>` : '<p class="ok">This order is not waiting for payment.</p>'}
  </div>`;
  return page({ ...f, title: 'Mock pay', main });
}

export function legalView(f: Omit<Frame, 'title' | 'main'> & { docTitle: string; html: string }): string {
  return page({ ...f, title: f.docTitle, main: `<article class="prose">${f.html}</article>` });
}

function adminNav(active: string): string {
  const item = (href: string, label: string) => `<a href="${href}" ${active === href ? 'aria-current="page"' : ''}>${label}</a>`;
  return `<nav class="admin-nav" aria-label="Admin">${item('/admin', 'Dashboard')}${item('/admin/shipments', 'Shipments')}${item('/admin/disputes', 'Disputes')}${item('/admin/testimonials', 'Reviews')}${item('/admin/outbox', 'Outbox')}</nav>`;
}

export function adminDashboard(f: Omit<Frame, 'title' | 'main'> & {
  counts: { live: number; upcoming: number; toShip: number; disputes: number };
  products: { id: number; name: string; retail_cents: number; inventory: number; images: unknown }[];
  auctions: { id: number; name: string; closed: boolean; start_at: number; end_at: number; price_cents: number; bid_count: number; winner_email: string | null; checkout_status: string }[];
  users: { id: number; email: string; balance: number }[];
  error?: string;
}): string {
  const t = Date.now();
  const status = (a: { closed: boolean; start_at: number }) => a.closed ? 'closed' : t < a.start_at ? 'upcoming' : 'live';
  const local = new Date(t + 60_000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const main = `${adminNav('/admin')}
    <h1>Dashboard</h1>
    ${f.error ? `<p class="err" role="alert">${esc(f.error)}</p>` : ''}
    <div class="stats-strip">
      <div class="stat"><b>${f.counts.live}</b><span>Live</span></div>
      <div class="stat"><b>${f.counts.upcoming}</b><span>Upcoming</span></div>
      <div class="stat"><b>${f.counts.toShip}</b><span>To ship</span></div>
      <div class="stat"><b>${f.counts.disputes}</b><span>Open disputes</span></div>
    </div>
    <div class="cols">
      <section class="panel">
        <h2>New product</h2>
        <form method="post" action="/admin/products" enctype="multipart/form-data">
          ${csrfField(f.csrf)}
          <label class="field">Name<input name="name" required></label>
          <label class="field">Description<textarea name="description"></textarea></label>
          <label class="field">Retail value ($)<input name="retail" type="number" step="0.01" min="0" value="0"></label>
          <label class="field">Inventory<input name="inventory" type="number" min="0" value="1"></label>
          <label class="field">Photos<input type="file" name="photos" accept="image/png,image/jpeg,image/webp,image/gif" multiple></label>
          <button class="btn btn-cta" type="submit">Create product</button>
        </form>
      </section>
      <section class="panel">
        <h2>Schedule auction</h2>
        <form method="post" action="/admin/auctions">
          ${csrfField(f.csrf)}
          <label class="field">Product<select name="product_id">${f.products.map((p) => `<option value="${p.id}">${esc(p.name)} (stock ${p.inventory})</option>`).join('') || '<option value="">No products</option>'}</select></label>
          <label class="field">Start<input type="datetime-local" name="start" value="${local}" required></label>
          <label class="field">Duration (minutes)<input name="minutes" type="number" value="10" min="1"></label>
          <input type="hidden" name="tz" id="tz" value="0">
          <button class="btn btn-cta" type="submit">Schedule</button>
        </form>
        <h2>Refund credits</h2>
        <form method="post" action="/admin/refund">
          ${csrfField(f.csrf)}
          <label class="field">User<select name="user_id">${f.users.map((u) => `<option value="${u.id}">${esc(u.email)} (${u.balance})</option>`).join('')}</select></label>
          <label class="field">Credits<input name="credits" type="number" min="1" value="5"></label>
          <label class="field">Reason<input name="note" required></label>
          <button class="btn btn-ghost" type="submit">Append credit refund</button>
        </form>
      </section>
    </div>
    <h2>Products</h2>
    <div class="table-wrap"><table>
      <tr><th>#</th><th></th><th>Name</th><th>Retail</th><th>Stock</th><th>Edit</th></tr>
      ${f.products.map((p) => `<tr>
        <td>${p.id}</td>
        <td>${safeImg(imgs(p)[0] || '') ? `<img class="mini" src="${safeImg(imgs(p)[0] || '')}" alt="">` : ''}</td>
        <td>${esc(p.name)} <a href="/admin/products/${p.id}/media">Media</a></td><td>${money(p.retail_cents)}</td><td>${p.inventory}</td>
        <td><form method="post" action="/admin/products/${p.id}" enctype="multipart/form-data" class="row">
          ${csrfField(f.csrf)}
          <input name="name" value="${esc(p.name)}" aria-label="Name">
          <input name="retail" type="number" step="0.01" value="${(p.retail_cents / 100).toFixed(2)}" aria-label="Retail dollars" class="narrow">
          <input name="inventory" type="number" value="${p.inventory}" aria-label="Inventory" class="narrow">
          <input type="file" name="photos" accept="image/png,image/jpeg,image/webp,image/gif" multiple aria-label="Photos">
          <button class="btn btn-small" type="submit">Save</button>
        </form></td>
      </tr>`).join('')}
    </table></div>
    <h2>Auctions</h2>
    <div class="table-wrap"><table>
      <tr><th>#</th><th>Item</th><th>Status</th><th>Window</th><th>Price</th><th>Bids</th><th>Winner</th><th>Checkout</th></tr>
      ${f.auctions.map((a) => `<tr>
        <td><a href="/auction/${a.id}">${a.id}</a></td><td>${esc(a.name)}</td>
        <td><span class="tag tag-${status(a)}">${status(a)}</span></td>
        <td class="small">${when(a.start_at)} → ${when(a.end_at)}</td>
        <td>${money(a.price_cents)}</td><td>${a.bid_count}</td><td>${esc(a.winner_email || '')}</td><td>${esc(a.checkout_status)}</td>
      </tr>`).join('')}
    </table></div>`;
  return page({ ...f, title: 'Admin', main });
}

export function adminMediaPage(f: Omit<Frame, 'title' | 'main'> & {
  product: { id: number; name: string };
  media: MediaView[];
  error?: string;
}): string {
  const rows = f.media.map((m, i) => {
    const thumb = m.kind === 'image' ? (m.variants.thumb || m.url) : (m.posterUrl || '');
    return `<li class="media-row" draggable="true" data-id="${m.id}">
      <div class="media-preview">
        ${thumb ? `<img src="${safeImg(thumb)}" alt="" width="160" height="100">` : `<span class="media-kind">${esc(m.kind)}</span>`}
        ${m.isCover ? '<span class="sample-badge">Cover</span>' : ''}
        ${m.isSpin ? '<span class="media-badge soon">360</span>' : ''}
      </div>
      <div>
        <p class="muted small">${esc(m.kind)} · #${m.id}</p>
        <form method="post" action="/admin/products/${f.product.id}/media/${m.id}" class="stack-form">
          ${csrfField(f.csrf)}
          <label class="field">Alt text<input name="alt" value="${esc(m.alt)}" required maxlength="300" aria-label="Alt text for ${esc(m.alt)}"></label>
          ${m.kind === 'image' ? `<label class="check"><input type="checkbox" name="spin" value="1" ${m.isSpin ? 'checked' : ''}> Include in 360 spin</label>` : ''}
          <div class="row">
            <button class="btn btn-small" type="submit" name="action" value="save">Save</button>
            ${m.kind === 'image' && !m.isCover ? '<button class="btn btn-small" type="submit" name="action" value="cover">Set cover</button>' : ''}
            <button class="btn btn-small" type="submit" name="action" value="up" ${i === 0 ? 'disabled' : ''}>Move up</button>
            <button class="btn btn-small" type="submit" name="action" value="down" ${i === f.media.length - 1 ? 'disabled' : ''}>Move down</button>
            <button class="btn btn-small btn-danger" type="submit" name="action" value="delete">Delete</button>
          </div>
        </form>
      </div>
    </li>`;
  }).join('');
  const main = `${adminNav('/admin')}
    <p class="muted"><a href="/admin">Dashboard</a></p>
    <h1>Media · ${esc(f.product.name)}</h1>
    ${f.error ? `<p class="err" role="alert">${esc(f.error)}</p>` : ''}
    <form method="post" action="/admin/products/${f.product.id}/media" enctype="multipart/form-data" class="panel" data-media-admin>
      ${csrfField(f.csrf)}
      <div class="dropzone" data-dropzone tabindex="0">
        <p><strong>Drop images or videos</strong> or choose files. PNG, JPEG, WebP, GIF up to 8 MB. MP4 or WebM up to 32 MB.</p>
        <input type="file" name="files" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm" multiple aria-label="Product images and videos">
        <div class="drop-previews" data-drop-previews></div>
      </div>
      <label class="field">Alt text for this upload<input name="alt" required maxlength="300" placeholder="What is in the picture or clip?"></label>
      <label class="check"><input type="checkbox" name="spin" value="1"> Add images to the 360 spin</label>
      <button class="btn btn-cta" type="submit">Upload</button>
    </form>
    <form method="post" action="/admin/products/${f.product.id}/media/embed" class="panel">
      ${csrfField(f.csrf)}
      <h2>Embed</h2>
      <label class="field">YouTube or Vimeo URL<input name="url" type="url" required placeholder="https://www.youtube.com/watch?v=..."></label>
      <label class="field">Alt text<input name="alt" required maxlength="300" placeholder="What the clip shows"></label>
      <button class="btn btn-ghost" type="submit">Add embed</button>
    </form>
    <ol class="media-admin" data-sortable>${rows || '<li class="empty">No media yet.</li>'}</ol>`;
  return page({ ...f, title: `Media · ${f.product.name}`, main });
}

export function adminShipments(f: Omit<Frame, 'title' | 'main'> & {
  rows: { id: number; auction_id: number; name: string; email: string; status: string; tracking: string | null; carrier: string | null; address: unknown; amount_cents: number | null; order_id: number | null }[];
}): string {
  const opts = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
  const main = `${adminNav('/admin/shipments')}
    <h1>Shipments</h1>
    <p class="muted">Inventory drops when an auction closes with a winner, not when you print a label. Cancelling a refunded order is handled from the order refund action.</p>
    <div class="table-wrap"><table>
      <tr><th>#</th><th>Auction</th><th>Winner</th><th>Ship to</th><th>Order</th><th>Update</th></tr>
      ${f.rows.map((s) => {
        const addr = s.address && typeof s.address === 'object' ? s.address as Record<string, string> : {};
        const line = [addr.name, addr.line1, addr.line2, addr.city, addr.region, addr.postal, addr.country].filter(Boolean).join(', ');
        return `<tr>
          <td>${s.id}</td>
          <td><a href="/auction/${s.auction_id}">${esc(s.name)}</a></td>
          <td>${esc(s.email)}</td>
          <td class="small">${esc(line)}</td>
          <td>${s.order_id ? `#${s.order_id} ${s.amount_cents != null ? money(s.amount_cents) : ''}` : '—'}</td>
          <td><form method="post" action="/admin/shipments/${s.id}" class="stack-form">
            ${csrfField(f.csrf)}
            <select name="status" aria-label="Status">${opts.map((o) => `<option ${o === s.status ? 'selected' : ''}>${o}</option>`).join('')}</select>
            <input name="carrier" value="${esc(s.carrier || '')}" placeholder="Carrier" aria-label="Carrier">
            <input name="tracking" value="${esc(s.tracking || '')}" placeholder="Tracking number" aria-label="Tracking">
            <button class="btn btn-small" type="submit">Save</button>
          </form>
          ${s.order_id ? `<form method="post" action="/admin/orders/${s.order_id}/refund" class="row">${csrfField(f.csrf)}<input name="reason" placeholder="Refund reason" required aria-label="Refund reason"><button class="btn btn-small btn-danger" type="submit">Refund order</button></form>` : ''}
          </td>
        </tr>`;
      }).join('') || '<tr><td colspan="6" class="muted">No shipments yet. A shipment is created when a winner checks out.</td></tr>'}
    </table></div>`;
  return page({ ...f, title: 'Shipments', main });
}

export function adminDisputes(f: Omit<Frame, 'title' | 'main'> & {
  rows: { id: number; email: string; auction_id: number | null; subject: string; message: string; status: string; notes: { body: string; created_at: number; author: string; internal: boolean }[] }[];
}): string {
  const main = `${adminNav('/admin/disputes')}
    <h1>Disputes</h1>
    ${f.rows.map((d) => `<article class="panel dispute">
      <header><h2>#${d.id} ${esc(d.subject)}</h2><p class="muted">${esc(d.email)} · auction ${d.auction_id ?? '—'} · ${esc(d.status)}</p></header>
      <p>${esc(d.message)}</p>
      <ol class="notes">${d.notes.map((n) => `<li><b>${esc(n.author)}</b> <span class="muted">${when(n.created_at)}${n.internal ? ' · internal' : ''}</span><br>${esc(n.body)}</li>`).join('') || '<li class="muted">No notes yet.</li>'}</ol>
      <form method="post" action="/admin/disputes/${d.id}">
        ${csrfField(f.csrf)}
        <label class="field">Internal note<textarea name="body" required></textarea></label>
        <label class="field">Status
          <select name="status">${['open', 'investigating', 'resolved'].map((s) => `<option ${s === d.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
        </label>
        <label class="field">Credit refund (0 to skip)<input name="refund" type="number" min="0" value="0"></label>
        <button class="btn btn-cta" type="submit">Save ticket</button>
      </form>
    </article>`).join('') || '<p class="empty">No dispute tickets.</p>'}`;
  return page({ ...f, title: 'Disputes', main });
}

export function adminTestimonials(f: Omit<Frame, 'title' | 'main'> & {
  rows: { id: number; display_name: string; body: string; rating: number | null; status: string; is_sample: boolean; created_at: number }[];
}): string {
  const main = `${adminNav('/admin/testimonials')}
    <h1>Reviews</h1>
    <p class="muted">Approved sample rows render only while demo mode is on, and only with a Sample content label. Rejecting one hides it everywhere.</p>
    <div class="table-wrap"><table>
      <tr><th>#</th><th>Who</th><th>Review</th><th>State</th><th></th></tr>
      ${f.rows.map((t) => `<tr>
        <td>${t.id}</td>
        <td>${esc(t.display_name)}${t.is_sample ? '<br><span class="sample-badge">Sample content</span>' : ''}</td>
        <td>${esc(t.body)}${t.rating ? `<div class="muted">${t.rating}/5</div>` : ''}</td>
        <td>${esc(t.status)}</td>
        <td><form method="post" action="/admin/testimonials/${t.id}" class="row">
          ${csrfField(f.csrf)}
          <select name="status" aria-label="Moderation">${['pending', 'approved', 'rejected'].map((s) => `<option ${s === t.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
          <button class="btn btn-small" type="submit">Update</button>
        </form></td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">No reviews.</td></tr>'}
    </table></div>`;
  return page({ ...f, title: 'Reviews', main });
}

export function adminOutbox(f: Omit<Frame, 'title' | 'main'> & { rows: { id: number; to_email: string; subject: string; body: string; created_at: number }[] }): string {
  const main = `${adminNav('/admin/outbox')}
    <h1>Mail outbox</h1>
    <p class="muted">Every verification and reset message is stored here. SMTP sends a copy when SMTP_HOST is set. This view is for operators.</p>
    ${f.rows.map((m) => `<article class="panel"><header><h2>${esc(m.subject)}</h2><p class="muted">to ${esc(m.to_email)} · ${when(m.created_at)}</p></header><pre class="mail">${esc(m.body)}</pre></article>`).join('') || '<p class="empty">Outbox is empty.</p>'}`;
  return page({ ...f, title: 'Outbox', main });
}
