import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

// All timestamps are ISO-8601 UTC strings, e.g. "2026-11-15T09:30:00.000Z".
const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  event_id       TEXT NOT NULL,
  calendar_id    TEXT NOT NULL,
  client_name    TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT '',
  start_utc      TEXT NOT NULL,
  end_utc        TEXT NOT NULL,
  status         TEXT NOT NULL,          -- confirmed | tentative | cancelled
  meet_link      TEXT,
  attendees_json TEXT NOT NULL DEFAULT '[]',
  updated_at     TEXT NOT NULL,
  first_seen_utc TEXT NOT NULL,          -- set on first insert, never updated
  PRIMARY KEY (event_id, calendar_id)
);

CREATE INDEX IF NOT EXISTS idx_events_start ON events (start_utc);

-- calendar_id is part of the key: one Google invite can sit on several client
-- calendars with the same event_id, and each client group needs its own reminder.
CREATE TABLE IF NOT EXISTS sent_reminders (
  event_id    TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  start_utc   TEXT NOT NULL,
  offset_min  INTEGER NOT NULL,
  sent_at     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'missed')),
  UNIQUE (event_id, calendar_id, start_utc, offset_min)
);

-- Small key/value store, e.g. last_successful_sync for the health check.
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export function setKv(db: DB, key: string, value: string): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

export function getKv(db: DB, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

/**
 * One-off: databases created before calendar_id was added have the old
 * sent_reminders table. It held no real data, so drop it and let SCHEMA recreate it.
 */
function dropLegacySentReminders(db: DB): void {
  const cols = db.prepare(`PRAGMA table_info(sent_reminders)`).all() as { name: string }[];
  if (cols.length > 0 && !cols.some((c) => c.name === 'calendar_id')) {
    db.exec(`DROP TABLE sent_reminders`);
  }
}

function hasColumn(db: DB, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

/** Adds columns introduced after a database was created (CREATE TABLE IF NOT EXISTS won't). */
function addMissingColumns(db: DB): void {
  db.transaction(() => {
    if (!hasColumn(db, 'events', 'first_seen_utc')) {
      db.exec(`ALTER TABLE events ADD COLUMN first_seen_utc TEXT`);
      db.exec(`UPDATE events SET first_seen_utc = updated_at WHERE first_seen_utc IS NULL`);
    }
    if (!hasColumn(db, 'sent_reminders', 'status')) {
      db.exec(`ALTER TABLE sent_reminders ADD COLUMN status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'missed'))`);
    }
  })();
}

/** Opens (creating if needed) the SQLite database and ensures the schema exists. */
export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL'); // safe concurrent reads, durable writes
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  dropLegacySentReminders(db);
  db.exec(SCHEMA);
  addMissingColumns(db);
  return db;
}
