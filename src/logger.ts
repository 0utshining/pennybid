export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const rank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function current(): LogLevel {
  const v = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error' ? v : 'info';
}

export function log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
  if (rank[level] < rank[current()]) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...extra,
  });
  if (level === 'error') console.error(line);
  else console.log(line);
}
