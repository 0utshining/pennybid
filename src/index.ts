import 'dotenv/config';
import { createApp } from './server';
import { log } from './logger';

async function main() {
  const secret = process.env.SESSION_SECRET || '';
  if (secret.length < 16) {
    log('error', 'SESSION_SECRET must be set to at least 16 characters');
    process.exit(1);
  }
  const ctx = await createApp({
    seed: process.env.SEED !== '0',
    uploadDir: process.env.UPLOAD_DIR,
  });
  const port = Number(process.env.PORT || 4317);
  const server = await new Promise<import('http').Server>((resolve) => {
    const s = ctx.app.listen(port, '0.0.0.0', () => resolve(s));
  });
  const addr = server.address();
  const bound = typeof addr === 'object' && addr ? addr.port : port;
  log('info', 'listening', { port: bound });

  let closing = false;
  const shutdown = (sig: string) => {
    if (closing) return;
    closing = true;
    log('info', 'shutdown', { sig });
    server.close(() => {
      ctx.close().then(() => process.exit(0)).catch((err) => {
        log('error', 'shutdown failed', { err: err instanceof Error ? err.message : String(err) });
        process.exit(1);
      });
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log('error', 'fatal', { err: err instanceof Error ? err.stack || err.message : String(err) });
  process.exit(1);
});
