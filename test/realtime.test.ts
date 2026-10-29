import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bearerFor, listenApp, makeSchema, mkAuction, mkUsers } from './helpers';
import { dropSchema } from '../src/db';

function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const queued: { event: string; data: string }[] = [];
  return {
    async next(timeoutMs = 5000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (queued.length) return queued.shift()!;
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const part of parts) {
          const event = part.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim();
          const data = part.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
          if (event && data) queued.push({ event, data });
        }
      }
      throw new Error('SSE timed out. Buffer: ' + buf);
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}

test('a bid on one instance is pushed to an SSE client on another', async () => {
  const schema = await makeSchema();
  const a = await listenApp({ schema, closer: false });
  const b = await listenApp({ schema, closer: false });
  let stream: ReturnType<typeof sseReader> | undefined;
  try {
    const [user] = await mkUsers(a.pool, 1, 'sse');
    await a.engine.grant(user, 5, 'test');
    const id = await mkAuction(a.pool, Date.now() - 1000, Date.now() + 120_000);
    const res = await fetch(`${b.base}/api/stream?auction=${id}`);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    stream = sseReader(res);
    const first = await stream.next();
    assert.equal(first.event, 'auction');
    assert.equal(JSON.parse(first.data).bidCount, 0);

    const placed = await fetch(`${a.base}/api/auctions/${id}/bid`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + await bearerFor(a.pool, user), 'idempotency-key': 'fanout-1' },
    });
    assert.equal((await placed.json() as { ok: boolean }).ok, true);

    let payload: { bidCount: number; priceCents: number; leader: string } | null = null;
    for (let i = 0; i < 4 && !payload; i++) {
      const frame = await stream.next();
      if (frame.event === 'auction') payload = JSON.parse(frame.data);
    }
    assert.ok(payload);
    assert.equal(payload!.bidCount, 1);
    assert.equal(payload!.priceCents, 1);
    assert.equal(payload!.leader, 'sse0');
  } finally {
    await stream?.cancel();
    await b.stop(false);
    await a.stop(false);
    await dropSchema(schema);
  }
});
