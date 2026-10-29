(function () {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
  let offset = 0;
  let inflight = false;
  const sync = () => {
    const t0 = Date.now();
    fetch('/api/time').then((r) => r.json()).then((j) => {
      const t1 = Date.now();
      offset = j.serverNow - (t0 + t1) / 2;
    }).catch(() => {});
  };
  sync();
  setInterval(sync, 30000);
  const serverNow = () => Date.now() + offset;
  const money = (c) => '$' + (Number(c) / 100).toFixed(2);
  const fmt = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const x = s % 60;
    const tail = String(x).padStart(2, '0');
    if (h) return h + ':' + String(m).padStart(2, '0') + ':' + tail;
    return m + ':' + tail;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function paintCountdown(el) {
    const end = +el.dataset.end;
    const start = +el.dataset.start;
    const t = serverNow();
    const text = el.querySelector('.cd-text') || el;
    const label = el.querySelector('.urgent-label');
    let next = '';
    let urgent = false;
    let labelText = '';
    if (el.dataset.closed === '1') next = 'Ended';
    else if (t < start) next = 'Starts in ' + fmt(start - t);
    else {
      const left = end - t;
      if (left > 0) {
        next = fmt(left);
        urgent = left <= 10000;
        if (urgent) labelText = 'Final seconds';
      } else next = 'Closing…';
    }
    if (text.textContent !== next) text.textContent = next;
    if (label && label.textContent !== labelText) label.textContent = labelText;
    el.classList.toggle('urgent', urgent);
  }

  function tick() {
    document.querySelectorAll('.countdown').forEach(paintCountdown);
    const btn = document.getElementById('bid-btn');
    const cd = document.getElementById('countdown');
    if (btn && cd) {
      btn.disabled = cd.dataset.closed === '1' || serverNow() < +cd.dataset.start || inflight;
    }
  }
  setInterval(tick, 200);
  tick();

  function pulse(el) {
    if (reduce) return;
    el.classList.remove('pulse');
    void el.offsetWidth;
    el.classList.add('pulse');
  }

  function apply(s) {
    if (!s) return;
    document.querySelectorAll('.countdown[data-auction="' + s.id + '"]').forEach((el) => {
      el.dataset.end = s.endAt;
      el.dataset.closed = s.status === 'closed' ? '1' : '0';
    });
    document.querySelectorAll('[data-price="' + s.id + '"]').forEach((el) => {
      const next = money(s.priceCents);
      if (el.textContent !== next) {
        el.textContent = next;
        pulse(el);
      }
    });
    const page = document.querySelector('[data-auction-page="' + s.id + '"]');
    if (!page) return;
    const count = document.getElementById('bidcount');
    if (count) count.textContent = '(' + s.bidCount + ' bids)';
    const leader = document.getElementById('leader');
    if (leader) leader.textContent = s.status === 'closed' ? '' : s.leader ? 'High bidder: ' + s.leader : 'No bids yet — the chair is empty.';
    const history = document.getElementById('history');
    if (history) {
      history.innerHTML = (s.bids || []).map((b) => '<li><b>' + money(b.price_after_cents) + '</b> ' + esc(b.name) + ' <span class="muted">' + new Date(b.created_at).toLocaleTimeString() + '</span></li>').join('');
    }
    if (s.status === 'closed') {
      const me = page.dataset.user;
      const box = document.getElementById('winner-box');
      if (box) {
        box.innerHTML = s.winner
          ? '<div class="winner">Won by <b>' + esc(s.winner) + '</b> at ' + money(s.priceCents) + (me && +me === s.winnerId ? ' — <a href="/checkout/' + s.id + '">Go to checkout</a>' : '') + '</div>'
          : '<div class="winner">Ended with no bids. Inventory stays put.</div>';
      }
    }
  }

  function addTicker(text) {
    const list = document.getElementById('ticker');
    if (!list || !text) return;
    const li = document.createElement('li');
    li.textContent = text;
    list.prepend(li);
  }

  const page = document.querySelector('[data-auction-page]');
  const anyCountdown = document.querySelector('.countdown');
  const ticker = document.getElementById('ticker');
  if (anyCountdown || ticker) {
    const id = page ? page.dataset.auctionPage : 0;
    const conn = document.getElementById('conn');
    const es = new EventSource('/api/stream?auction=' + id);
    es.addEventListener('auction', (e) => apply(JSON.parse(e.data)));
    es.addEventListener('ticker', (e) => addTicker(JSON.parse(e.data).text));
    es.onopen = () => {
      if (conn) conn.textContent = 'Live';
      if (id) fetch('/api/auctions/' + id).then((r) => r.json()).then(apply).catch(() => {});
    };
    es.onerror = () => { if (conn) conn.textContent = 'Reconnecting…'; };
  }

  const btn = document.getElementById('bid-btn');
  if (btn && page) {
    btn.addEventListener('click', async () => {
      if (inflight) return;
      inflight = true;
      btn.disabled = true;
      const key = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
      const msg = document.getElementById('bid-msg');
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch('/api/auctions/' + page.dataset.auctionPage + '/bid', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-CSRF-Token': csrf },
          });
          const j = await r.json();
          if (msg) {
            msg.textContent = j.ok ? (j.duplicate ? 'Bid already counted.' : 'Bid placed.') : (j.message || 'Bid not accepted.');
            msg.className = 'msg ' + (j.ok ? 'ok' : 'err');
          }
          if (j.balance != null) {
            const b = document.getElementById('bal');
            if (b) b.textContent = j.balance;
          }
          break;
        } catch (e) {
          if (msg) msg.textContent = 'Network issue, retrying…';
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      inflight = false;
    });
  }

  document.getElementById('bid-btn-guest')?.addEventListener('click', () => {
    document.getElementById('signup-prompt')?.showModal();
  });

  document.querySelectorAll('.card').forEach((card) => {
    const cd = card.querySelector('.countdown');
    if (!cd) return;
    const mark = () => {
      const end = +cd.dataset.end;
      const start = +cd.dataset.start;
      const left = end - serverNow();
      const live = cd.dataset.closed !== '1' && serverNow() >= start && left > 0;
      card.classList.toggle('is-final', live && left <= 10000);
    };
    mark();
    setInterval(mark, 200);
  });

  document.querySelectorAll('.card-media video.preview').forEach((video) => {
    const card = video.closest('.card');
    if (!card || reduce) return;
    const src = video.getAttribute('data-src');
    if (!src) return;
    card.addEventListener('mouseenter', () => {
      if (!video.getAttribute('src')) video.setAttribute('src', src);
      video.play().catch(() => {});
    });
    card.addEventListener('mouseleave', () => { video.pause(); });
    card.addEventListener('focusin', () => {
      if (!video.getAttribute('src')) video.setAttribute('src', src);
      video.play().catch(() => {});
    });
    card.addEventListener('focusout', () => { video.pause(); });
  });

  document.querySelectorAll('[data-gallery]').forEach((gallery) => {
    let items = [];
    try { items = JSON.parse(gallery.getAttribute('data-media') || '[]'); } catch (e) { items = []; }
    if (!items.length) return;
    let index = Math.max(0, items.findIndex((item) => gallery.querySelector('.thumb.is-active')?.dataset.index === String(items.indexOf(item))));
    if (index < 0) index = 0;
    const img = gallery.querySelector('.stage-img');
    const video = gallery.querySelector('.stage-video');
    const embed = gallery.querySelector('.stage-embed');
    const stage = gallery.querySelector('.stage');
    const dialog = gallery.querySelector('[data-lightbox]');
    const lbImg = gallery.querySelector('[data-lightbox-img]');
    const lbVideo = gallery.querySelector('[data-lightbox-video]');
    const lbEmbed = gallery.querySelector('[data-lightbox-embed]');
    const lbAlt = gallery.querySelector('[data-lightbox-alt]');
    const lbCount = gallery.querySelector('[data-lightbox-count]');
    const spinItems = items.map((item, i) => item.spin ? i : -1).filter((i) => i >= 0);
    let zoom = false;
    let pinch = 1;

    function show(i, opts) {
      index = (i + items.length) % items.length;
      const item = items[index];
      gallery.querySelectorAll('.thumb').forEach((btn) => {
        const on = Number(btn.dataset.index) === index;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      const isImage = item.kind === 'image';
      const isVideo = item.kind === 'video';
      img.hidden = !isImage;
      video.hidden = !isVideo;
      embed.hidden = item.kind !== 'embed';
      if (isImage) {
        img.src = item.url;
        img.alt = item.alt || '';
        if (item.srcset) img.setAttribute('srcset', item.srcset);
        else img.removeAttribute('srcset');
        video.pause();
        video.removeAttribute('src');
        embed.removeAttribute('src');
      } else if (isVideo) {
        video.poster = item.poster || '';
        if (video.getAttribute('src') !== item.url) video.setAttribute('src', item.url);
        embed.removeAttribute('src');
        if (opts && opts.play && !reduce) video.play().catch(() => {});
      } else {
        embed.title = item.alt || 'Embedded video';
        embed.src = item.url;
        video.pause();
      }
      if (dialog && dialog.open) paintLightbox();
    }

    function paintLightbox() {
      const item = items[index];
      if (lbCount) lbCount.textContent = (index + 1) + ' / ' + items.length;
      if (lbAlt) lbAlt.textContent = item.alt || '';
      const isImage = item.kind === 'image';
      lbImg.hidden = !isImage;
      lbVideo.hidden = item.kind !== 'video';
      lbEmbed.hidden = item.kind !== 'embed';
      if (isImage) {
        lbImg.src = item.url;
        lbImg.alt = item.alt || '';
        if (item.srcset) lbImg.setAttribute('srcset', item.srcset);
      } else if (item.kind === 'video') {
        lbVideo.poster = item.poster || '';
        lbVideo.src = item.url;
        lbEmbed.removeAttribute('src');
      } else {
        lbEmbed.title = item.alt || 'Embedded video';
        lbEmbed.src = item.url;
      }
    }

    gallery.querySelectorAll('.thumb').forEach((btn) => {
      btn.addEventListener('click', () => show(Number(btn.dataset.index), { play: true }));
    });
    gallery.querySelector('[data-zoom]')?.addEventListener('click', (e) => {
      zoom = !zoom;
      stage.classList.toggle('is-zoom', zoom);
      e.currentTarget.setAttribute('aria-pressed', zoom ? 'true' : 'false');
      if (!zoom) img.style.transform = '';
    });
    stage.addEventListener('mousemove', (e) => {
      if (!zoom || img.hidden || reduce) return;
      const rect = stage.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      img.style.transformOrigin = x + '% ' + y + '%';
      img.style.transform = 'scale(1.8)';
    });
    stage.addEventListener('mouseleave', () => { if (zoom) img.style.transform = 'scale(1.8)'; });

    let touchX = 0;
    let touchY = 0;
    let pinching = false;
    let pinchStart = 0;
    stage.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        pinching = true;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchStart = Math.hypot(dx, dy) / pinch;
      } else if (e.touches.length === 1) {
        touchX = e.touches[0].clientX;
        touchY = e.touches[0].clientY;
        pinching = false;
      }
    }, { passive: true });
    stage.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && pinchStart) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinch = Math.min(3, Math.max(1, Math.hypot(dx, dy) / pinchStart));
        img.style.transform = 'scale(' + pinch + ')';
      }
    }, { passive: true });
    stage.addEventListener('touchend', (e) => {
      if (pinching) { pinching = false; return; }
      if (!e.changedTouches[0]) return;
      const dx = e.changedTouches[0].clientX - touchX;
      const dy = e.changedTouches[0].clientY - touchY;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) show(index + (dx < 0 ? 1 : -1), { play: true });
    });

    const range = gallery.querySelector('[data-spin-range]');
    gallery.querySelector('[data-spin-toggle]')?.addEventListener('click', (e) => {
      const on = stage.classList.toggle('is-spin');
      e.currentTarget.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on && spinItems.length) show(spinItems[0]);
    });
    range?.addEventListener('input', () => {
      const at = spinItems[Number(range.value)] ?? spinItems[0];
      if (at !== undefined) show(at);
    });
    let dragX = 0;
    stage.addEventListener('pointerdown', (e) => { if (stage.classList.contains('is-spin')) dragX = e.clientX; });
    stage.addEventListener('pointermove', (e) => {
      if (!stage.classList.contains('is-spin') || e.buttons !== 1 || !spinItems.length) return;
      const step = Math.trunc((e.clientX - dragX) / 24);
      if (!step) return;
      dragX = e.clientX;
      const current = Math.max(0, spinItems.indexOf(index));
      const next = (current + step + spinItems.length) % spinItems.length;
      if (range) range.value = String(next);
      show(spinItems[next]);
    });

    function openLightbox() {
      if (!dialog || !dialog.showModal) return;
      paintLightbox();
      dialog.showModal();
    }
    gallery.querySelector('[data-lightbox-open]')?.addEventListener('click', openLightbox);
    gallery.querySelector('[data-lightbox-close]')?.addEventListener('click', () => dialog.close());
    gallery.querySelector('[data-lightbox-prev]')?.addEventListener('click', () => show(index - 1, { play: true }));
    gallery.querySelector('[data-lightbox-next]')?.addEventListener('click', () => show(index + 1, { play: true }));
    dialog?.addEventListener('cancel', () => { lbVideo.pause(); lbEmbed.removeAttribute('src'); });
    dialog?.addEventListener('close', () => { lbVideo.pause(); lbEmbed.removeAttribute('src'); });
    dialog?.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); show(index + 1, { play: true }); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); show(index - 1, { play: true }); }
      else if (e.key === 'Home') { e.preventDefault(); show(0); }
      else if (e.key === 'End') { e.preventDefault(); show(items.length - 1); }
    });
    show(index);
  });

  document.querySelectorAll('[data-media-admin]').forEach((form) => {
    const input = form.querySelector('input[type=file]');
    const zone = form.querySelector('[data-dropzone]');
    const previews = form.querySelector('[data-drop-previews]');
    if (!input || !zone) return;
    const take = (files) => {
      const transfer = new DataTransfer();
      Array.from(files || []).forEach((file) => transfer.items.add(file));
      input.files = transfer.files;
      if (!previews) return;
      previews.replaceChildren();
      Array.from(input.files).forEach((file) => {
        const fig = document.createElement('figure');
        const cap = document.createElement('figcaption');
        cap.textContent = file.name;
        if (file.type.startsWith('image/')) {
          const img = document.createElement('img');
          img.alt = '';
          img.src = URL.createObjectURL(file);
          fig.append(img);
        } else {
          const note = document.createElement('p');
          note.textContent = 'Video';
          fig.append(note);
        }
        fig.append(cap);
        previews.append(fig);
      });
    };
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('is-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('is-over');
      take(e.dataTransfer.files);
    });
    input.addEventListener('change', () => take(input.files));
  });

  document.querySelectorAll('[data-sortable]').forEach((list) => {
    let dragged = null;
    list.querySelectorAll('[draggable=true]').forEach((row) => {
      row.addEventListener('dragstart', () => { dragged = row; row.classList.add('is-dragging'); });
      row.addEventListener('dragend', () => { row.classList.remove('is-dragging'); dragged = null; });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!dragged || dragged === row) return;
        const rect = row.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        row.parentNode.insertBefore(dragged, after ? row.nextSibling : row);
      });
    });
    list.addEventListener('drop', async () => {
      const ids = Array.from(list.querySelectorAll('[data-id]')).map((el) => el.dataset.id).join(',');
      const token = document.querySelector('meta[name=csrf-token]')?.getAttribute('content') || '';
      const product = location.pathname.match(/\/admin\/products\/(\d+)/);
      if (!product) return;
      await fetch('/admin/products/' + product[1] + '/media/reorder', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-csrf-token': token },
        body: new URLSearchParams({ order: ids, _csrf: token }),
      });
    });
  });

  document.body.addEventListener('click', (e) => {
    const thumb = e.target.closest('[data-src]');
    if (thumb) {
      const img = document.getElementById('main-img');
      const src = thumb.getAttribute('data-src') || '';
      if (img && src.startsWith('/uploads/')) img.src = src;
    }
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      const value = copy.getAttribute('data-copy') || '';
      const done = () => { copy.textContent = 'Copied'; };
      if (navigator.clipboard) navigator.clipboard.writeText(value).then(done).catch(done);
      else done();
    }
  });

  const tz = document.getElementById('tz');
  if (tz) tz.value = String(new Date().getTimezoneOffset());
})();
