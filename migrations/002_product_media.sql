-- Ordered images, uploaded videos, and YouTube/Vimeo embeds for a product.
-- At most one cover, and the cover is always an image.

CREATE TABLE product_media (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'embed')),
  url TEXT NOT NULL,
  poster_url TEXT,
  alt TEXT NOT NULL CHECK (length(btrim(alt)) > 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_cover BOOLEAN NOT NULL DEFAULT FALSE,
  is_spin BOOLEAN NOT NULL DEFAULT FALSE,
  width INTEGER,
  height INTEGER,
  variants JSONB NOT NULL DEFAULT '{}'::jsonb,
  storage_keys JSONB NOT NULL DEFAULT '{}'::jsonb,
  mime TEXT,
  bytes INTEGER,
  provider TEXT NOT NULL DEFAULT 'local',
  embed_provider TEXT,
  created_at BIGINT NOT NULL,
  CHECK (NOT is_cover OR kind = 'image'),
  CHECK (NOT is_spin OR kind = 'image'),
  CHECK (embed_provider IS NULL OR embed_provider IN ('youtube', 'vimeo'))
);

CREATE UNIQUE INDEX product_media_one_cover ON product_media (product_id) WHERE is_cover;
CREATE INDEX product_media_order ON product_media (product_id, sort_order, id);
