import sharp from 'sharp';
import { Pool } from 'pg';
import { withTx } from './db';
import { HttpError } from './validate';
import { ObjectStorage } from './storage';

export const IMAGE_MAX_BYTES = 8_000_000;
export const VIDEO_MAX_BYTES = 32_000_000;

const VARIANT_WIDTHS = { thumb: 320, sm: 640, md: 960, lg: 1600 } as const;

export type MediaKind = 'image' | 'video' | 'embed';

export type MediaRow = {
  id: number;
  product_id: number;
  kind: MediaKind;
  url: string;
  poster_url: string | null;
  alt: string;
  sort_order: number;
  is_cover: boolean;
  is_spin: boolean;
  width: number | null;
  height: number | null;
  variants: Record<string, string>;
  storage_keys: Record<string, string>;
  mime: string | null;
  bytes: number | null;
  provider: string;
  embed_provider: string | null;
  created_at: number;
};

export type PublicMedia = {
  id: number;
  productId: number;
  kind: MediaKind;
  url: string;
  posterUrl: string | null;
  alt: string;
  isCover: boolean;
  isSpin: boolean;
  width: number | null;
  height: number | null;
  variants: { thumb?: string; sm?: string; md?: string; lg?: string };
};

function toPublic(row: MediaRow): PublicMedia {
  const v = row.variants || {};
  return {
    id: row.id,
    productId: row.product_id,
    kind: row.kind,
    url: row.url,
    posterUrl: row.poster_url,
    alt: row.alt,
    isCover: row.is_cover,
    isSpin: row.is_spin,
    width: row.width,
    height: row.height,
    variants: { thumb: v.thumb, sm: v.sm, md: v.md, lg: v.lg },
  };
}

export function sniffImage(buf: Buffer): 'png' | 'jpeg' | 'webp' | 'gif' | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (buf.length >= 6 && buf.subarray(0, 3).toString() === 'GIF') return 'gif';
  return null;
}

export function sniffVideo(buf: Buffer): 'mp4' | 'webm' | null {
  if (buf.length >= 12 && buf.subarray(4, 8).toString() === 'ftyp') return 'mp4';
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  return null;
}

export function parseEmbed(raw: string): { provider: 'youtube' | 'vimeo'; embedUrl: string; id: string } | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com' || host === 'm.youtube.com') {
    let id = '';
    if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0] || '';
    else if (url.pathname.startsWith('/embed/')) id = url.pathname.split('/')[2] || '';
    else if (url.pathname.startsWith('/shorts/')) id = url.pathname.split('/')[2] || '';
    else id = url.searchParams.get('v') || '';
    if (!/^[\w-]{11}$/.test(id)) return null;
    return { provider: 'youtube', id, embedUrl: `https://www.youtube-nocookie.com/embed/${id}` };
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = url.pathname.split('/').filter(Boolean).pop() || '';
    if (!/^\d{6,12}$/.test(id)) return null;
    return { provider: 'vimeo', id, embedUrl: `https://player.vimeo.com/video/${id}` };
  }
  return null;
}

function cleanAlt(alt: string): string {
  const text = alt.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!text) throw new HttpError(400, 'Alt text is required');
  if (text.length > 300) throw new HttpError(400, 'Alt text must be 300 characters or fewer');
  return text;
}

async function nextOrder(pool: Pool, productId: number): Promise<number> {
  const row = await pool.query('SELECT COALESCE(MAX(sort_order), -1)::int AS m FROM product_media WHERE product_id = $1', [productId]);
  return (row.rows[0].m as number) + 1;
}

async function hasCover(pool: Pool, productId: number): Promise<boolean> {
  const row = await pool.query('SELECT 1 FROM product_media WHERE product_id = $1 AND is_cover LIMIT 1', [productId]);
  return !!row.rowCount;
}

export async function syncImageCache(pool: Pool, productId: number): Promise<void> {
  await pool.query(
    `UPDATE products SET images = COALESCE((
        SELECT jsonb_agg(to_jsonb(url) ORDER BY is_cover DESC, sort_order, id)
          FROM product_media WHERE product_id = $1 AND kind = 'image'
      ), '[]'::jsonb)
      WHERE id = $1`,
    [productId],
  );
}

export async function listMedia(pool: Pool, productId: number): Promise<PublicMedia[]> {
  const rows = await pool.query(
    'SELECT * FROM product_media WHERE product_id = $1 ORDER BY sort_order, id',
    [productId],
  );
  return (rows.rows as MediaRow[]).map(toPublic);
}

export async function listMediaForProducts(pool: Pool, productIds: number[]): Promise<PublicMedia[]> {
  if (!productIds.length) return [];
  const rows = await pool.query(
    'SELECT * FROM product_media WHERE product_id = ANY($1::int[]) ORDER BY product_id, sort_order, id',
    [productIds],
  );
  return (rows.rows as MediaRow[]).map(toPublic);
}

async function posterBuffer(label: string): Promise<Buffer> {
  const safe = label.replace(/[<>&]/g, '').slice(0, 40);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1a1024"/><stop offset="1" stop-color="#8c1d40"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="640" cy="340" r="70" fill="none" stroke="#7af6ea" stroke-width="8"/>
    <polygon points="620,300 620,380 690,340" fill="#7af6ea"/>
    <text x="640" y="500" fill="#f7f4fb" font-size="36" font-family="sans-serif" text-anchor="middle">${safe}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 76 }).toBuffer();
}

export async function addImage(
  pool: Pool,
  storage: ObjectStorage,
  productId: number,
  input: Buffer,
  alt: string,
  opts: { spin?: boolean; cover?: boolean } = {},
): Promise<PublicMedia> {
  const text = cleanAlt(alt);
  if (input.length > IMAGE_MAX_BYTES) throw new HttpError(400, 'Images must be 8 MB or smaller');
  if (!sniffImage(input)) throw new HttpError(400, 'Upload a PNG, JPEG, WebP, or GIF');
  let meta: { width?: number; height?: number };
  try {
    meta = await sharp(input, { limitInputPixels: 40_000_000, animated: false }).metadata();
  } catch {
    throw new HttpError(400, 'That image could not be read');
  }
  const exists = await pool.query('SELECT 1 FROM products WHERE id = $1', [productId]);
  if (!exists.rowCount) throw new HttpError(404, 'Product not found');
  const order = await nextOrder(pool, productId);
  const cover = opts.cover || !(await hasCover(pool, productId));
  const inserted = await pool.query(
    `INSERT INTO product_media (product_id, kind, url, alt, sort_order, is_cover, is_spin, provider, mime, bytes, created_at)
     VALUES ($1, 'image', 'pending', $2, $3, FALSE, $4, $5, $6, $7, $8) RETURNING id`,
    [productId, text, order, !!opts.spin, storage.name, 'image/webp', input.length, Date.now()],
  );
  const id = inserted.rows[0].id as number;
  const keys: Record<string, string> = {};
  const urls: Record<string, string> = {};
  try {
    if (cover) {
      await pool.query('UPDATE product_media SET is_cover = FALSE WHERE product_id = $1', [productId]);
    }
    for (const [name, width] of Object.entries(VARIANT_WIDTHS)) {
      const buf = await sharp(input, { limitInputPixels: 40_000_000, animated: false })
        .rotate()
        .resize({ width, withoutEnlargement: false })
        .webp({ quality: 78 })
        .toBuffer();
      const key = `media/${productId}/${id}-${name}.webp`;
      keys[name] = key;
      urls[name] = await storage.put(key, buf, 'image/webp');
    }
    await pool.query(
      `UPDATE product_media
          SET url = $2, variants = $3::jsonb, storage_keys = $4::jsonb, is_cover = $5, width = $6, height = $7
        WHERE id = $1`,
      [id, urls.lg, JSON.stringify(urls), JSON.stringify(keys), cover, meta.width || null, meta.height || null],
    );
    await syncImageCache(pool, productId);
  } catch (err) {
    await pool.query('DELETE FROM product_media WHERE id = $1', [id]);
    await Promise.all(Object.values(keys).map((key) => storage.remove(key).catch(() => {})));
    throw err;
  }
  const row = await pool.query('SELECT * FROM product_media WHERE id = $1', [id]);
  return toPublic(row.rows[0] as MediaRow);
}

export async function addVideo(pool: Pool, storage: ObjectStorage, productId: number, input: Buffer, alt: string): Promise<PublicMedia> {
  const text = cleanAlt(alt);
  if (input.length > VIDEO_MAX_BYTES) throw new HttpError(400, 'Videos must be 32 MB or smaller');
  const kind = sniffVideo(input);
  if (!kind) throw new HttpError(400, 'Upload an MP4 or WebM video');
  const exists = await pool.query('SELECT 1 FROM products WHERE id = $1', [productId]);
  if (!exists.rowCount) throw new HttpError(404, 'Product not found');
  const order = await nextOrder(pool, productId);
  const mime = kind === 'mp4' ? 'video/mp4' : 'video/webm';
  const inserted = await pool.query(
    `INSERT INTO product_media (product_id, kind, url, alt, sort_order, provider, mime, bytes, created_at)
     VALUES ($1, 'video', 'pending', $2, $3, $4, $5, $6, $7) RETURNING id`,
    [productId, text, order, storage.name, mime, input.length, Date.now()],
  );
  const id = inserted.rows[0].id as number;
  const videoKey = `media/${productId}/${id}.${kind}`;
  const posterKey = `media/${productId}/${id}-poster.webp`;
  try {
    const url = await storage.put(videoKey, input, mime);
    const poster = await posterBuffer(text);
    const posterUrl = await storage.put(posterKey, poster, 'image/webp');
    await pool.query(
      `UPDATE product_media SET url = $2, poster_url = $3, storage_keys = $4::jsonb WHERE id = $1`,
      [id, url, posterUrl, JSON.stringify({ original: videoKey, poster: posterKey })],
    );
  } catch (err) {
    await pool.query('DELETE FROM product_media WHERE id = $1', [id]);
    await storage.remove(videoKey).catch(() => {});
    await storage.remove(posterKey).catch(() => {});
    throw err;
  }
  const row = await pool.query('SELECT * FROM product_media WHERE id = $1', [id]);
  return toPublic(row.rows[0] as MediaRow);
}

export async function addEmbed(pool: Pool, productId: number, pageUrl: string, alt: string): Promise<PublicMedia> {
  const text = cleanAlt(alt);
  const parsed = parseEmbed(pageUrl);
  if (!parsed) throw new HttpError(400, 'Use a YouTube or Vimeo https link');
  const exists = await pool.query('SELECT 1 FROM products WHERE id = $1', [productId]);
  if (!exists.rowCount) throw new HttpError(404, 'Product not found');
  const order = await nextOrder(pool, productId);
  const row = await pool.query(
    `INSERT INTO product_media (product_id, kind, url, alt, sort_order, provider, embed_provider, mime, created_at)
     VALUES ($1, 'embed', $2, $3, $4, 'embed', $5, 'text/html', $6) RETURNING *`,
    [productId, parsed.embedUrl, text, order, parsed.provider, Date.now()],
  );
  return toPublic(row.rows[0] as MediaRow);
}

export async function updateMedia(
  pool: Pool,
  productId: number,
  mediaId: number,
  patch: { alt?: string; spin?: boolean; cover?: boolean },
): Promise<void> {
  const cur = await pool.query('SELECT * FROM product_media WHERE id = $1 AND product_id = $2', [mediaId, productId]);
  const row = cur.rows[0] as MediaRow | undefined;
  if (!row) throw new HttpError(404, 'Media not found');
  if (patch.alt !== undefined) {
    const text = cleanAlt(patch.alt);
    await pool.query('UPDATE product_media SET alt = $1 WHERE id = $2', [text, mediaId]);
  }
  if (patch.spin !== undefined) {
    if (row.kind !== 'image') throw new HttpError(400, 'Only images can join a 360 spin');
    await pool.query('UPDATE product_media SET is_spin = $1 WHERE id = $2', [!!patch.spin, mediaId]);
  }
  if (patch.cover) {
    if (row.kind !== 'image') throw new HttpError(400, 'The cover has to be an image');
    await withTx(pool, async (c) => {
      await c.query('UPDATE product_media SET is_cover = FALSE WHERE product_id = $1', [productId]);
      await c.query('UPDATE product_media SET is_cover = TRUE WHERE id = $1 AND product_id = $2 AND kind = \'image\'', [mediaId, productId]);
    });
    await syncImageCache(pool, productId);
  }
}

export async function deleteMedia(pool: Pool, storage: ObjectStorage, productId: number, mediaId: number): Promise<void> {
  const cur = await pool.query('SELECT * FROM product_media WHERE id = $1 AND product_id = $2', [mediaId, productId]);
  const row = cur.rows[0] as MediaRow | undefined;
  if (!row) throw new HttpError(404, 'Media not found');
  const keys = Object.values(row.storage_keys || {});
  await pool.query('DELETE FROM product_media WHERE id = $1', [mediaId]);
  await Promise.all(keys.map((key) => storage.remove(key).catch(() => {})));
  if (row.is_cover) {
    const next = await pool.query(
      `SELECT id FROM product_media WHERE product_id = $1 AND kind = 'image' ORDER BY sort_order, id LIMIT 1`,
      [productId],
    );
    if (next.rows[0]) {
      await pool.query('UPDATE product_media SET is_cover = TRUE WHERE id = $1', [next.rows[0].id]);
    }
  }
  await syncImageCache(pool, productId);
}

export async function reorderMedia(pool: Pool, productId: number, ids: number[]): Promise<void> {
  await withTx(pool, async (c) => {
    const rows = await c.query('SELECT id FROM product_media WHERE product_id = $1 ORDER BY id', [productId]);
    const have = rows.rows.map((r) => r.id as number);
    const unique = new Set(ids);
    if (ids.length !== have.length || unique.size !== have.length || have.some((id) => !unique.has(id))) {
      throw new HttpError(400, 'Reorder must list every media item once');
    }
    for (let i = 0; i < ids.length; i++) {
      await c.query('UPDATE product_media SET sort_order = $1 WHERE id = $2 AND product_id = $3', [i, ids[i], productId]);
    }
  });
  await syncImageCache(pool, productId);
}
