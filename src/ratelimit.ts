import Redis from 'ioredis';
import { RateRule } from './config';

export async function rateLimit(
  redis: Redis,
  prefix: string,
  action: string,
  id: string,
  rule: RateRule,
): Promise<{ ok: boolean; remaining: number; retryAfter: number }> {
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / rule.windowSec);
  const key = `rl:${prefix}:${action}:${id}:${bucket}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, rule.windowSec + 1);
  const resetIn = rule.windowSec - (now % rule.windowSec);
  if (n > rule.limit) return { ok: false, remaining: 0, retryAfter: resetIn };
  return { ok: true, remaining: rule.limit - n, retryAfter: resetIn };
}
