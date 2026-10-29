# PennyBid

A multi-instance penny (bidding-fee) auction system. Visitors watch live drops, bid with credits, and winners check out a shipping address. **Real card charging is off** until you set `PAYMENTS_ENABLED=1` and plug in a processor whose contract allows bidding-fee auctions. Stripe is not integrated and must not be added: Stripe’s restricted-business list prohibits this model. The only provider in this repo is a mock that signs webhooks and never sees a card number.

Demo mode is on by default for local development. It seeds accounts, free credits, and **sample** reviews. Sample reviews and the stats strip carry a visible **Sample content** label. That label and those reviews are not rendered when `DEMO_MODE=0`, even if the rows are still in the database. Counts on the site are `COUNT`/`SUM` queries, not hardcoded marketing numbers.

## Local setup

Requirements: Node 20+, Postgres 16, Redis 7.

```bash
cp .env.example .env
# put a long SESSION_SECRET and PAYMENT_WEBHOOK_SECRET in .env

# create the role and database if you have not already
# sudo -u postgres psql -c "CREATE USER penny WITH PASSWORD 'penny' SUPERUSER;"
# sudo -u postgres psql -c "CREATE DATABASE penny OWNER penny;"

npm install
npm start          # http://127.0.0.1:4317
npm test           # needs DATABASE_URL pointing at an empty-able database (see script)
npm run typecheck
```

`npm start` loads `.env`, migrates, and (when `SEED` is not `0`) seeds on first boot.

### Demo logins (only when `DEMO_MODE=1`)

| Role | Email | Password |
|---|---|---|
| Admin | admin@demo.test | admin123 |
| Bidder | alice@demo.test, bob@demo.test, carol@demo.test | demo123 |

New signups get 20 demo credits **after** they verify their email. With no SMTP server, open **Admin → Outbox** or, in demo mode, the verification link shown on the account page.

## Docker

`docker compose` runs Postgres, Redis, two app instances, and nginx in front of them. Compose overrides `DATABASE_URL` and `REDIS_URL` to the service hostnames, so the same `.env` works for `npm start` (localhost) and Compose (service DNS).

```bash
cp .env.example .env
docker compose up --build
# http://127.0.0.1:4317  (nginx → app1 / app2)
```

Uploads are a shared volume. Both apps migrate on boot; seeding takes a Postgres advisory lock so only one instance inserts the demo rows. SSE does not need sticky sessions: a bid publishes on Redis and every instance writes the event to its own clients.

The image is Node 20, runs as `node`, and uses `tini` so SIGTERM reaches the process. Shutdown stops the closer, ends SSE clients, and closes Postgres and Redis.

## Environment

| Variable | Purpose |
|---|---|
| `PORT` | App listen port. Default `4317`. |
| `DATABASE_URL` | Postgres connection string. |
| `REDIS_URL` | Redis, used for SSE pub/sub and rate limits. |
| `DB_SCHEMA` | Schema / search_path. Default `public`. Tests use a private schema. |
| `SESSION_SECRET` | **Required**, 16+ characters. Signs the session cookie. |
| `DEMO_MODE` | `1` shows labeled sample reviews and the sample stats banner, and allows free demo credit packs. `0` hides every `is_sample` testimonial and the sample label. Production default is off. |
| `SEED` | `0` skips seeding. |
| `PAYMENTS_ENABLED` | Must stay `0` until a processor is approved. |
| `PAYMENT_PROVIDER` | Only `mock` is implemented. Anything else refuses to boot. |
| `PAYMENT_WEBHOOK_SECRET` | HMAC key for `X-Payment-Signature`. Required in production. |
| `SITE_URL` | Absolute URL used in email links and share buttons. |
| `COMPANY_NAME`, `SUPPORT_EMAIL`, `JURISDICTION` | Substituted into the draft legal pages. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Used only when seeding with `DEMO_MODE=0`. |
| `UPLOAD_DIR` | Local product files when `STORAGE_DRIVER=local`. |
| `STORAGE_DRIVER` | `local` (default) or `s3`. |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_BASE_URL`, `S3_FORCE_PATH_STYLE` | S3-compatible media storage. Public URLs are the base plus the object key. |
| `TRUST_PROXY` | Set `1` behind nginx so rate limits see the client IP. |
| `COOKIE_SECURE` | Set `1` on HTTPS. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Optional. Mail is always copied to the admin outbox. |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error`. JSON lines on stdout. |

Auction rules themselves are constants in `src/config.ts` (credit cost, $0.01 increment, 10s reset, pack sizes, shipping, signup bonus). Change them there and restart. The legal pages read the same object.

## Architecture

```
browser ── HTTP/SSE ── nginx ── app1 ── Postgres (source of truth)
                         └── app2 ── Redis (pub/sub + rate limits)
```

* **Bids** run in one transaction. The auction row is locked (`SELECT … FOR UPDATE`), the idempotency key is re-read after that lock, then the bid is inserted, the ledger is appended, and the price and deadline move. A failure rolls all of it back. `users.balance` has `CHECK (balance >= 0)`.
* **Idempotency.** `UNIQUE (user_id, idem_key)` on `bids`. The same key returns the original bid and does not charge again. A key reused on a different auction is rejected.
* **Deadline.** The server clock wins. A bid at or after `end_at` is rejected even if the closer has not run. A bid inside the last 10 seconds sets the remaining time to 10 seconds. The current leader cannot bid again.
* **Close exactly once.** A closer sweeps on startup and every 200ms. An advisory lock keeps a single instance sweeping; the actual guarantee is `UPDATE … WHERE closed = FALSE AND end_at <= $now` plus a unique partial index on the `closed` event. A second process, or a restart, does not close again or pick a second winner. Inventory decrements in that same transaction when there is a winner.
* **Ledger and bids are append-only.** Triggers reject `UPDATE`, `DELETE`, and `TRUNCATE`.
* **Live updates.** `GET /api/stream` is SSE. The instance that accepted the bid publishes on Redis; every instance, including the publisher, delivers to its local clients. Clients also refetch state when the stream reconnects. The homepage ticker is those same events plus a query of recent rows — it is not fabricated copy.
* **Sessions.** Random token, only the SHA-256 stored. The cookie is `token.hmac` using `SESSION_SECRET`, HttpOnly, SameSite=Lax. CSRF is a synchronizer token for cookie sessions. `Authorization: Bearer` is for non-browser clients and is exempt from CSRF because the browser will not attach it automatically.
* **Rate limits** are Redis fixed windows, shared by every instance: bids per user, login (and forgot-password) per IP, signup per IP.
* **Passwords** are argon2id. Login verifies against a dummy hash when the email does not exist.
* **Mail.** Verification and reset links are single-use (`used_at`) and expire (24h / 1h). Requesting a new link retires the previous one. Password reset revokes every session.
* **Payments.** `PaymentProvider` is `createPayment`, `sign`, `verify`, `parseEvent`. Orders start `pending`. `POST /api/webhooks/payments/mock` checks the HMAC, inserts `payment_events` with `ON CONFLICT DO NOTHING`, locks the order, and grants credits or creates the shipment only when status is still `pending`. A replay or a second event id does not grant twice. While payments are disabled, demo packs and winner checkout are marked `provider = demo` and the webhook returns 403.
* **Fulfillment.** Winner checkout stores a shipping address. Admin shipments track status and a tracking number. Order refunds reverse demo or paid credit packs through the ledger, cancel the shipment, and put the inventory unit back if this win had decremented it. Credit refunds are their own ledger entries. Dispute tickets have internal notes that the customer page does not render.
* **Product media.** `product_media` stores ordered images, uploaded MP4/WebM, and YouTube/Vimeo embeds, with one cover image. Uploads are checked by type and size, turned into WebP srcset variants, and written through a storage interface (local disk, or S3-compatible when `STORAGE_DRIVER=s3`). The auction page is a gallery with a thumbnail strip, zoom, a fullscreen lightbox, and an optional 360 spin. Cards use the cover and can preview the next frame or a muted clip.
* **Social proof.** `GET /api/social` and the homepage use one query: approved testimonials, and `is_sample = true` rows only when `demoMode` is true. A query-string flag cannot turn them on.

## Tests

`npm test` runs 17 `node:test` cases against Postgres and Redis (the script points at `penny_test` on localhost). They cover the original deadline, concurrency, idempotency, and crash-restart guarantees, plus SSE fanout between two processes in one Node process, CSRF, shared Redis rate limits, verification and reset tokens, webhook signatures and exactly-once fulfillment, checkout / shipment / refund / dispute notes, and demo-content gating.

## Launch checklist

Do not take this live because the tests pass.

- [ ] Counsel reviews the draft Terms, Auction rules, Refunds & outages, and Privacy pages (`/legal/*`). They are generated from config, marked **DRAFT FOR LEGAL REVIEW**, and are not in effect. Penny auctions are regulated as gambling or sweepstakes in some jurisdictions.
- [ ] Confirm you will not operate where the model is prohibited, and set `JURISDICTION`, `COMPANY_NAME`, and `SUPPORT_EMAIL`.
- [ ] Contract a processor that **explicitly** accepts bidding-fee auctions. Do not use Stripe. Implement that processor behind `PaymentProvider`. Keep `PAYMENTS_ENABLED=0` until then.
- [ ] Set `DEMO_MODE=0` and `SEED=0`. Sample testimonials must not be approved into production, and the sample label must not appear. Confirm with `DEMO_MODE=0` against a database that still contains sample rows.
- [ ] Replace `SESSION_SECRET` and `PAYMENT_WEBHOOK_SECRET`. Set `COOKIE_SECURE=1`, `TRUST_PROXY=1`, and serve HTTPS.
- [ ] Configure SMTP. Restrict who can open the admin outbox; it stores message bodies.
- [ ] Change the Postgres password (Compose ships `penny`/`penny` for local use only) and back the database up. The ledger is the balance of record.
- [ ] Delete demo accounts if any were seeded. Create the real admin with `ADMIN_EMAIL` / `ADMIN_PASSWORD` before the first boot, or insert one yourself.
- [ ] Re-read `src/config.ts` (bid price, reset window, shipping, pack sizes) and make sure the public rules page matches what you intend to enforce.
- [ ] Load-test the closer and the bid transaction on more than two instances before a drop.
