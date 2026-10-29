import crypto from 'crypto';
import argon2 from 'argon2';
import { Pool, PoolClient } from 'pg';
import { Config } from './config';

const hashOpts = (): argon2.Options => ({
  type: argon2.argon2id,
  memoryCost: process.env.NODE_ENV === 'test' ? 4096 : 19456,
  timeCost: process.env.NODE_ENV === 'test' ? 1 : 2,
  parallelism: 1,
});

let dummyHashPromise: Promise<string> | null = null;

export function hashPw(pw: string): Promise<string> {
  return argon2.hash(pw, hashOpts());
}

export async function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPw('timing-pad-not-a-password');
  return dummyHashPromise;
}

export async function checkPw(pw: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function signSession(token: string, secret: string): string {
  const sig = crypto.createHmac('sha256', secret).update(token).digest('base64url');
  return `${token}.${sig}`;
}

export function unsignSession(value: string, secret: string): string | null {
  const i = value.lastIndexOf('.');
  if (i <= 0) return null;
  const token = value.slice(0, i);
  const sig = value.slice(i + 1);
  const expected = crypto.createHmac('sha256', secret).update(token).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return token;
}

export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export type UserRow = {
  id: number;
  email: string;
  name: string;
  pass_hash: string;
  is_admin: boolean;
  balance: number;
  email_verified_at: number | null;
  created_at: number;
};

export async function createUser(
  pool: Pool,
  email: string,
  name: string,
  pw: string,
  opts: { isAdmin?: boolean; verified?: boolean } = {},
): Promise<number> {
  const hash = await hashPw(pw);
  const now = Date.now();
  const verified = opts.verified === false ? null : now;
  const row = await pool.query(
    `INSERT INTO users (email, name, pass_hash, is_admin, email_verified_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [email.toLowerCase().trim(), name.trim(), hash, !!opts.isAdmin, verified, now],
  );
  return row.rows[0].id as number;
}

export async function newSession(
  pool: Pool,
  userId: number,
  cfg: Config,
  meta: { ip?: string; ua?: string } = {},
): Promise<{ token: string; csrf: string }> {
  const token = randomToken(32);
  const csrf = randomToken(32);
  const now = Date.now();
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [sha256(token), userId, csrf, now, now + cfg.sessionTtlMs, meta.ua?.slice(0, 300) || null, meta.ip?.slice(0, 80) || null],
  );
  return { token, csrf };
}

export async function destroySession(pool: Pool, token: string): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

export async function destroyUserSessions(client: Pool | PoolClient, userId: number): Promise<void> {
  await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

export type EmailPurpose = 'verify' | 'reset';

export async function issueEmailToken(
  pool: Pool,
  userId: number,
  purpose: EmailPurpose,
  ttlMs: number,
): Promise<string> {
  const raw = randomToken(32);
  const now = Date.now();
  await pool.query(
    `UPDATE email_tokens SET used_at = $1 WHERE user_id = $2 AND purpose = $3 AND used_at IS NULL`,
    [now, userId, purpose],
  );
  await pool.query(
    `INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, purpose, sha256(raw), now + ttlMs, now],
  );
  return raw;
}

/** Consume a single-use token. Returns the user id, or null if missing, expired, or already used. */
export async function consumeEmailToken(
  pool: Pool,
  purpose: EmailPurpose,
  raw: string,
): Promise<number | null> {
  if (!raw || raw.length > 200) return null;
  const now = Date.now();
  const row = await pool.query(
    `UPDATE email_tokens SET used_at = $1
     WHERE token_hash = $2 AND purpose = $3 AND used_at IS NULL AND expires_at > $1
     RETURNING user_id`,
    [now, sha256(raw), purpose],
  );
  return row.rows[0]?.user_id ?? null;
}
