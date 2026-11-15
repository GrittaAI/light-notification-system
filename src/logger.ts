// Structured logger: one JSON object per line, with an ISO-8601 UTC timestamp.
// Example: {"ts":"2026-11-15T05:30:00.000Z","level":"info","msg":"db ready","path":"data/app.db"}

type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function minLevel(): Level {
  const v = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return v in ORDER ? (v as Level) : 'info';
}

function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function write(level: Level, msg: string, fields?: Fields): void {
  if (ORDER[level] < ORDER[minLevel()]) return;
  const entry: Fields = { ts: new Date().toISOString(), level, msg };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) entry[k] = serialize(v);
  }
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  /** Returns a logger that adds `base` fields to every entry (e.g. { module: 'sync' }). */
  child(base: Fields): Logger;
}

function make(base: Fields): Logger {
  const withBase = (f?: Fields) => (f ? { ...base, ...f } : base);
  return {
    debug: (m, f) => write('debug', m, withBase(f)),
    info: (m, f) => write('info', m, withBase(f)),
    warn: (m, f) => write('warn', m, withBase(f)),
    error: (m, f) => write('error', m, withBase(f)),
    child: (more) => make({ ...base, ...more }),
  };
}

export const logger: Logger = make({});
