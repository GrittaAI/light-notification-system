// People directory (table `people`): admins and members of the Nudge product, and the admins of the
// reminders console. Replaces admin_users (kept in the schema, no longer read or written).

import { z } from 'zod';
import { whatsappSchemaWith } from './config.js';
import type { DB } from './db.js';
import { parseOrThrow, StoreError } from './store-errors.js';

export type PersonRole = 'admin' | 'member';
export type NotifyTarget = 'default' | 'group' | 'dm';
/** Effective role of a signed-in user: 'superadmin' comes from SUPERADMIN_EMAIL and is never stored. */
export type UserRole = 'superadmin' | 'admin' | 'member';

export interface PersonRow {
  id: number;
  email: string;
  name: string;
  whatsapp: string | null;
  role: PersonRole;
  active: boolean;
  notifyTarget: NotifyTarget;
  notifyGroupId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersonDbRow {
  id: number; email: string; name: string; whatsapp: string | null; role: PersonRole; active: number;
  notify_target: NotifyTarget; notify_group_id: string | null; created_at: string; updated_at: string;
}

export const toPerson = (r: PersonDbRow): PersonRow => ({
  id: r.id, email: r.email, name: r.name, whatsapp: r.whatsapp, role: r.role, active: r.active === 1,
  notifyTarget: r.notify_target, notifyGroupId: r.notify_group_id, createdAt: r.created_at, updatedAt: r.updated_at,
});

const nowIso = () => new Date().toISOString();

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

export const personSchema = z
  .object({
    email: z.string({ error: 'Enter a valid email address' }).trim().toLowerCase().pipe(z.email({ error: 'Enter a valid email address' })),
    name: z.string({ error: 'Enter a name' }).trim().min(1, 'Enter a name').max(100, 'Use at most 100 characters'),
    whatsapp: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), whatsappSchemaWith('Use the international format with country code, e.g. +91 98765 43210', 'Use the international format with country code, e.g. +91 98765 43210').nullable().optional()),
    role: z.enum(['admin', 'member'], { error: 'Choose a role' }).optional(),
    active: z.boolean({ error: 'Choose active or inactive' }).optional(),
    notifyTarget: z.enum(['default', 'group', 'dm'], { error: 'Choose where nudges go' }).optional(),
    notifyGroupId: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
      z.string({ error: 'Choose a WhatsApp group' }).trim().regex(/^[\w-]+@g\.us$/, 'Choose a WhatsApp group').nullable().optional(),
    ),
  })
  .superRefine((p, ctx) => {
    if (p.notifyTarget === 'group' && !p.notifyGroupId) {
      ctx.addIssue({ code: 'custom', path: ['notifyGroupId'], message: 'Choose a WhatsApp group' });
    }
  });

export type PersonInput = z.output<typeof personSchema>;

export function listPeople(db: DB): PersonRow[] {
  return (db.prepare(`SELECT * FROM people ORDER BY name COLLATE NOCASE, id`).all() as PersonDbRow[]).map(toPerson);
}

export function getPerson(db: DB, id: number): PersonRow | undefined {
  const r = db.prepare(`SELECT * FROM people WHERE id = ?`).get(id) as PersonDbRow | undefined;
  return r && toPerson(r);
}

export function getPersonByEmail(db: DB, email: string): PersonRow | undefined {
  const r = db.prepare(`SELECT * FROM people WHERE email = ?`).get(email.trim().toLowerCase()) as PersonDbRow | undefined;
  return r && toPerson(r);
}

const DUP = 'a person with this email already exists';

const isSuper = (email: string, superadminEmail?: string) => !!superadminEmail && email === superadminEmail.trim().toLowerCase();
const SUPER_EMAIL_ERR = { email: 'is the superadmin' };

export interface PersonWriteOpts {
  /**
   * SUPERADMIN_EMAIL. Its person row (the superadmin's own task list) can be created and edited (name, WhatsApp,
   * notification fields) only by the superadmin; nobody can rename someone to it, change its role or deactivate it.
   */
  superadminEmail?: string;
  /** True when the signed-in actor is the superadmin. */
  actorIsSuperadmin?: boolean;
  /** Who is creating the person (stored as added_by). */
  addedBy?: string;
}

export function createPerson(db: DB, input: unknown, opts: PersonWriteOpts = {}): PersonRow {
  const v = parseOrThrow(personSchema, input);
  const creatingSuper = isSuper(v.email, opts.superadminEmail);
  if (creatingSuper && !opts.actorIsSuperadmin) {
    throw new StoreError('validation', 'only the superadmin can create their own person row', SUPER_EMAIL_ERR);
  }
  if (creatingSuper && v.role === 'member') throw new StoreError('validation', 'the superadmin is always an admin', { role: 'is the superadmin' });
  if (creatingSuper && v.active === false) throw new StoreError('validation', 'the superadmin cannot be inactive', { active: 'is the superadmin' });
  const now = nowIso();
  const target = v.notifyTarget ?? 'default';
  try {
    const info = db
      .prepare(
        `INSERT INTO people (email, name, whatsapp, role, active, notify_target, notify_group_id, created_at, updated_at, added_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(v.email, v.name, v.whatsapp ?? null, creatingSuper ? 'admin' : v.role ?? 'member', v.active === false ? 0 : 1, target,
        target === 'group' ? v.notifyGroupId ?? null : null, now, now, opts.addedBy ?? null);
    return getPerson(db, Number(info.lastInsertRowid))!;
  } catch (err) {
    if (isUniqueViolation(err)) throw new StoreError('conflict', DUP, { email: 'already exists' });
    throw err;
  }
}

/** Full replace of the editable fields; omitted role/active/notify fields keep their current values. */
export function updatePerson(db: DB, id: number, input: unknown, opts: PersonWriteOpts = {}): PersonRow {
  const current = getPerson(db, id);
  if (!current) throw new StoreError('not_found', 'person not found');
  const v = parseOrThrow(personSchema, input);
  const currentIsSuper = isSuper(current.email, opts.superadminEmail);
  if (!currentIsSuper && isSuper(v.email, opts.superadminEmail)) {
    throw new StoreError('validation', 'the superadmin is managed in the environment', SUPER_EMAIL_ERR);
  }
  if (currentIsSuper && !opts.actorIsSuperadmin) {
    throw new StoreError('validation', 'only the superadmin can edit their own person row', SUPER_EMAIL_ERR);
  }
  // The superadmin's own row: name, WhatsApp and notification fields are editable; email, role and active are not.
  if (currentIsSuper && v.email !== current.email) {
    throw new StoreError('validation', 'the superadmin email cannot change', SUPER_EMAIL_ERR);
  }
  if (currentIsSuper && v.role !== undefined && v.role !== 'admin') {
    throw new StoreError('validation', 'the superadmin cannot be re-roled', { role: 'is the superadmin' });
  }
  if (currentIsSuper && v.active === false) {
    throw new StoreError('validation', 'the superadmin cannot be deactivated', { active: 'is the superadmin' });
  }
  const target = v.notifyTarget ?? current.notifyTarget;
  const groupId = v.notifyGroupId === undefined ? current.notifyGroupId : v.notifyGroupId;
  if (target === 'group' && !groupId) {
    throw new StoreError('validation', 'validation failed', { notifyGroupId: 'Choose a WhatsApp group' });
  }
  try {
    db.transaction(() => {
      db.prepare(
        `UPDATE people SET email = ?, name = ?, whatsapp = ?, role = ?, active = ?, notify_target = ?, notify_group_id = ?, updated_at = ?
         WHERE id = ?`,
      ).run(v.email, v.name, v.whatsapp === undefined ? current.whatsapp : v.whatsapp, currentIsSuper ? 'admin' : v.role ?? current.role,
        (v.active ?? current.active) ? 1 : 0, target, target === 'group' ? groupId : null, nowIso(), id);
      // Sessions are keyed by email: a changed email, a deactivation or a role change signs the person out.
      // Never for the superadmin address: its sessions are not a person's to revoke.
      if (!currentIsSuper && (v.email !== current.email || (v.active ?? current.active) === false || (v.role ?? current.role) !== current.role)) {
        db.prepare(`DELETE FROM admin_sessions WHERE email = ?`).run(current.email);
      }
    })();
  } catch (err) {
    if (isUniqueViolation(err)) throw new StoreError('conflict', DUP, { email: 'already exists' });
    throw err;
  }
  return getPerson(db, id)!;
}

/** Soft delete: the person and their tasks stay, but they can no longer sign in or be nudged. */
export function deactivatePerson(db: DB, id: number, opts: PersonWriteOpts = {}): PersonRow {
  const current = getPerson(db, id);
  if (!current) throw new StoreError('not_found', 'person not found');
  if (isSuper(current.email, opts.superadminEmail)) {
    throw new StoreError('validation', 'the superadmin cannot be deactivated', { email: 'is the superadmin' });
  }
  db.transaction(() => {
    db.prepare(`UPDATE people SET active = 0, updated_at = ? WHERE id = ?`).run(nowIso(), id);
    db.prepare(`DELETE FROM admin_sessions WHERE email = ?`).run(current.email);
  })();
  return getPerson(db, id)!;
}

// ---------- roles ----------

/** 'superadmin' for the env email, else the role of an ACTIVE person, else null. */
export function roleOf(db: DB, email: string, superadminEmail: string): UserRole | null {
  const e = email.trim().toLowerCase();
  if (e === superadminEmail.toLowerCase()) return 'superadmin';
  const r = db.prepare(`SELECT role FROM people WHERE email = ? AND active = 1`).get(e) as { role: PersonRole } | undefined;
  return r ? r.role : null;
}

export interface Principal {
  email: string;
  name: string;
  role: UserRole;
  personId: number | null;
}

/** Resolves an email to a signed-in identity, or null. `allowMembers: false` (reminders console) accepts admins only. */
export function resolvePrincipal(db: DB, email: string, superadminEmail: string, allowMembers: boolean): Principal | null {
  const role = roleOf(db, email, superadminEmail);
  if (!role || (role === 'member' && !allowMembers)) return null;
  const e = email.trim().toLowerCase();
  const person = getPersonByEmail(db, e);
  return { email: e, name: person?.name ?? (e.split('@')[0] || e), role, personId: person?.id ?? null };
}

/**
 * The superadmin's own person row (so they have a task list): returns it, creating it on first use.
 * Name defaults to the part of the email before @; role is always 'admin'. A pre-existing row that is not an
 * active admin is repaired. Only the API layer's superadmin-only route calls this.
 */
export function ensureSuperadminPerson(
  db: DB, superadminEmail: string, input: { name?: unknown; whatsapp?: unknown } | undefined,
): { person: PersonRow; created: boolean; repaired: boolean } {
  const email = superadminEmail.trim().toLowerCase();
  const existing = getPersonByEmail(db, email);
  if (existing) {
    if (existing.role !== 'admin' || !existing.active) {
      db.prepare(`UPDATE people SET role = 'admin', active = 1, updated_at = ? WHERE id = ?`).run(nowIso(), existing.id);
      return { person: getPerson(db, existing.id)!, created: false, repaired: true };
    }
    return { person: existing, created: false, repaired: false };
  }
  const name = typeof input?.name === 'string' && input.name.trim() ? input.name : email.split('@')[0] || email;
  const person = createPerson(db, { email, name, whatsapp: input?.whatsapp, role: 'admin' },
    { superadminEmail: email, actorIsSuperadmin: true, addedBy: email });
  return { person, created: true, repaired: false };
}
