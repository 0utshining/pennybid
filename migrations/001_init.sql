-- PennyBid core schema. Append-only ledger and bids are enforced by triggers.

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  email_verified_at BIGINT,
  created_at BIGINT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  user_agent TEXT,
  ip TEXT
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE email_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at BIGINT NOT NULL,
  used_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX email_tokens_user ON email_tokens (user_id, purpose);

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  retail_cents INTEGER NOT NULL DEFAULT 0 CHECK (retail_cents >= 0),
  inventory INTEGER NOT NULL DEFAULT 0 CHECK (inventory >= 0),
  images JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at BIGINT NOT NULL
);

CREATE TABLE auctions (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  start_at BIGINT NOT NULL,
  end_at BIGINT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  bid_count INTEGER NOT NULL DEFAULT 0 CHECK (bid_count >= 0),
  last_bidder_id INTEGER REFERENCES users(id),
  closed BOOLEAN NOT NULL DEFAULT FALSE,
  winner_id INTEGER REFERENCES users(id),
  final_price_cents INTEGER,
  closed_at BIGINT,
  checkout_status TEXT NOT NULL DEFAULT 'none',
  shipping_status TEXT NOT NULL DEFAULT 'none',
  tracking TEXT,
  stock_decremented BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  CHECK (end_at >= start_at)
);
CREATE INDEX auctions_due ON auctions (end_at) WHERE closed = FALSE;
CREATE INDEX auctions_product_open ON auctions (product_id) WHERE closed = FALSE;

CREATE TABLE bids (
  id SERIAL PRIMARY KEY,
  auction_id INTEGER NOT NULL REFERENCES auctions(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  price_after_cents INTEGER NOT NULL,
  end_at_after BIGINT NOT NULL,
  idem_key TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (user_id, idem_key)
);
CREATE INDEX bids_auction ON bids (auction_id, id DESC);

CREATE TABLE ledger (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  kind TEXT NOT NULL,
  ref TEXT,
  note TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX ledger_user ON ledger (user_id, id DESC);

CREATE TABLE auction_events (
  id SERIAL PRIMARY KEY,
  auction_id INTEGER NOT NULL REFERENCES auctions(id),
  kind TEXT NOT NULL,
  data JSONB,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX one_close ON auction_events (auction_id) WHERE kind = 'closed';

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('bid_pack', 'winner_checkout')),
  auction_id INTEGER REFERENCES auctions(id),
  credits INTEGER,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'fulfilled', 'refunded', 'failed', 'cancelled')),
  provider TEXT,
  provider_ref TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  shipping JSONB,
  created_at BIGINT NOT NULL,
  fulfilled_at BIGINT
);
CREATE UNIQUE INDEX one_winner_order ON orders (auction_id) WHERE kind = 'winner_checkout';
CREATE INDEX orders_user ON orders (user_id, id DESC);

CREATE TABLE payment_events (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  order_id INTEGER REFERENCES orders(id),
  payload JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (provider, event_id)
);

CREATE TABLE shipments (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id),
  auction_id INTEGER NOT NULL REFERENCES auctions(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'shipped', 'delivered', 'cancelled')),
  carrier TEXT,
  tracking TEXT,
  address JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX shipments_status ON shipments (status, id DESC);

CREATE TABLE refunds (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  order_id INTEGER REFERENCES orders(id),
  auction_id INTEGER REFERENCES auctions(id),
  kind TEXT NOT NULL CHECK (kind IN ('credit', 'order')),
  credits INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  admin_id INTEGER NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL
);

CREATE TABLE disputes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  auction_id INTEGER REFERENCES auctions(id),
  order_id INTEGER REFERENCES orders(id),
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX disputes_status ON disputes (status, id DESC);

CREATE TABLE dispute_notes (
  id SERIAL PRIMARY KEY,
  dispute_id INTEGER NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  internal BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL
);

CREATE TABLE testimonials (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  auction_id INTEGER REFERENCES auctions(id),
  display_name TEXT NOT NULL,
  body TEXT NOT NULL,
  rating INTEGER CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  is_sample BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL
);
CREATE INDEX testimonials_public ON testimonials (status, is_sample, id DESC);

CREATE TABLE mail_outbox (
  id SERIAL PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON ledger
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER bids_no_update BEFORE UPDATE ON bids
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER bids_no_delete BEFORE DELETE ON bids
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER bids_no_truncate BEFORE TRUNCATE ON bids
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
