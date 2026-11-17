// Typed repository for the configuration tables managed in the admin UI.
// Every write is validated with zod, so a bad edit can never reach the running jobs.

import { z } from 'zod';
import { parseOrThrow, StoreError } from './store-errors.js';
import { type Client, type Closer, clientSchema, closerSchema, ConfigError, loadConfig } from './config.js';
import { type DB, getKv, setKv } from './db.js';
import { roleOf as peopleRoleOf } from './people.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'store' });

export const DEFAULT_OFFSETS = [60, 30, 10, 5];
export const KEY_REMINDER_OFFSETS = 'reminder_offsets';
/** kv flag: set once config.json was imported (or the tables already held data); the seed never runs again. */
export const KV_CONFIG_SEEDED_AT = 'config_seeded_at';

export { parseOrThrow, StoreError } from './store-errors.js';

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE' || (err as { code?: string })?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

const nowIso = () => new Date().toISOString();

// ---------- closers ----------

export interface CloserRow {
  id: number;
  name: string;
  email: string;
  whatsapp: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface CloserDbRow {
  id: number; name: string; email: string; whatsapp: string; active: number; created_at: string; updated_at: string;
}

const toCloserRow = (r: CloserDbRow): CloserRow => ({
  id: r.id, name: r.name, email: r.email, whatsapp: r.whatsapp, active: r.active === 1,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const closerInput = closerSchema.extend({ active: z.boolean().optional() });

export function listClosers(db: DB): CloserRow[] {
  return (db.prepare(`SELECT * FROM closers ORDER BY name COLLATE NOCASE, id`).all() as CloserDbRow[]).map(toCloserRow);
}

export function getCloser(db: DB, id: number): CloserRow | undefined {
  const r = db.prepare(`SELECT * FROM closers WHERE id = ?`).get(id) as CloserDbRow | undefined;
  return r && toCloserRow(r);
}

export function createCloser(db: DB, input: unknown): CloserRow {
  const v = parseOrThrow(closerInput, input);
  const now = nowIso();
  try {
    const info = db
      .prepare(`INSERT INTO closers (name, email, whatsapp, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(v.name, v.email, v.whatsapp, v.active === false ? 0 : 1, now, now);
    return getCloser(db, Number(info.lastInsertRowid))!;
  } catch (err) {
    if (isUniqueViolation(err)) throw new StoreError('conflict', 'a closer with this email already exists', { email: 'already exists' });
    throw err;
  }
}

export function updateCloser(db: DB, id: number, input: unknown): CloserRow {
  const current = getCloser(db, id);
  if (!current) throw new StoreError('not_found', 'closer not found');
  const v = parseOrThrow(closerInput, input);
  try {
    db.prepare(`UPDATE closers SET name = ?, email = ?, whatsapp = ?, active = ?, updated_at = ? WHERE id = ?`)
      .run(v.name, v.email, v.whatsapp, (v.active ?? current.active) ? 1 : 0, nowIso(), id);
  } catch (err) {
    if (isUniqueViolation(err)) throw new StoreError('conflict', 'a closer with this email already exists', { email: 'already exists' });
    throw err;
  }
  return getCloser(db, id)!;
}

/** Soft delete (active = 0) keeps history working; hard removes the row. Returns the removed/disabled row. */
export function deleteCloser(db: DB, id: number, hard = false): CloserRow {
  const current = getCloser(db, id);
  if (!current) throw new StoreError('not_found', 'closer not found');
  if (hard) db.prepare(`DELETE FROM closers WHERE id = ?`).run(id);
  else db.prepare(`UPDATE closers SET active = 0, updated_at = ? WHERE id = ?`).run(nowIso(), id);
  return current;
}

// ---------- clients ----------

export interface ClientRow {
  id: number;
  name: string;
  calendarId: string;
  whatsappGroupId: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ClientDbRow {
  id: number; name: string; calendar_id: string; whatsapp_group_id: string; active: number; created_at: string; updated_at: string;
}

const toClientRow = (r: ClientDbRow): ClientRow => ({
  id: r.id, name: r.name, calendarId: r.calendar_id, whatsappGroupId: r.whatsapp_group_id, active: r.active === 1,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const clientInput = clientSchema.extend({ active: z.boolean().optional() });

export function listClients(db: DB): ClientRow[] {
  return (db.prepare(`SELECT * FROM clients ORDER BY name COLLATE NOCASE, id`).all() as ClientDbRow[]).map(toClientRow);
}

export function getClient(db: DB, id: number): ClientRow | undefined {
  const r = db.prepare(`SELECT * FROM clients WHERE id = ?`).get(id) as ClientDbRow | undefined;
  return r && toClientRow(r);
}

const CLIENT_DUP = 'a client with this calendarId already exists';

export function createClient(db: DB, input: unknown): ClientRow {
  const v = parseOrThrow(clientInput, input);
  const now = nowIso();
  try {
    const info = db
      .prepare(`INSERT INTO clients (name, calendar_id, whatsapp_group_id, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(v.name, v.calendarId, v.whatsappGroupId, v.active === false ? 0 : 1, now, now);
    return getClient(db, Number(info.lastInsertRowid))!;
  } catch (err) {
    if (isUniqueViolation(err)) throw new StoreError('conflict', CLIENT_DUP, { calendarId: 'already exists' });
    throw err;
  }
}

export function updateClient(db: DB, id: number, input: unknown): ClientRow {
  const current = getClient(db, id);
  if (!current) throw new StoreError('not_found', 'client not found');
  const v = parseOrThrow(clientInput, input);
  try {
    db.prepare(`UPDATE clients SET name = ?, calendar_id = ?, whatsapp_group_id = ?, active = ?, updated_at = ? WHERE id = ?`)
      .run(v.name, v.calendarId, v.whatsappGroupId, (v.active ?? current.active) ? 1 : 0, nowIso(), id);
  } catch (err) {
    if (isUniqueViolation(err)) throw new StoreError('conflict', CLIENT_DUP, { calendarId: 'already exists' });
    throw err;
  }
  return getClient(db, id)!;
}

export function deleteClient(db: DB, id: number, hard = false): ClientRow {
  const current = getClient(db, id);
  if (!current) throw new StoreError('not_found', 'client not found');
  if (hard) db.prepare(`DELETE FROM clients WHERE id = ?`).run(id);
  else db.prepare(`UPDATE clients SET active = 0, updated_at = ? WHERE id = ?`).run(nowIso(), id);
  return current;
}

// ---------- settings: reminder offsets ----------

/** Whole minutes 1..1440, unique, 1..10 entries; stored sorted descending. */
export const offsetsSchema = z
  .array(z.number().int('must be whole minutes').min(1, 'minimum is 1 minute').max(1440, 'maximum is 1440 minutes'))
  .min(1, 'at least one offset is required')
  .max(10, 'at most 10 offsets')
  .refine((a) => new Set(a).size === a.length, 'offsets must be unique')
  .transform((a) => [...a].sort((x, y) => y - x));

export type OffsetAddedAt = Record<number, string | null>;

interface OffsetEntry {
  offset: number;
  /** When the offset was added; null means "always existed" (defaults and migrated plain arrays). */
  addedAt: string | null;
}

/** Reads the stored value: new shape [{offset, addedAt}] or the old plain number array (migrated, addedAt null). */
function parseStoredOffsets(value: string): OffsetEntry[] | undefined {
  try {
    const raw: unknown = JSON.parse(value);
    if (!Array.isArray(raw)) return undefined;
    const entries: OffsetEntry[] = raw.map((x) =>
      typeof x === 'number'
        ? { offset: x, addedAt: null }
        : { offset: (x as OffsetEntry).offset, addedAt: typeof (x as OffsetEntry).addedAt === 'string' ? (x as OffsetEntry).addedAt : null },
    );
    const parsed = offsetsSchema.safeParse(entries.map((e) => e.offset));
    if (!parsed.success) return undefined;
    return parsed.data.map((o) => entries.find((e) => e.offset === o)!);
  } catch {
    return undefined;
  }
}

export function getOffsets(db: DB): { offsets: number[]; addedAt: OffsetAddedAt; updatedAt: string | null } {
  const fromEntries = (entries: OffsetEntry[], updatedAt: string | null) => ({
    offsets: entries.map((e) => e.offset),
    addedAt: Object.fromEntries(entries.map((e) => [e.offset, e.addedAt])) as OffsetAddedAt,
    updatedAt,
  });
  const row = db.prepare(`SELECT value, updated_at FROM settings WHERE key = ?`).get(KEY_REMINDER_OFFSETS) as
    | { value: string; updated_at: string }
    | undefined;
  if (!row) return fromEntries(DEFAULT_OFFSETS.map((offset) => ({ offset, addedAt: null })), null);
  const entries = parseStoredOffsets(row.value);
  if (entries) return fromEntries(entries, row.updated_at);
  log.error('stored reminder_offsets is invalid; using defaults');
  return fromEntries(DEFAULT_OFFSETS.map((offset) => ({ offset, addedAt: null })), row.updated_at);
}

export function setOffsets(db: DB, input: unknown): { offsets: number[]; updatedAt: string } {
  let offsets: number[];
  try {
    offsets = parseOrThrow(offsetsSchema, input);
  } catch (err) {
    if (err instanceof StoreError && err.fields) {
      // Whole-list and per-element errors both belong to the one reminderOffsets field.
      throw new StoreError('validation', err.message, { reminderOffsets: Object.values(err.fields)[0]! });
    }
    throw err;
  }
  const updatedAt = nowIso();
  const existing = getOffsets(db).addedAt;
  // Offsets that stay keep their added-at; new ones get now; removed ones are dropped.
  const entries: OffsetEntry[] = offsets.map((offset) => ({
    offset,
    addedAt: offset in existing ? existing[offset]! : updatedAt,
  }));
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(KEY_REMINDER_OFFSETS, JSON.stringify(entries), updatedAt);
  return { offsets, updatedAt };
}

// ---------- admin users (backed by the people table; admin_users is no longer used) ----------

export interface AdminRow {
  email: string;
  role: 'admin';
  addedBy: string;
  createdAt: string;
}

/** Active admins. `superadminEmail` (when given) is left out: the superadmin comes from the environment, not from this list. */
export function listAdmins(db: DB, superadminEmail?: string): AdminRow[] {
  const sup = superadminEmail?.trim().toLowerCase();
  return (db.prepare(`SELECT email, created_at, added_by FROM people WHERE role = 'admin' AND active = 1 ORDER BY email`).all() as
    { email: string; created_at: string; added_by: string | null }[])
    .filter((r) => r.email.toLowerCase() !== sup)
    .map((r) => ({ email: r.email, role: 'admin' as const, addedBy: r.added_by ?? '', createdAt: r.created_at }));
}

const adminEmail = z.string().trim().toLowerCase().pipe(z.email());

/** Adds an admin: creates the person (name = email local part) or promotes/reactivates an existing one. */
export function addAdmin(db: DB, input: unknown, addedBy: string, superadminEmail: string): AdminRow {
  const { email } = parseOrThrow(z.object({ email: adminEmail }), input);
  if (email === superadminEmail.toLowerCase()) {
    throw new StoreError('validation', 'the superadmin is always an admin', { email: 'is the superadmin' });
  }
  const now = nowIso();
  db.transaction(() => {
    const existing = db.prepare(`SELECT role, active FROM people WHERE email = ?`).get(email) as { role: string; active: number } | undefined;
    if (existing?.role === 'admin' && existing.active === 1) {
      throw new StoreError('conflict', 'this admin already exists', { email: 'already exists' });
    }
    if (existing) {
      db.prepare(`UPDATE people SET role = 'admin', active = 1, updated_at = ?, added_by = ? WHERE email = ?`).run(now, addedBy, email);
      db.prepare(`DELETE FROM admin_sessions WHERE email = ?`).run(email);
    } else {
      db.prepare(
        `INSERT INTO people (email, name, whatsapp, role, active, notify_target, notify_group_id, created_at, updated_at, added_by)
         VALUES (?, ?, NULL, 'admin', 1, 'default', NULL, ?, ?, ?)`,
      ).run(email, email.split('@')[0] || email, now, now, addedBy);
    }
  })();
  return listAdmins(db).find((a) => a.email === email)!;
}

/** Removing an admin demotes them to member (the person and any tasks stay) and signs them out. */
export function removeAdmin(db: DB, emailInput: string, superadminEmail: string): string {
  const email = emailInput.trim().toLowerCase();
  if (email === superadminEmail.toLowerCase()) {
    throw new StoreError('validation', 'the superadmin cannot be removed', { email: 'is the superadmin' });
  }
  const removed = db.transaction(() => {
    const info = db.prepare(`UPDATE people SET role = 'member', updated_at = ? WHERE email = ? AND role = 'admin' AND active = 1`).run(nowIso(), email);
    if (info.changes > 0) db.prepare(`DELETE FROM admin_sessions WHERE email = ?`).run(email);
    return info.changes > 0;
  })();
  if (!removed) throw new StoreError('not_found', 'admin not found');
  return email;
}

/** 'superadmin' for the env email, 'admin' for an active admin person, null for anyone else (members have no console access). */
export function roleOf(db: DB, email: string, superadminEmail: string): 'superadmin' | 'admin' | null {
  const role = peopleRoleOf(db, email, superadminEmail);
  return role === 'member' ? null : role;
}

// ---------- audit log ----------

export interface AuditRow {
  id: number;
  at: string;
  actor: string;
  action: string;
  details: unknown;
}

export function addAudit(db: DB, actor: string, action: string, details: Record<string, unknown> = {}): void {
  db.prepare(`INSERT INTO audit_log (at, actor, action, details) VALUES (?, ?, ?, ?)`)
    .run(nowIso(), actor, action, JSON.stringify(details));
}

/** The last `limit` audit rows whose action belongs to Nudge (people, access, task settings); reminders-console and login rows are left out. */
export function listNudgeAudit(db: DB, limit = 200): AuditRow[] {
  return (db.prepare(
    `SELECT id, at, actor, action, details FROM audit_log
     WHERE action GLOB 'person_*' OR action GLOB 'access_grant_*' OR action GLOB 'task_settings*'
     ORDER BY id DESC LIMIT ?`).all(limit) as { id: number; at: string; actor: string; action: string; details: string }[])
    .map((r) => ({ ...r, details: JSON.parse(r.details) as unknown }));
}

export function listAudit(db: DB, limit = 100): AuditRow[] {
  return (db.prepare(`SELECT id, at, actor, action, details FROM audit_log ORDER BY id DESC LIMIT ?`).all(limit) as
    { id: number; at: string; actor: string; action: string; details: string }[])
    .map((r) => ({ ...r, details: JSON.parse(r.details) as unknown }));
}

// ---------- runtime config for the jobs ----------

export interface RuntimeConfig {
  closers: Closer[];
  clients: Client[];
  offsets: number[];
  /** offset -> when it was added (null: always existed). */
  offsetAddedAt: OffsetAddedAt;
}

/** Active closers/clients and the reminder offsets; called by sync, reminders and monitor on every run. */
export function loadRuntimeConfig(db: DB): RuntimeConfig {
  const closers = (db.prepare(`SELECT name, email, whatsapp FROM closers WHERE active = 1 ORDER BY id`).all() as Closer[]);
  const clients = (db
    .prepare(`SELECT name, calendar_id, whatsapp_group_id FROM clients WHERE active = 1 ORDER BY id`)
    .all() as { name: string; calendar_id: string; whatsapp_group_id: string }[])
    .map((c) => ({ name: c.name, calendarId: c.calendar_id, whatsappGroupId: c.whatsapp_group_id }));
  const { offsets, addedAt } = getOffsets(db);
  return { closers, clients, offsets, offsetAddedAt: addedAt };
}

// ---------- first-start import of config.json ----------

export interface SeedResult {
  imported: boolean;
  closers: number;
  clients: number;
  reason?: string;
}

/**
 * Once per database (kv `config_seeded_at`): if closers AND clients are both empty and `path` holds a
 * valid config.json, imports it in one transaction and sets the flag. Missing or invalid file: logged, starts empty. Called once at startup.
 */
export function seedFromConfigFile(db: DB, path: string): SeedResult {
  const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  if (getKv(db, KV_CONFIG_SEEDED_AT)) {
    return { imported: false, closers: 0, clients: 0, reason: 'already seeded' };
  }
  if (count('closers') > 0 || count('clients') > 0) {
    // Existing database: mark it so emptying the tables later never brings old data back.
    setKv(db, KV_CONFIG_SEEDED_AT, nowIso());
    return { imported: false, closers: 0, clients: 0, reason: 'tables not empty' };
  }
  let cfg;
  try {
    cfg = loadConfig(path);
  } catch (err) {
    const reason = err instanceof ConfigError ? err.message : (err as Error).message;
    log.info('no config.json import (starting with empty configuration)', { path, reason });
    return { imported: false, closers: 0, clients: 0, reason };
  }
  const now = nowIso();
  db.transaction(() => {
    const insCloser = db.prepare(`INSERT INTO closers (name, email, whatsapp, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`);
    for (const c of cfg.closers) insCloser.run(c.name, c.email, c.whatsapp, now, now);
    const insClient = db.prepare(`INSERT INTO clients (name, calendar_id, whatsapp_group_id, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`);
    for (const c of cfg.clients) insClient.run(c.name, c.calendarId, c.whatsappGroupId, now, now);
    setKv(db, KV_CONFIG_SEEDED_AT, now);
    addAudit(db, 'system', 'import_config_json', { path, closers: cfg.closers.length, clients: cfg.clients.length });
  })();
  log.info('imported config.json into the database', { path, closers: cfg.closers.length, clients: cfg.clients.length });
  return { imported: true, closers: cfg.closers.length, clients: cfg.clients.length };
}
