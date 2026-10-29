import express, { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { Config, loadConfig } from './config';
import { createPool, createSchema, dropSchema, migrate, waitForDb, withTx } from './db';
import { createEngine, Engine, BidError } from './engine';
import {
  checkPw, consumeEmailToken, createUser, destroySession, destroyUserSessions, dummyHash,
  hashPw, issueEmailToken, newSession, randomToken, safeEqual, sha256, signSession, unsignSession, UserRow,
} from './auth';
import { createSmtpMailer, deliverMail } from './mailer';
import { getProvider, PaymentProvider } from './payments';
import { rateLimit } from './ratelimit';
import { createRealtime, Realtime, waitForRedis } from './realtime';
import { getSocialProof, recentTicker } from './social';
import { legalBySlug } from './legal';
import { createBidPackOrder, createWinnerOrder, handlePaymentWebhook, refundOrder, updateShipment } from './orders';
import { seed } from './seed';
import { topUpDemoAuctions } from './demoTopUp';
import { log } from './logger';
import { createStorage, ObjectStorage } from './storage';
import { addEmbed, addImage, addVideo, deleteMedia, IMAGE_MAX_BYTES, listMedia, listMediaForProducts, PublicMedia, reorderMedia, sniffImage, sniffVideo, updateMedia, VIDEO_MAX_BYTES } from './media';
import { HttpError, parse, loginSchema, signupSchema, forgotSchema, resetSchema, disputeSchema, reviewSchema, productSchema, scheduleSchema, shipSchema, creditRefundSchema, orderRefundSchema, noteSchema, testimonialModSchema, addressSchema, nameSchema } from './validate';
import { z } from 'zod';
import * as views from './views';

type AuthedRequest = Request & {
  user?: UserRow;
  sessionCsrf?: string;
  authVia?: 'bearer' | 'cookie';
  csrf?: string;
  requestId?: string;
};

export type AppCtx = {
  app: express.Express;
  pool: Pool;
  engine: Engine;
  cfg: Config;
  provider: PaymentProvider;
  realtime: Realtime;
  schema: string;
  close: () => Promise<void>;
};

function safeNext(n: unknown): string {
  if (typeof n !== 'string' || !n.startsWith('/') || n.startsWith('//') || n.includes('\\')) return '/';
  return n.slice(0, 200);
}

function numId(v: unknown): number | null {
  const raw = Array.isArray(v) ? v[0] : v;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const money = (c: number) => '$' + (c / 100).toFixed(2);

export async function createApp(opts: {
  schema?: string;
  uploadDir?: string;
  seed?: boolean;
  closer?: boolean;
  config?: Partial<Config>;
  clock?: () => number;
  sessionSecret?: string;
  ratePrefix?: string;
  dropSchema?: boolean;
  webhookSecret?: string;
} = {}): Promise<AppCtx> {
  const schema = opts.schema || process.env.DB_SCHEMA || 'public';
  if (schema !== 'public') await createSchema(schema);
  const pool = createPool(schema);
  await waitForDb(pool);
  await migrate(pool);

  const cfg = loadConfig({
    ...(opts.config || {}),
    rateLimits: { ...loadConfig().rateLimits, ...(opts.config?.rateLimits || {}) },
  });
  const secret = opts.sessionSecret || process.env.SESSION_SECRET || '';
  if (secret.length < 16) throw new Error('SESSION_SECRET must be at least 16 characters');
  let webhookSecret = opts.webhookSecret || process.env.PAYMENT_WEBHOOK_SECRET || '';
  if (!webhookSecret) {
    if (process.env.NODE_ENV === 'production') throw new Error('PAYMENT_WEBHOOK_SECRET is required in production');
    webhookSecret = 'dev-webhook-secret';
  }
  const provider = getProvider(process.env.PAYMENT_PROVIDER || 'mock', webhookSecret);
  const mailer = createSmtpMailer();
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is required');
  await waitForRedis(redisUrl);
  const realtime = await createRealtime(redisUrl, `penny:${schema}:live`);
  const ratePrefix = opts.ratePrefix || schema;

  let engine!: Engine;
  engine = createEngine(pool, {
    clock: opts.clock,
    config: cfg,
    schema,
    onChange: async (id, kind) => {
      try {
        const st = await engine.auctionState(id);
        if (!st) return;
        await realtime.publish([id, 0], 'auction', JSON.stringify(st));
        const text = kind === 'closed'
          ? (st.winner ? `${st.winner} won ${st.name} at ${money(st.priceCents)}` : `${st.name} ended with no bids`)
          : (st.bids[0] ? `${st.bids[0].name} bid ${money(st.bids[0].price_after_cents)} on ${st.name}` : `${st.name} updated`);
        await realtime.publish([0], 'ticker', JSON.stringify({ text, at: Date.now(), kind, auctionId: id }));
      } catch (err) {
        log('error', 'publish failed', { err: err instanceof Error ? err.message : String(err), id });
      }
    },
  });

  const uploadDir = opts.uploadDir || process.env.UPLOAD_DIR || path.join(process.cwd(), 'storage', 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const storage: ObjectStorage = createStorage(uploadDir);
  if (opts.seed) {
    const lock = await pool.connect();
    try {
      await lock.query('SELECT pg_advisory_lock(874521)');
      await seed(pool, engine, uploadDir, cfg);
    } finally {
      try { await lock.query('SELECT pg_advisory_unlock(874521)'); } catch { /* connection already closed */ }
      lock.release();
    }
  }

  const topUp = async () => {
    try { await topUpDemoAuctions(pool, cfg); } catch (err) {
      log('error', 'demo top-up failed', { err: err instanceof Error ? err.message : String(err) });
    }
  };
  let topUpTimer: NodeJS.Timeout | undefined;
  if (cfg.demoMode && opts.seed) {
    await topUp();
    topUpTimer = setInterval(topUp, 5 * 60_000);
    topUpTimer.unref?.();
  }

  const stopCloser = opts.closer === false ? () => {} : await engine.startCloser();
  const heartbeat = setInterval(() => realtime.beat(), 15_000);
  heartbeat.unref?.();

  const secure = process.env.COOKIE_SECURE === '1';
  const sidCookie = { httpOnly: true, sameSite: 'lax' as const, secure, path: '/', maxAge: cfg.sessionTtlMs };
  const csrfCookie = { httpOnly: false, sameSite: 'lax' as const, secure, path: '/' };

  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use((req, res, next) => {
    const requestId = randomToken(8);
    (req as AuthedRequest).requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      `img-src 'self' data: ${storage.assetOrigins().join(' ')}`.trim(),
      "font-src 'self'",
      "connect-src 'self'",
      `media-src 'self' blob: ${storage.assetOrigins().join(' ')}`.trim(),
      "frame-src https://www.youtube-nocookie.com https://player.vimeo.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '));
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    const started = Date.now();
    res.on('finish', () => {
      if (req.path === '/healthz') return;
      log('info', 'request', { requestId, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started });
    });
    next();
  });

  app.get('/healthz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      const pong = await realtime.ping();
      if (pong !== 'PONG') throw new Error('redis');
      res.json({ ok: true, db: 'up', redis: 'up', time: Date.now() });
    } catch (err) {
      log('error', 'healthcheck failed', { err: err instanceof Error ? err.message : String(err) });
      res.status(503).json({ ok: false, error: 'unhealthy' });
    }
  });

  app.post('/api/webhooks/payments/:provider', express.raw({ type: 'application/json', limit: '200kb' }), async (req, res) => {
    if (req.params.provider !== provider.name) {
      res.status(404).json({ ok: false, error: 'unknown_provider' });
      return;
    }
    const result = await handlePaymentWebhook(pool, engine, cfg, provider, req.body as Buffer, req.get('x-payment-signature'));
    res.status(result.status).json(result.body);
  });

  app.use(cookieParser());
  app.use(express.urlencoded({ extended: false, limit: '200kb' }));
  app.use(express.json({ limit: '200kb' }));
  const upload = multer({
    dest: uploadDir,
    limits: { fileSize: VIDEO_MAX_BYTES, files: 12 },
    fileFilter: (_req, file, cb) => {
      const ok = /^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm))$/.test(file.mimetype);
      cb(null, ok);
    },
  });
  app.use((req, res, next) => {
    const ct = req.get('content-type') || '';
    if (ct.startsWith('multipart/form-data')) return upload.any()(req, res, next);
    next();
  });
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.use('/uploads', express.static(uploadDir, { maxAge: '1h' }));

  app.use(async (req, res, next) => {
    try {
      const r = req as AuthedRequest;
      const header = req.get('authorization') || '';
      const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
      let token: string | null = null;
      if (bearer) { token = bearer; r.authVia = 'bearer'; }
      else if (req.cookies?.pb_sid) {
        token = unsignSession(String(req.cookies.pb_sid), secret);
        if (token) r.authVia = 'cookie';
      }
      if (token) {
        const row = await pool.query(
          `SELECT s.csrf_token, s.expires_at, u.id, u.email, u.name, u.pass_hash, u.is_admin, u.balance, u.email_verified_at, u.created_at
             FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = $1`,
          [sha256(token)],
        );
        const found = row.rows[0];
        if (found && found.expires_at > Date.now()) {
          r.user = found as UserRow;
          r.sessionCsrf = found.csrf_token as string;
        } else {
          r.authVia = undefined;
        }
      }
      if (!req.cookies?.pb_csrf) {
        const t = randomToken(24);
        res.cookie('pb_csrf', t, csrfCookie);
        req.cookies.pb_csrf = t;
      }
      r.csrf = r.sessionCsrf || String(req.cookies.pb_csrf);
      if (r.sessionCsrf && req.cookies.pb_csrf !== r.sessionCsrf) res.cookie('pb_csrf', r.sessionCsrf, csrfCookie);
      next();
    } catch (err) { next(err); }
  });

  const frame = (req: AuthedRequest) => ({ cfg, csrf: req.csrf || '', user: req.user ? {
    id: req.user.id, name: req.user.name, email: req.user.email, balance: req.user.balance,
    is_admin: req.user.is_admin, email_verified_at: req.user.email_verified_at,
  } : null });

  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (req.path.startsWith('/api/webhooks/')) return next();
    const r = req as AuthedRequest;
    if (r.authVia === 'bearer') return next();
    const sent = req.get('x-csrf-token') || (req.body && req.body._csrf);
    const expected = r.user ? r.sessionCsrf : req.cookies?.pb_csrf;
    if (!safeEqual(typeof sent === 'string' ? sent : undefined, expected)) {
      if (req.path.startsWith('/api')) {
        res.status(403).json({ ok: false, error: 'csrf', message: 'Missing or invalid CSRF token' });
        return;
      }
      res.status(403).send(views.page({ ...frame(r), title: 'Forbidden', main: '<div class="form-card"><h1>Page expired</h1><p>Refresh and try that again. The security token did not match.</p></div>' }));
      return;
    }
    next();
  });

  async function hitLimit(res: Response, action: 'bid' | 'login' | 'signup', id: string): Promise<boolean> {
    const rule = cfg.rateLimits[action];
    const result = await rateLimit(realtime.redis, ratePrefix, action, id, rule);
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    if (!result.ok) {
      res.setHeader('Retry-After', String(result.retryAfter));
      return false;
    }
    return true;
  }

  const needUser = (req: Request, res: Response, next: NextFunction) => {
    if ((req as AuthedRequest).user) return next();
    if (req.path.startsWith('/api')) return res.status(401).json({ ok: false, error: 'login_required', message: 'Log in to bid' });
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  };
  const needAdmin = (req: Request, res: Response, next: NextFunction) => {
    const r = req as AuthedRequest;
    if (r.user?.is_admin) return next();
    return res.status(403).send(views.page({ ...frame(r), title: 'Forbidden', main: '<div class="form-card"><h1>Admins only</h1><p>That page is for operators.</p></div>' }));
  };
  const needVerified = (req: Request, res: Response, next: NextFunction) => {
    const r = req as AuthedRequest;
    if (r.user?.email_verified_at) return next();
    if (req.path.startsWith('/api')) return res.status(403).json({ ok: false, error: 'email_unverified', message: 'Verify your email to bid' });
    return res.redirect('/account');
  };

  async function loginUser(res: Response, userId: number, req: AuthedRequest) {
    await newSession(pool, userId, cfg, { ip: req.ip, ua: req.get('user-agent') }).then(async (s) => {
      res.cookie('pb_sid', signSession(s.token, secret), sidCookie);
      res.cookie('pb_csrf', s.csrf, csrfCookie);
    });
  }

  const listSql = `SELECT a.*, p.name, p.images, p.retail_cents, p.description FROM auctions a JOIN products p ON p.id = a.product_id`;

  async function attachMedia(rows: Array<{ product_id?: number; media?: PublicMedia[] }>) {
    const ids = [...new Set(rows.map((r) => r.product_id).filter((id): id is number => !!id))];
    const media = await listMediaForProducts(pool, ids);
    const by = new Map<number, PublicMedia[]>();
    for (const item of media) {
      const list = by.get(item.productId) || [];
      list.push(item);
      by.set(item.productId, list);
    }
    for (const row of rows) row.media = by.get(row.product_id || 0) || [];
  }

  async function saveUploads(productId: number, files: Express.Multer.File[] | undefined, alt: string, spin: boolean) {
    const picked = (files || []).filter((f) => f.fieldname === 'files' || f.fieldname === 'photos');
    for (const file of picked) {
      const buf = fs.readFileSync(file.path);
      fs.rmSync(file.path, { force: true });
      if (sniffVideo(buf)) await addVideo(pool, storage, productId, buf, alt);
      else if (sniffImage(buf)) {
        if (buf.length > IMAGE_MAX_BYTES) throw new HttpError(400, 'Images must be 8 MB or smaller');
        await addImage(pool, storage, productId, buf, alt, { spin });
      } else {
        throw new HttpError(400, 'Upload a PNG, JPEG, WebP, GIF, MP4, or WebM');
      }
    }
  }

  app.get('/', async (req, res, next) => {
    try {
      const t = Date.now();
      const live = (await pool.query(`${listSql} WHERE a.closed = FALSE AND a.start_at <= $1 ORDER BY a.end_at`, [t])).rows;
      const upcoming = (await pool.query(`${listSql} WHERE a.closed = FALSE AND a.start_at > $1 ORDER BY a.start_at`, [t])).rows;
      const won = (await pool.query(
        `SELECT a.id, a.product_id, a.final_price_cents, p.name, p.images, p.retail_cents, w.name AS winner
           FROM auctions a JOIN products p ON p.id = a.product_id
           LEFT JOIN users w ON w.id = a.winner_id
          WHERE a.closed = TRUE AND a.winner_id IS NOT NULL
          ORDER BY a.closed_at DESC LIMIT 6`,
      )).rows;
      await attachMedia([...live, ...upcoming, ...won]);
      const social = await getSocialProof(pool, cfg.demoMode);
      const ticker = await recentTicker(pool);
      res.setHeader('Cache-Control', 'no-store');
      res.send(views.homePage({ ...frame(req as AuthedRequest), live, upcoming, won, ticker, stats: social.stats, testimonials: social.testimonials }));
    } catch (err) { next(err); }
  });

  app.get('/auction/:id', async (req, res, next) => {
    try {
      const id = numId(req.params.id);
      if (!id) return res.status(404).send(views.messagePage({ ...frame(req as AuthedRequest), heading: 'Not found', body: 'That auction does not exist.' }));
      const row = await pool.query(`${listSql} WHERE a.id = $1`, [id]);
      if (!row.rows[0]) return res.status(404).send(views.messagePage({ ...frame(req as AuthedRequest), heading: 'Not found', body: 'That auction does not exist.' }));
      await attachMedia([row.rows[0]]);
      res.setHeader('Cache-Control', 'no-store');
      res.send(views.auctionPage({ ...frame(req as AuthedRequest), auction: row.rows[0] }));
    } catch (err) { next(err); }
  });

  app.get('/api/time', (_req, res) => res.json({ serverNow: Date.now() }));
  app.get('/api/social', async (_req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await getSocialProof(pool, cfg.demoMode));
    } catch (err) { next(err); }
  });
  app.get('/api/auctions/:id', async (req, res, next) => {
    try {
      const id = numId(req.params.id);
      const s = id ? await engine.auctionState(id) : null;
      if (!s) return res.status(404).json({ error: 'not_found' });
      res.json(s);
    } catch (err) { next(err); }
  });
  app.get('/api/me', needUser, (req, res) => {
    const u = (req as AuthedRequest).user!;
    res.json({ id: u.id, balance: u.balance, emailVerified: !!u.email_verified_at });
  });
  app.get('/api/stream', async (req, res, next) => {
    try {
      const id = Number(req.query.auction || 0) || 0;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      if (id) {
        const st = await engine.auctionState(id);
        if (st) res.write(`event: auction\ndata: ${JSON.stringify(st)}\n\n`);
      }
      realtime.add(id, res);
      req.on('close', () => realtime.remove(id, res));
    } catch (err) { next(err); }
  });

  app.post('/api/auctions/:id/bid', needUser, needVerified, async (req, res, next) => {
    try {
      const r = req as AuthedRequest;
      const id = numId(req.params.id);
      if (!id) return res.status(404).json({ ok: false, error: 'not_found', message: 'Auction not found' });
      const allowed = await hitLimit(res, 'bid', String(r.user!.id));
      if (!allowed) return res.status(429).json({ ok: false, error: 'rate_limited', message: 'Too many bids. Slow down a moment.' });
      const key = req.get('idempotency-key') || req.body?.idempotencyKey;
      const result = await engine.placeBid(id, r.user!.id, key);
      const bal = await pool.query('SELECT balance FROM users WHERE id = $1', [r.user!.id]);
      res.json({ ok: true, ...result, balance: bal.rows[0].balance, serverNow: Date.now() });
    } catch (err) { next(err); }
  });

  app.get('/login', (req, res) => {
    res.send(views.loginPage({ ...frame(req as AuthedRequest), next: safeNext(req.query.next) }));
  });
  app.post('/login', async (req, res, next) => {
    const r = req as AuthedRequest;
    try {
      const body = parse(loginSchema, req.body);
      const allowed = await hitLimit(res, 'login', req.ip || 'unknown');
      if (!allowed) return res.status(429).send(views.loginPage({ ...frame(r), error: 'Too many attempts. Try again soon.', next: safeNext(body.next) }));
      const found = await pool.query('SELECT * FROM users WHERE email = $1', [body.email]);
      const hash = found.rows[0]?.pass_hash || await dummyHash();
      const ok = await checkPw(body.password, hash);
      if (!found.rows[0] || !ok) {
        return res.status(401).send(views.loginPage({ ...frame(r), error: 'Invalid email or password', next: safeNext(body.next) }));
      }
      await loginUser(res, found.rows[0].id, r);
      res.redirect(safeNext(body.next));
    } catch (err) {
      if (err instanceof HttpError) return res.status(400).send(views.loginPage({ ...frame(r), error: err.message }));
      next(err);
    }
  });

  app.get('/signup', (req, res) => res.send(views.signupPage(frame(req as AuthedRequest))));
  app.post('/signup', async (req, res, next) => {
    const r = req as AuthedRequest;
    try {
      const body = parse(signupSchema(cfg.minPasswordLength), req.body);
      const allowed = await hitLimit(res, 'signup', req.ip || 'unknown');
      if (!allowed) return res.status(429).send(views.signupPage({ ...frame(r), error: 'Too many signups from this network. Try again later.' }));
      const id = await createUser(pool, body.email, body.name, body.password, { verified: false });
      const token = await issueEmailToken(pool, id, 'verify', cfg.verifyTokenTtlMs);
      await deliverMail(pool, mailer, {
        to: body.email,
        subject: `Verify your ${cfg.siteName} email`,
        text: `Verify your email (single use, expires in 24 hours):\n${cfg.siteUrl}/verify-email?token=${token}\n`,
      });
      await loginUser(res, id, r);
      res.redirect('/account');
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505') {
        return res.status(400).send(views.signupPage({ ...frame(r), error: 'Could not create that account. If you already signed up, log in or reset your password.' }));
      }
      if (err instanceof HttpError) return res.status(400).send(views.signupPage({ ...frame(r), error: err.message }));
      next(err);
    }
  });

  app.post('/logout', async (req, res, next) => {
    try {
      const raw = req.cookies?.pb_sid ? unsignSession(String(req.cookies.pb_sid), secret) : null;
      if (raw) await destroySession(pool, raw);
      res.clearCookie('pb_sid', sidCookie);
      res.redirect('/');
    } catch (err) { next(err); }
  });

  app.get('/forgot', (req, res) => res.send(views.forgotPage(frame(req as AuthedRequest))));
  app.post('/forgot', async (req, res, next) => {
    const r = req as AuthedRequest;
    const notice = 'If an account exists for that email, we sent a reset link. It expires in one hour and works once.';
    try {
      const body = parse(forgotSchema, req.body);
      const allowed = await hitLimit(res, 'login', 'forgot:' + (req.ip || 'unknown'));
      if (!allowed) return res.status(429).send(views.forgotPage({ ...frame(r), error: 'Too many attempts. Try again soon.' }));
      const found = await pool.query('SELECT id, email FROM users WHERE email = $1', [body.email]);
      if (found.rows[0]) {
        const token = await issueEmailToken(pool, found.rows[0].id, 'reset', cfg.resetTokenTtlMs);
        await deliverMail(pool, mailer, {
          to: found.rows[0].email,
          subject: `Reset your ${cfg.siteName} password`,
          text: `Reset your password (single use, expires in 1 hour):\n${cfg.siteUrl}/reset-password?token=${token}\nIf you did not ask, ignore this email.\n`,
        });
      } else {
        await dummyHash();
      }
      res.send(views.forgotPage({ ...frame(r), notice }));
    } catch (err) {
      if (err instanceof HttpError) return res.status(400).send(views.forgotPage({ ...frame(r), error: err.message }));
      next(err);
    }
  });

  app.get('/reset-password', (req, res) => {
    const token = String(req.query.token || '');
    res.send(views.resetPage({ ...frame(req as AuthedRequest), token }));
  });
  app.post('/reset-password', async (req, res, next) => {
    const r = req as AuthedRequest;
    let token = '';
    try {
      const body = parse(resetSchema(cfg.minPasswordLength), req.body);
      token = body.token;
      const userId = await consumeEmailToken(pool, 'reset', body.token);
      if (!userId) return res.status(400).send(views.resetPage({ ...frame(r), token, error: 'This reset link is invalid or expired.' }));
      const hash = await hashPw(body.password);
      await pool.query('UPDATE users SET pass_hash = $1 WHERE id = $2', [hash, userId]);
      await destroyUserSessions(pool, userId);
      await loginUser(res, userId, r);
      res.redirect('/account');
    } catch (err) {
      if (err instanceof HttpError) return res.status(400).send(views.resetPage({ ...frame(r), token, error: err.message }));
      next(err);
    }
  });

  app.get('/verify-email', async (req, res, next) => {
    try {
      const token = String(req.query.token || '');
      const userId = await consumeEmailToken(pool, 'verify', token);
      if (!userId) {
        return res.status(400).send(views.messagePage({ ...frame(req as AuthedRequest), heading: 'Link not valid', body: 'That verification link is invalid, expired, or already used.' }));
      }
      const user = await pool.query('SELECT email_verified_at FROM users WHERE id = $1', [userId]);
      const already = user.rows[0]?.email_verified_at;
      await pool.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, $1) WHERE id = $2', [Date.now(), userId]);
      if (!already && cfg.demoMode && cfg.signupBonusCredits > 0) {
        const prior = await pool.query(`SELECT 1 FROM ledger WHERE user_id = $1 AND kind = 'signup_bonus'`, [userId]);
        if (!prior.rowCount) await engine.grant(userId, cfg.signupBonusCredits, 'signup_bonus', 'Welcome demo credits');
      }
      res.send(views.messagePage({
        ...frame(req as AuthedRequest),
        heading: 'Email verified',
        body: `You can bid now. ${cfg.demoMode ? 'Demo credits are on your account if this was the first verification.' : ''} <a href="/account">Go to account</a>`,
      }));
    } catch (err) { next(err); }
  });

  app.post('/account/resend-verification', needUser, async (req, res, next) => {
    try {
      const r = req as AuthedRequest;
      const allowed = await hitLimit(res, 'signup', 'resend:' + r.user!.id);
      if (!allowed) return res.redirect('/account');
      if (!r.user!.email_verified_at) {
        const token = await issueEmailToken(pool, r.user!.id, 'verify', cfg.verifyTokenTtlMs);
        await deliverMail(pool, mailer, {
          to: r.user!.email,
          subject: `Verify your ${cfg.siteName} email`,
          text: `Verify your email (single use, expires in 24 hours):\n${cfg.siteUrl}/verify-email?token=${token}\n`,
        });
      }
      res.redirect('/account');
    } catch (err) { next(err); }
  });

  app.get('/account', needUser, async (req, res, next) => {
    try {
      const r = req as AuthedRequest;
      const u = r.user!;
      const fresh = await pool.query('SELECT balance, email_verified_at FROM users WHERE id = $1', [u.id]);
      u.balance = fresh.rows[0].balance;
      u.email_verified_at = fresh.rows[0].email_verified_at;
      const ledger = (await pool.query('SELECT * FROM ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 200', [u.id])).rows;
      const bids = (await pool.query('SELECT COUNT(*)::int AS c FROM bids WHERE user_id = $1', [u.id])).rows[0].c;
      const won = (await pool.query(
        `SELECT a.id, a.final_price_cents, a.checkout_status, a.shipping_status, a.tracking, p.name
           FROM auctions a JOIN products p ON p.id = a.product_id
          WHERE a.winner_id = $1 ORDER BY a.closed_at DESC`,
        [u.id],
      )).rows;
      const disputes = (await pool.query('SELECT id, auction_id, subject, message, status FROM disputes WHERE user_id = $1 ORDER BY id DESC', [u.id])).rows;
      const reviewed = (await pool.query('SELECT auction_id FROM testimonials WHERE user_id = $1 AND is_sample = FALSE', [u.id])).rows.map((x) => x.auction_id);
      const reviewable = won.filter((a) => !reviewed.includes(a.id)).map((a) => ({ id: a.id as number, name: a.name as string }));
      let verifyUrl: string | null = null;
      if (cfg.demoMode && !u.email_verified_at) {
        const mail = await pool.query(
          `SELECT body FROM mail_outbox WHERE to_email = $1 AND subject LIKE 'Verify%' ORDER BY id DESC LIMIT 1`,
          [u.email],
        );
        const m = mail.rows[0]?.body?.match(/https?:\/\/\S+/);
        verifyUrl = m ? m[0] : null;
      }
      res.send(views.accountPage({ ...frame(r), ledger, bids, won, disputes, reviewable, verifyUrl }));
    } catch (err) { next(err); }
  });

  app.post('/account/reviews', needUser, async (req, res, next) => {
    try {
      const r = req as AuthedRequest;
      const body = parse(reviewSchema, req.body);
      const won = await pool.query('SELECT id FROM auctions WHERE id = $1 AND winner_id = $2', [body.auction_id, r.user!.id]);
      if (!won.rows[0]) throw new HttpError(403, 'Only the winner can review that auction');
      const existing = await pool.query('SELECT 1 FROM testimonials WHERE user_id = $1 AND auction_id = $2 AND is_sample = FALSE', [r.user!.id, body.auction_id]);
      if (!existing.rowCount) {
        await pool.query(
          `INSERT INTO testimonials (user_id, auction_id, display_name, body, rating, status, is_sample, created_at)
           VALUES ($1, $2, $3, $4, $5, 'pending', FALSE, $6)`,
          [r.user!.id, body.auction_id, r.user!.name, body.body, body.rating, Date.now()],
        );
      }
      res.redirect('/account');
    } catch (err) { next(err); }
  });

  app.post('/disputes', needUser, async (req, res, next) => {
    try {
      const r = req as AuthedRequest;
      const body = parse(disputeSchema, req.body);
      const auctionId = body.auction_id && /^\d+$/.test(body.auction_id) ? Number(body.auction_id) : null;
      await pool.query(
        `INSERT INTO disputes (user_id, auction_id, subject, message, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'open', $5, $5)`,
        [r.user!.id, auctionId, body.subject, body.message, Date.now()],
      );
      res.redirect('/account');
    } catch (err) { next(err); }
  });

  app.get('/buy', needUser, (req, res) => res.send(views.buyPage(frame(req as AuthedRequest))));
  app.post('/buy', needUser, needVerified, async (req, res, next) => {
    try {
      const r = req as AuthedRequest;
      const credits = Number(req.body?.pack);
      const idem = typeof req.body?.idem === 'string' ? req.body.idem : undefined;
      const result = await createBidPackOrder(pool, engine, cfg, provider, { userId: r.user!.id, credits, idemKey: idem });
      if (result.checkoutPath) return res.redirect(result.checkoutPath);
      res.redirect('/account');
    } catch (err) {
      if (err instanceof BidError || err instanceof HttpError) {
        return res.status(400).send(views.buyPage({ ...frame(req as AuthedRequest), error: err.message }));
      }
      next(err);
    }
  });

  app.get('/checkout/:id', needUser, async (req, res, next) => {
    try {
      const id = numId(req.params.id);
      const row = id && await pool.query(
        `SELECT a.id, a.final_price_cents, a.checkout_status, p.name FROM auctions a JOIN products p ON p.id = a.product_id
          WHERE a.id = $1 AND a.winner_id = $2`,
        [id, (req as AuthedRequest).user!.id],
      );
      if (!row || !row.rows[0]) return res.status(404).send(views.messagePage({ ...frame(req as AuthedRequest), heading: 'No win found', body: 'That auction is not waiting on your checkout.' }));
      res.send(views.checkoutPage({ ...frame(req as AuthedRequest), auction: row.rows[0] }));
    } catch (err) { next(err); }
  });
  app.post('/checkout/:id', needUser, needVerified, async (req, res, next) => {
    const r = req as AuthedRequest;
    const id = numId(req.params.id);
    try {
      if (!id) throw new HttpError(404, 'Not found');
      const address = parse(addressSchema, req.body);
      const idem = typeof req.body?.idem === 'string' ? req.body.idem : `winner:${id}`;
      const result = await createWinnerOrder(pool, engine, cfg, provider, {
        userId: r.user!.id,
        auctionId: id,
        address: { ...address, line2: address.line2 || '' },
        idemKey: idem,
      });
      if (result.checkoutPath) return res.redirect(result.checkoutPath);
      res.redirect('/account');
    } catch (err) {
      if ((err instanceof BidError || err instanceof HttpError) && id) {
        const row = await pool.query(
          `SELECT a.id, a.final_price_cents, a.checkout_status, p.name FROM auctions a JOIN products p ON p.id = a.product_id WHERE a.id = $1`,
          [id],
        );
        if (row.rows[0]) return res.status(400).send(views.checkoutPage({ ...frame(r), auction: row.rows[0], error: err.message }));
      }
      next(err);
    }
  });

  app.get('/pay/mock/:id', needUser, async (req, res, next) => {
    try {
      const id = numId(req.params.id);
      const row = id && await pool.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [id, (req as AuthedRequest).user!.id]);
      if (!row || !row.rows[0]) return res.status(404).send(views.messagePage({ ...frame(req as AuthedRequest), heading: 'Order not found', body: 'That payment session is not yours.' }));
      const o = row.rows[0];
      res.send(views.mockPayPage({
        ...frame(req as AuthedRequest),
        order: {
          id: o.id, amount_cents: o.amount_cents, kind: o.kind, status: o.status,
          description: o.kind === 'bid_pack' ? `${o.credits} bid credits` : `Winner checkout`,
        },
      }));
    } catch (err) { next(err); }
  });
  app.post('/pay/mock/:id/complete', needUser, async (req, res, next) => {
    try {
      const r = req as AuthedRequest;
      const id = numId(req.params.id);
      const row = id && await pool.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [id, r.user!.id]);
      if (!row || !row.rows[0]) return res.status(404).send(views.messagePage({ ...frame(r), heading: 'Order not found', body: 'That payment session is not yours.' }));
      const order = row.rows[0];
      if (order.status === 'pending') {
        const event = {
          id: `mock_${order.id}_${order.provider_ref || 'ref'}`,
          type: 'payment.succeeded' as const,
          orderId: order.id as number,
          amountCents: order.amount_cents as number,
          providerRef: (order.provider_ref as string) || `mock_${order.id}`,
        };
        const raw = Buffer.from(JSON.stringify(event));
        const signature = provider.sign(raw.toString('utf8'));
        const result = await handlePaymentWebhook(pool, engine, cfg, provider, raw, signature);
        if (result.status >= 400) {
          return res.status(result.status).send(views.messagePage({ ...frame(r), heading: 'Payment not completed', body: escSafe(String(result.body.message || result.body.error)) }));
        }
      }
      res.redirect('/account');
    } catch (err) { next(err); }
  });

  app.get('/legal', (_req, res) => res.redirect('/legal/terms'));
  app.get('/policies', (_req, res) => res.redirect('/legal/refunds'));
  app.get('/legal/:slug', (req, res) => {
    const doc = legalBySlug(cfg, String(req.params.slug));
    if (!doc) return res.status(404).send(views.messagePage({ ...frame(req as AuthedRequest), heading: 'Not found', body: 'No such policy.' }));
    res.send(views.legalView({ ...frame(req as AuthedRequest), docTitle: doc.title, html: doc.html }));
  });

  app.get('/admin', needUser, needAdmin, async (req, res, next) => {
    try {
      const products = (await pool.query('SELECT * FROM products ORDER BY id DESC')).rows;
      const auctions = (await pool.query(
        `SELECT a.*, p.name, w.email AS winner_email FROM auctions a
           JOIN products p ON p.id = a.product_id
           LEFT JOIN users w ON w.id = a.winner_id
          ORDER BY a.id DESC LIMIT 100`,
      )).rows;
      const users = (await pool.query('SELECT id, email, balance FROM users ORDER BY id LIMIT 300')).rows;
      const t = Date.now();
      const counts = {
        live: auctions.filter((a) => !a.closed && a.start_at <= t).length,
        upcoming: auctions.filter((a) => !a.closed && a.start_at > t).length,
        toShip: (await pool.query(`SELECT COUNT(*)::int AS c FROM shipments WHERE status IN ('pending','processing')`)).rows[0].c as number,
        disputes: (await pool.query(`SELECT COUNT(*)::int AS c FROM disputes WHERE status <> 'resolved'`)).rows[0].c as number,
      };
      res.send(views.adminDashboard({ ...frame(req as AuthedRequest), counts, products, auctions, users, error: typeof req.query.err === 'string' ? req.query.err : undefined }));
    } catch (err) { next(err); }
  });

  app.post('/admin/products', needUser, needAdmin, async (req, res, next) => {
    try {
      const body = parse(productSchema, req.body);
      const created = await pool.query(
        `INSERT INTO products (name, description, retail_cents, inventory, images, created_at) VALUES ($1, $2, $3, $4, '[]'::jsonb, $5) RETURNING id`,
        [body.name, body.description, Math.round(body.retail * 100), body.inventory, Date.now()],
      );
      await saveUploads(created.rows[0].id as number, req.files as Express.Multer.File[] | undefined, body.name, false);
      res.redirect('/admin/products/' + created.rows[0].id + '/media');
    } catch (err) { next(err); }
  });
  app.post('/admin/products/:id', needUser, needAdmin, async (req, res, next) => {
    try {
      const id = numId(req.params.id);
      const body = parse(z.object({
        name: nameSchema,
        retail: z.coerce.number().min(0).max(1_000_000),
        inventory: z.coerce.number().int().min(0).max(1_000_000),
      }), req.body);
      const cur = await pool.query('SELECT id, name FROM products WHERE id = $1', [id]);
      if (!cur.rows[0]) throw new HttpError(404, 'Product not found');
      await pool.query(
        'UPDATE products SET name = $1, retail_cents = $2, inventory = $3 WHERE id = $4',
        [body.name, Math.round(body.retail * 100), body.inventory, id],
      );
      if (id) await saveUploads(id, req.files as Express.Multer.File[] | undefined, body.name, false);
      res.redirect('/admin');
    } catch (err) { next(err); }
  });
  app.post('/admin/auctions', needUser, needAdmin, async (req, res, next) => {
    try {
      const body = parse(scheduleSchema, req.body);
      const start = Date.parse(body.start + 'Z') + (body.tz ?? 0) * 60_000;
      if (!Number.isFinite(start)) throw new HttpError(400, 'Invalid start time');
      const end = start + body.minutes * 60_000;
      await withTx(pool, async (c) => {
        const p = await c.query('SELECT inventory FROM products WHERE id = $1 FOR UPDATE', [body.product_id]);
        if (!p.rows[0]) throw new HttpError(404, 'Product not found');
        const open = await c.query('SELECT COUNT(*)::int AS c FROM auctions WHERE product_id = $1 AND closed = FALSE', [body.product_id]);
        if ((p.rows[0].inventory as number) - (open.rows[0].c as number) < 1) {
          throw new HttpError(400, 'Not enough inventory to schedule another auction');
        }
        await c.query(
          'INSERT INTO auctions (product_id, start_at, end_at, created_at) VALUES ($1, $2, $3, $4)',
          [body.product_id, start, end, Date.now()],
        );
      });
      res.redirect('/admin');
    } catch (err) { next(err); }
  });
  app.post('/admin/refund', needUser, needAdmin, async (req, res, next) => {
    try {
      const body = parse(creditRefundSchema, req.body);
      await engine.refund((req as AuthedRequest).user!.id, body.user_id, body.credits, body.note);
      res.redirect('/admin');
    } catch (err) { next(err); }
  });
  app.post('/admin/orders/:id/refund', needUser, needAdmin, async (req, res, next) => {
    try {
      const id = numId(req.params.id);
      if (!id) throw new HttpError(404, 'Order not found');
      const body = parse(orderRefundSchema, req.body);
      await refundOrder(pool, engine, { adminId: (req as AuthedRequest).user!.id, orderId: id, reason: body.reason });
      res.redirect('/admin/shipments');
    } catch (err) { next(err); }
  });

  app.get('/admin/shipments', needUser, needAdmin, async (req, res, next) => {
    try {
      const rows = (await pool.query(
        `SELECT s.*, p.name, u.email, o.amount_cents
           FROM shipments s
           JOIN auctions a ON a.id = s.auction_id
           JOIN products p ON p.id = a.product_id
           JOIN users u ON u.id = s.user_id
           LEFT JOIN orders o ON o.id = s.order_id
          ORDER BY s.id DESC LIMIT 200`,
      )).rows;
      res.send(views.adminShipments({ ...frame(req as AuthedRequest), rows }));
    } catch (err) { next(err); }
  });
  app.post('/admin/shipments/:id', needUser, needAdmin, async (req, res, next) => {
    try {
      const id = numId(req.params.id);
      if (!id) throw new HttpError(404, 'Shipment not found');
      const body = parse(shipSchema, req.body);
      await updateShipment(pool, id, { status: body.status, tracking: body.tracking || '', carrier: body.carrier || '' });
      res.redirect('/admin/shipments');
    } catch (err) { next(err); }
  });

  app.get('/admin/disputes', needUser, needAdmin, async (req, res, next) => {
    try {
      const disputes = (await pool.query(
        `SELECT d.*, u.email FROM disputes d JOIN users u ON u.id = d.user_id ORDER BY d.status, d.id DESC`,
      )).rows;
      const notes = (await pool.query(
        `SELECT n.*, u.name AS author FROM dispute_notes n JOIN users u ON u.id = n.author_id ORDER BY n.id`,
      )).rows;
      const rows = disputes.map((d) => ({
        ...d,
        notes: notes.filter((n) => n.dispute_id === d.id).map((n) => ({ body: n.body, created_at: n.created_at, author: n.author, internal: n.internal })),
      }));
      res.send(views.adminDisputes({ ...frame(req as AuthedRequest), rows }));
    } catch (err) { next(err); }
  });
  app.post('/admin/disputes/:id', needUser, needAdmin, async (req, res, next) => {
    try {
      const r = req as AuthedRequest;
      const id = numId(req.params.id);
      if (!id) throw new HttpError(404, 'Dispute not found');
      const body = parse(noteSchema, req.body);
      const d = await pool.query('SELECT * FROM disputes WHERE id = $1', [id]);
      if (!d.rows[0]) throw new HttpError(404, 'Dispute not found');
      const at = Date.now();
      await pool.query(
        `INSERT INTO dispute_notes (dispute_id, author_id, body, internal, created_at) VALUES ($1, $2, $3, TRUE, $4)`,
        [id, r.user!.id, body.body, at],
      );
      if (body.status) await pool.query('UPDATE disputes SET status = $1, updated_at = $2 WHERE id = $3', [body.status, at, id]);
      if (body.refund && body.refund > 0) await engine.refund(r.user!.id, d.rows[0].user_id, body.refund, `Dispute #${id}`);
      res.redirect('/admin/disputes');
    } catch (err) { next(err); }
  });

  app.get('/admin/testimonials', needUser, needAdmin, async (req, res, next) => {
    try {
      const rows = (await pool.query('SELECT * FROM testimonials ORDER BY status, id DESC')).rows;
      res.send(views.adminTestimonials({ ...frame(req as AuthedRequest), rows }));
    } catch (err) { next(err); }
  });
  app.post('/admin/testimonials/:id', needUser, needAdmin, async (req, res, next) => {
    try {
      const id = numId(req.params.id);
      const body = parse(testimonialModSchema, req.body);
      await pool.query('UPDATE testimonials SET status = $1 WHERE id = $2', [body.status, id]);
      res.redirect('/admin/testimonials');
    } catch (err) { next(err); }
  });

  app.get('/admin/products/:id/media', needUser, needAdmin, async (req, res, next) => {
    try {
      const id = numId(req.params.id);
      const product = id && await pool.query('SELECT id, name FROM products WHERE id = $1', [id]);
      if (!product || !product.rows[0]) return res.status(404).send(views.messagePage({ ...frame(req as AuthedRequest), heading: 'Not found', body: 'That product does not exist.' }));
      const media = await listMedia(pool, product.rows[0].id);
      res.send(views.adminMediaPage({
        ...frame(req as AuthedRequest),
        product: product.rows[0],
        media,
        error: typeof req.query.err === 'string' ? req.query.err : undefined,
      }));
    } catch (err) { next(err); }
  });

  app.post('/admin/products/:id/media', needUser, needAdmin, async (req, res, next) => {
    try {
      const id = numId(req.params.id);
      if (!id) throw new HttpError(404, 'Product not found');
      const alt = String(req.body?.alt || '');
      const spin = req.body?.spin === '1' || req.body?.spin === 'on';
      await saveUploads(id, req.files as Express.Multer.File[] | undefined, alt, spin);
      res.redirect('/admin/products/' + id + '/media');
    } catch (err) { next(err); }
  });

  app.post('/admin/products/:id/media/embed', needUser, needAdmin, async (req, res, next) => {
    try {
      const id = numId(req.params.id);
      if (!id) throw new HttpError(404, 'Product not found');
      await addEmbed(pool, id, String(req.body?.url || ''), String(req.body?.alt || ''));
      res.redirect('/admin/products/' + id + '/media');
    } catch (err) { next(err); }
  });

  app.post('/admin/products/:id/media/reorder', needUser, needAdmin, async (req, res, next) => {
    try {
      const id = numId(req.params.id);
      if (!id) throw new HttpError(404, 'Product not found');
      const ids = String(req.body?.order || '').split(',').map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
      await reorderMedia(pool, id, ids);
      if (req.get('accept')?.includes('application/json')) return res.json({ ok: true });
      res.redirect('/admin/products/' + id + '/media');
    } catch (err) { next(err); }
  });

  app.post('/admin/products/:id/media/:mediaId', needUser, needAdmin, async (req, res, next) => {
    try {
      const id = numId(req.params.id);
      const mediaId = numId(req.params.mediaId);
      if (!id || !mediaId) throw new HttpError(404, 'Media not found');
      const action = String(req.body?.action || 'save');
      if (action === 'delete') {
        await deleteMedia(pool, storage, id, mediaId);
      } else if (action === 'up' || action === 'down') {
        const media = await listMedia(pool, id);
        const ids = media.map((m) => m.id);
        const index = ids.indexOf(mediaId);
        const swap = action === 'up' ? index - 1 : index + 1;
        if (index >= 0 && swap >= 0 && swap < ids.length) {
          const nextId = ids[swap];
          ids[swap] = ids[index];
          ids[index] = nextId;
          await reorderMedia(pool, id, ids);
        }
      } else {
        await updateMedia(pool, id, mediaId, {
          alt: req.body?.alt,
          spin: req.body?.spin === '1' || req.body?.spin === 'on',
          cover: action === 'cover',
        });
      }
      res.redirect('/admin/products/' + id + '/media');
    } catch (err) { next(err); }
  });

  app.get('/admin/outbox', needUser, needAdmin, async (req, res, next) => {
    try {
      const rows = (await pool.query('SELECT * FROM mail_outbox ORDER BY id DESC LIMIT 100')).rows;
      res.send(views.adminOutbox({ ...frame(req as AuthedRequest), rows }));
    } catch (err) { next(err); }
  });

  app.use((req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ ok: false, error: 'not_found' });
    res.status(404).send(views.messagePage({ ...frame(req as AuthedRequest), heading: 'Not found', body: 'That page is not on this board.' }));
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const r = req as AuthedRequest;
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large' : 'Upload rejected';
      if (req.path.startsWith('/api')) return res.status(400).json({ ok: false, error: 'invalid_input', message });
      return res.status(400).send(views.messagePage({ ...frame(r), heading: 'Upload rejected', body: views.esc(message) }));
    }
    if (err instanceof BidError || err instanceof HttpError) {
      const status = err instanceof HttpError ? err.status : err.code === 'not_found' ? 404 : err.code === 'bad_amount' ? 400 : 409;
      log('info', 'handled error', { requestId: r.requestId, code: err instanceof BidError ? err.code : err.code, status });
      if (req.path.startsWith('/api')) return res.status(status).json({ ok: false, error: err instanceof BidError ? err.code : err.code, message: err.message });
      return res.status(status).send(views.messagePage({ ...frame(r), heading: 'Something needs a fix', body: views.esc(err.message) }));
    }
    log('error', 'request failed', { requestId: r.requestId, err: err instanceof Error ? err.stack || err.message : String(err), path: req.path });
    if (res.headersSent) return;
    if (req.path.startsWith('/api')) return res.status(500).json({ ok: false, error: 'server_error' });
    res.status(500).send(views.page({ ...frame(r), title: 'Error', main: '<div class="form-card"><h1>Something went wrong</h1><p>The board hit an error. Try again in a moment.</p></div>' }));
  });

  return {
    app, pool, engine, cfg, provider, realtime, schema,
    close: async () => {
      stopCloser();
      if (topUpTimer) clearInterval(topUpTimer);
      clearInterval(heartbeat);
      await realtime.close();
      await pool.end();
      if (opts.dropSchema && schema !== 'public') await dropSchema(schema);
    },
  };
}

function escSafe(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}
