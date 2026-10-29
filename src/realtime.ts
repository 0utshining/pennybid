import Redis from 'ioredis';
import { Response } from 'express';
import { log } from './logger';

export type Realtime = {
  redis: Redis;
  publish(targets: number[], event: string, data: string): Promise<void>;
  add(auctionId: number, res: Response): void;
  remove(auctionId: number, res: Response): void;
  beat(): void;
  ping(): Promise<string>;
  close(): Promise<void>;
};

function redisOpts(url: string) {
  return {
    connectTimeout: 5_000,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  };
}

export async function waitForRedis(url: string, tries = 30): Promise<void> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    const client = new Redis(url, { ...redisOpts(url), maxRetriesPerRequest: 1 });
    try {
      const pong = await client.ping();
      if (pong === 'PONG') {
        client.disconnect();
        return;
      }
    } catch (err) {
      last = err;
    }
    client.disconnect();
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('redis unavailable: ' + String(last));
}

export async function createRealtime(url: string, channel: string): Promise<Realtime> {
  const pub = new Redis(url, redisOpts(url));
  const sub = new Redis(url, redisOpts(url));
  pub.on('error', (err) => log('error', 'redis pub', { err: err.message }));
  sub.on('error', (err) => log('error', 'redis sub', { err: err.message }));
  const local = new Map<number, Set<Response>>();

  sub.on('message', (_ch, raw) => {
    let msg: { targets: number[]; event: string; data: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const frame = `event: ${msg.event}\ndata: ${msg.data}\n\n`;
    for (const id of msg.targets) {
      const set = local.get(id);
      if (!set) continue;
      for (const res of set) {
        try { res.write(frame); } catch { /* client gone */ }
      }
    }
  });
  await sub.subscribe(channel);

  return {
    redis: pub,
    async publish(targets, event, data) {
      await pub.publish(channel, JSON.stringify({ targets, event, data }));
    },
    add(auctionId, res) {
      if (!local.has(auctionId)) local.set(auctionId, new Set());
      local.get(auctionId)!.add(res);
    },
    remove(auctionId, res) {
      local.get(auctionId)?.delete(res);
    },
    beat() {
      for (const set of local.values()) for (const res of set) {
        try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* client gone */ }
      }
    },
    ping: () => pub.ping(),
    async close() {
      for (const set of local.values()) for (const res of set) {
        try { res.end(); } catch { /* ignore */ }
      }
      local.clear();
      try { await sub.unsubscribe(channel); } catch { /* ignore */ }
      sub.disconnect();
      try { await pub.quit(); } catch { pub.disconnect(); }
    },
  };
}
