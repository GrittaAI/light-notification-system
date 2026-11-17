// Nudge JSON API: /api/me, /api/app/* (tasks, any signed-in person) and the Nudge admin APIs
// (/api/people, /api/access-grants, /api/task-settings; admin or superadmin only).

import { z } from 'zod';
import { HttpError, type SessionUser } from '../admin/auth.js';
import { createGroupsCache } from '../admin/routes.js';
import type { Env } from '../config.js';
import type { DB } from '../db.js';
import type { ApiResult } from '../http/common.js';
import {
  createPerson, deactivatePerson, ensureSuperadminPerson, getPerson, listPeople, notifyPrefsSchema, type PersonRow, updateNotifyPrefs, updatePerson,
} from '../people.js';
import { addAudit, listNudgeAudit, parseOrThrow, StoreError } from '../store.js';
import { canEdit, canView, visibleOwners } from '../tasks/access.js';
import { effectiveSettings, previewDigest, targetFor } from '../tasks/nudges.js';
import type { VoiceLlm } from '../tasks/voice.js';
import { getTaskSettings, setTaskSettings } from '../tasks/settings.js';
import { logger } from '../logger.js';
import type { WhatsApp } from '../whatsapp.js';

const log = logger.child({ module: 'nudge-api' });
const TEST_NUDGE_COOLDOWN_MS = 30_000;
import {
  applyAction, getTask, listActivity, listTasks, parseTaskInput, publicTask, saveTask, snoozeSchema, type TaskRow, UUID_V4,
} from '../tasks/store.js';

export interface NudgeApiDeps {
  db: DB;
  env: Pick<Env, 'SUPERADMIN_EMAIL'>;
  now?: () => Date;
  /** WAHA client for the groups list and test nudges. Without it those endpoints answer 503. */
  whatsapp?: Pick<WhatsApp, 'sendGroupMessage' | 'sendDirectMessage' | 'listGroups'>;
  appName?: string;
  /** Smart fallback for voice tasks (LLM_API_KEY set). Without it POST /api/app/voice-parse answers 503. */
  voiceLlm?: VoiceLlm;
}

const VOICE_PER_MIN = 20;
const voiceSchema = z.object({ text: z.string({ error: 'say something first' }).trim().min(1, 'say something first').max(500, 'that was too long; try a shorter sentence') });

const ok = (body: unknown, status = 200): ApiResult => ({ status, body });
const isAdmin = (u: SessionUser) => u.role === 'admin' || u.role === 'superadmin';

function requireAdmin(u: SessionUser): void {
  if (!isAdmin(u)) throw new HttpError(403, 'admin only');
}

function parseIntId(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) throw new HttpError(404, 'not found');
  return Number(raw);
}

const grantSchema = z.object({
  granteePersonId: z.number().int().positive(),
  ownerPersonId: z.number().int().positive(),
  level: z.enum(['view', 'edit']),
});

export function createNudgeApi(deps: NudgeApiDeps) {
  const { db } = deps;
  const clock = () => (deps.now ?? (() => new Date()))();
  const groups = createGroupsCache(async () => {
    if (!deps.whatsapp) throw new HttpError(503, 'WhatsApp is not configured on this server');
    return deps.whatsapp.listGroups();
  }, clock);
  const wa = () => {
    if (!deps.whatsapp) throw new HttpError(503, 'WhatsApp is not configured on this server');
    return deps.whatsapp;
  };
  /** WAHA errors become a 502 with only the HTTP status (never the key or the raw error text). */
  const wahaFail = (what: string, err: unknown): HttpError => {
    if (err instanceof HttpError) return err;
    const status = /HTTP (\d{3})/.exec(err instanceof Error ? err.message : '')?.[1];
    return new HttpError(502, `${what}${status ? ` (WAHA HTTP ${status})` : ''}`);
  };
  const lastTestNudge = new Map<number, number>();
  const voiceHits = new Map<string, number[]>();

  /** Spoken sentence -> { title, dueIso, priority, past } via the model. The client always shows it for review first. */
  async function voiceParse(user: SessionUser, body: unknown): Promise<ApiResult> {
    if (!deps.voiceLlm) throw new HttpError(503, 'smart voice understanding is not set up on this server');
    const { text } = parseOrThrow(voiceSchema, body);
    const nowMs = clock().getTime();
    const recent = (voiceHits.get(user.email) ?? []).filter((t) => nowMs - t < 60_000);
    if (recent.length >= VOICE_PER_MIN) throw new HttpError(429, 'too many voice requests; wait a minute');
    recent.push(nowMs);
    voiceHits.set(user.email, recent);
    try {
      return ok({ ...(await deps.voiceLlm.parse(text, clock())), source: 'ai' });
    } catch (err) {
      log.warn('voice parse failed', { err: err instanceof Error ? err.message : String(err) });
      throw new HttpError(502, 'could not understand that automatically');
    }
  }
  const isSuperEmail = (email: string) => email.toLowerCase() === deps.env.SUPERADMIN_EMAIL.toLowerCase();

  // ----- tasks -----

  /** Loads a task the actor may see (404 otherwise, so existence is not leaked) and, if `edit`, may change (403). */
  function taskFor(user: SessionUser, id: string, edit: boolean, allowDeleted = !edit): TaskRow {
    const task = getTask(db, id);
    if (!task || (task.deletedAt !== null && !allowDeleted)) throw new HttpError(404, 'not found');
    if (!canView(db, user, task.ownerPersonId)) throw new HttpError(404, 'not found');
    if (edit && !canEdit(db, user, task.ownerPersonId)) throw new HttpError(403, 'you can only view this list');
    return task;
  }

  function putTask(user: SessionUser, id: string, body: unknown): ApiResult {
    if (!UUID_V4.test(id)) throw new HttpError(400, 'task id must be a UUID v4');
    const input = parseTaskInput(body);
    const existing = getTask(db, id);
    const newOwner = input.ownerPersonId ?? existing?.ownerPersonId ?? user.personId;
    if (newOwner === null || newOwner === undefined) {
      throw new StoreError('validation', 'validation failed', { ownerPersonId: 'is required' });
    }
    if (existing) {
      if (!canView(db, user, existing.ownerPersonId)) throw new HttpError(404, 'not found');
      if (!canEdit(db, user, existing.ownerPersonId)) throw new HttpError(403, 'you can only view this list');
    }
    if (input.ownerPersonId !== undefined && !getPerson(db, newOwner)) {
      throw new StoreError('validation', 'validation failed', { ownerPersonId: 'unknown person' });
    }
    if (!canEdit(db, user, newOwner)) throw new HttpError(403, 'you cannot edit that list');
    const r = saveTask(db, id, { ...input, ownerPersonId: newOwner }, user, clock().toISOString());
    if (!r.ok) return ok({ error: 'conflict', task: publicTask(r.conflict) }, 409);
    return ok(publicTask(r.task), existing ? 200 : 201);
  }

  function getTasks(user: SessionUser, query: URLSearchParams): ApiResult {
    const serverTime = clock().toISOString();
    const sinceRaw = query.get('since');
    let since: string | undefined;
    if (sinceRaw) {
      if (Number.isNaN(Date.parse(sinceRaw))) throw new HttpError(400, 'since must be an ISO-8601 date-time');
      since = new Date(sinceRaw).toISOString();
    }
    const ownerRaw = query.get('owner');
    let owners: number[];
    if (ownerRaw) {
      const id = parseIntId(ownerRaw);
      if (!canView(db, user, id)) throw new HttpError(403, 'no access to that list');
      owners = [id];
    } else {
      owners = visibleOwners(db, user).map((o) => o.id);
    }
    return ok({ serverTime, tasks: listTasks(db, owners, since).map(publicTask) });
  }

  function taskRoutes(user: SessionUser, method: string, segments: string[], body: unknown): ApiResult | undefined {
    const [, , id, action] = segments;
    if (!id) return undefined;
    if (segments.length === 3 && method === 'PUT') return putTask(user, id, body);
    if (segments.length === 3 && method === 'DELETE') {
      const task = taskFor(user, id, true, true); // deleting twice is fine
      return ok(publicTask(applyAction(db, task, 'delete', user.email, clock().toISOString())));
    }
    if (segments.length === 4 && action === 'activity' && method === 'GET') {
      taskFor(user, id, false);
      return ok(listActivity(db, id));
    }
    if (segments.length === 4 && method === 'POST' && ['done', 'reopen', 'snooze', 'unsnooze'].includes(action!)) {
      const task = taskFor(user, id, true);
      const minutes = action === 'snooze' ? parseOrThrow(snoozeSchema, body).minutes : undefined;
      return ok(publicTask(applyAction(db, task, action as 'done', user.email, clock().toISOString(), minutes)));
    }
    return undefined;
  }

  /** Where the actor's own nudges go (read-only, for the profile sheet): the kind of target and whether it is set up. */
  function nudgeTarget(user: SessionUser): ApiResult {
    const p = user.personId === null ? undefined : getPerson(db, user.personId);
    if (!p) return ok({ target: 'none', configured: false });
    const configured = p.notifyTarget === 'dm' ? !!p.whatsapp : p.notifyTarget === 'group' ? !!p.notifyGroupId : !!getTaskSettings(db).defaultGroupId;
    return ok({ target: p.notifyTarget, configured });
  }

  // ----- personal notification settings (each person sets their own; the superadmin can change anyone's) -----

  /** Whose settings: yourself by default; admins may VIEW anyone's; only the person or the superadmin may change them. */
  function notifySubject(user: SessionUser, raw: unknown, edit: boolean): PersonRow {
    const id = raw === undefined || raw === null || raw === '' ? user.personId : parseIntId(String(raw));
    if (id === null || id === undefined) throw new HttpError(409, 'Create your task list first');
    const p = getPerson(db, id);
    if (!p) throw new HttpError(404, 'not found');
    const self = id === user.personId;
    if (!self && !isAdmin(user)) throw new HttpError(403, 'you can only see your own notification settings');
    if (edit && !self && user.role !== 'superadmin') throw new HttpError(403, `only ${p.name} or the owner can change these settings`);
    return p;
  }

  function notifyView(user: SessionUser, p: PersonRow): ApiResult {
    const team = getTaskSettings(db);
    return ok({
      person: { id: p.id, name: p.name, email: p.email, active: p.active },
      canEdit: p.id === user.personId || user.role === 'superadmin',
      prefs: {
        whatsapp: p.whatsapp, notifyTarget: p.notifyTarget, notifyGroupId: p.notifyGroupId,
        leadMinutes: p.leadMinutes, repeatMinutes: p.repeatMinutes, quietHours: p.quietHours,
      },
      team: { leadMinutes: team.leadMinutes, repeatMinutes: team.repeatMinutes, quietHours: team.quietHours, mergeAheadMinutes: team.mergeAheadMinutes, defaultGroupId: team.defaultGroupId },
    });
  }

  function putNotify(user: SessionUser, body: unknown): ApiResult {
    const raw = (body ?? {}) as Record<string, unknown>;
    const p = notifySubject(user, raw.personId, true);
    const { personId: _ignored, ...input } = raw;
    const { before, after } = updateNotifyPrefs(db, p.id, input);
    // A new repeat interval applies from the last nudge, so a shorter one takes effect now rather than after the old wait.
    const team = getTaskSettings(db);
    const oldRepeat = effectiveSettings(before, team).repeatMinutes;
    const newRepeat = effectiveSettings(after, team).repeatMinutes;
    if (oldRepeat !== newRepeat) {
      const st = db.prepare(`SELECT last_digest_at FROM task_nudge_state WHERE owner_person_id = ?`).get(p.id) as { last_digest_at: string | null } | undefined;
      if (st?.last_digest_at) {
        db.prepare(`UPDATE task_nudge_state SET next_digest_at = ? WHERE owner_person_id = ?`)
          .run(new Date(Date.parse(st.last_digest_at) + newRepeat * 60_000).toISOString(), p.id);
      }
    }
    addAudit(db, user.email, 'person_notify_update', {
      id: p.id, email: p.email, notifyTarget: after.notifyTarget, whatsappSet: !!after.whatsapp,
      leadMinutes: after.leadMinutes, repeatMinutes: after.repeatMinutes, quietHours: after.quietHours,
    });
    return notifyView(user, after);
  }

  /** True when an admin's People edit would change notification fields (those belong to the person and the superadmin). */
  function changesNotify(before: PersonRow, body: unknown): boolean {
    const b = (body ?? {}) as Record<string, unknown>;
    const r = notifyPrefsSchema.safeParse({ whatsapp: b.whatsapp, notifyTarget: b.notifyTarget, notifyGroupId: b.notifyGroupId });
    if (!r.success) return false; // updatePerson reports the validation error
    const v = r.data;
    if (v.whatsapp !== undefined && v.whatsapp !== before.whatsapp) return true;
    if (v.notifyTarget !== undefined && v.notifyTarget !== before.notifyTarget) return true;
    const target = v.notifyTarget ?? before.notifyTarget;
    return target === 'group' && v.notifyGroupId !== undefined && v.notifyGroupId !== before.notifyGroupId;
  }

  // ----- test notifications: preview / send a person's nudge now -----

  /** The person whose nudge is previewed: yourself, or (admins) anyone except the superadmin's own row. */
  function previewSubject(user: SessionUser, raw: unknown): PersonRow {
    const id = raw === undefined || raw === null || raw === '' ? user.personId : parseIntId(String(raw));
    if (id === null || id === undefined) throw new HttpError(409, 'Create your task list first');
    const p = getPerson(db, id);
    if (!p) throw new HttpError(404, 'not found');
    if (id !== user.personId) {
      if (!isAdmin(user)) throw new HttpError(403, 'you can only test your own nudges');
      if (isSuperEmail(p.email) && user.role !== 'superadmin') throw new HttpError(403, 'only the superadmin can test their own nudges');
    }
    if (!p.active) throw new HttpError(409, 'this person is deactivated');
    return p;
  }

  function previewFor(p: PersonRow) {
    const settings = { ...getTaskSettings(db), ...(deps.appName && { appName: deps.appName }) };
    const tasks = listTasks(db, [p.id], undefined);
    return previewDigest(p, tasks, clock(), settings);
  }

  const targetLabel = (t: { type: string; chatId: string }) => ({ type: t.type, chatId: t.chatId });

  function getPreview(user: SessionUser, query: URLSearchParams): ApiResult {
    const p = previewSubject(user, query.get('person'));
    const r = previewFor(p);
    if (!r.ok) {
      return ok({ person: { id: p.id, name: p.name }, ready: false, reason: r.reason, ...(r.reason === 'no_target' && { detail: r.detail }) });
    }
    return ok({ person: { id: p.id, name: p.name }, ready: true, mode: r.mode, target: targetLabel(r.target), message: r.message, taskCount: r.taskIds.length });
  }

  async function sendPreview(user: SessionUser, body: unknown): Promise<ApiResult> {
    const p = previewSubject(user, (body as { personId?: unknown } | null)?.personId);
    const r = previewFor(p);
    if (!r.ok) {
      throw new HttpError(409, r.reason === 'no_target' ? `Nudges can't be delivered yet: ${r.detail}` : 'No open tasks with a due date to preview');
    }
    const whatsapp = wa();
    const nowMs = clock().getTime();
    const last = lastTestNudge.get(p.id);
    if (last !== undefined && nowMs - last < TEST_NUDGE_COOLDOWN_MS) throw new HttpError(429, 'Wait a few seconds before sending another test');
    lastTestNudge.set(p.id, nowMs);
    const text = `🧪 [TEST] Preview of a ${deps.appName ?? 'Pushup Nudge'} reminder, nothing is due because of this message.\n\n${r.message}`;
    try {
      if (r.target.type === 'dm') await whatsapp.sendDirectMessage(r.target.chatId, text);
      else await whatsapp.sendGroupMessage(r.target.chatId, text, r.target.mentions);
    } catch (err) {
      lastTestNudge.delete(p.id);
      log.warn('test digest failed', { personId: p.id, target: r.target.type, err: err instanceof Error ? err.message : String(err) });
      throw wahaFail('could not send the test message', err);
    }
    addAudit(db, user.email, 'person_test_digest', { id: p.id, email: p.email, target: targetLabel(r.target), tasks: r.taskIds.length, mode: r.mode });
    return ok({ target: targetLabel(r.target), taskCount: r.taskIds.length, mode: r.mode });
  }

  // ----- admin: people -----

  /** Only the superadmin may create or demote admins (or change an admin's role/active state). */
  function guardAdminChange(user: SessionUser, before: PersonRow | undefined, after: { role?: string; active?: boolean; email?: unknown }): void {
    if (user.role === 'superadmin') return;
    // Changing an admin's email would hand the admin row to whoever owns the new address.
    const newEmail = typeof after.email === 'string' ? after.email.trim().toLowerCase() : undefined;
    if (before?.role === 'admin' && newEmail !== undefined && newEmail !== before.email) {
      throw new HttpError(403, 'only the superadmin can change an admin\'s email');
    }
    const makesAdmin = after.role === 'admin' && before?.role !== 'admin';
    const touchesAdmin = before?.role === 'admin' && ((after.role !== undefined && after.role !== 'admin') || after.active === false);
    // an admin the superadmin deactivated stays deactivated until the superadmin reactivates them
    const reactivatesAdmin = before?.role === 'admin' && !before.active && after.active === true;
    if (reactivatesAdmin) throw new HttpError(403, 'only the superadmin can reactivate an admin');
    if (makesAdmin || touchesAdmin) throw new HttpError(403, 'only the superadmin can create or demote admins');
  }

  async function peopleRoutes(user: SessionUser, method: string, segments: string[], body: unknown): Promise<ApiResult | undefined> {
    const audit = (a: string, d: Record<string, unknown>) => addAudit(db, user.email, a, d);
    const b = (body ?? {}) as { role?: string; active?: boolean; email?: unknown };
    const sup = deps.env.SUPERADMIN_EMAIL;
    const isSuperActor = user.role === 'superadmin';
    // isSuperadmin lets the UI mark the owner's row (locked for admins) without knowing SUPERADMIN_EMAIL
    if (segments.length === 1 && method === 'GET') return ok(listPeople(db).map((p) => ({ ...p, isSuperadmin: isSuperEmail(p.email) })));
    if (segments.length === 2 && segments[1] === 'self' && method === 'POST') {
      // The superadmin's own person row (own task list): creates it or returns the existing one.
      if (!isSuperActor) throw new HttpError(403, 'superadmin only');
      const { person, created, repaired } = ensureSuperadminPerson(db, sup, (body ?? {}) as { name?: unknown; whatsapp?: unknown });
      if (created) audit('person_self_create', { id: person.id, email: person.email });
      if (repaired) audit('person_self_repair', { id: person.id, email: person.email });
      return ok(person, created ? 201 : 200);
    }
    if (segments.length === 1 && method === 'POST') {
      guardAdminChange(user, undefined, b);
      const row = createPerson(db, body, { superadminEmail: sup, actorIsSuperadmin: isSuperActor, addedBy: user.email });
      audit('person_create', { id: row.id, email: row.email, role: row.role });
      return ok(row, 201);
    }
    if (segments.length === 3 && segments[2] === 'test-nudge' && method === 'POST') {
      const p = getPerson(db, parseIntId(segments[1]));
      if (!p) throw new HttpError(404, 'not found');
      if (!p.active) throw new HttpError(409, 'this person is deactivated');
      if (isSuperEmail(p.email) && !isSuperActor) throw new HttpError(403, 'only the superadmin can test their own nudges');
      const resolved = targetFor(p, getTaskSettings(db));
      if ('skip' in resolved) throw new HttpError(409, `no usable nudge target: ${resolved.skip}`);
      const t = resolved.target;
      const text = `✅ Test nudge from ${deps.appName ?? 'Pushup Nudge'}: notifications for ${p.name} are set up correctly.`;
      const whatsapp = wa();
      const nowMs = clock().getTime();
      const last = lastTestNudge.get(p.id);
      if (last !== undefined && nowMs - last < TEST_NUDGE_COOLDOWN_MS) throw new HttpError(429, 'Wait a few seconds before sending another test');
      lastTestNudge.set(p.id, nowMs);
      try {
        if (t.type === 'dm') await whatsapp.sendDirectMessage(t.chatId, text);
        else await whatsapp.sendGroupMessage(t.chatId, `${resolved.who} ${text}`, t.mentions);
      } catch (err) {
        lastTestNudge.delete(p.id); // a failed send is not a spam risk: allow an immediate retry
        log.warn('test nudge failed', { personId: p.id, target: t.type, err: err instanceof Error ? err.message : String(err) });
        throw wahaFail('could not send the test nudge', err);
      }
      audit('person_test_nudge', { id: p.id, email: p.email, target: { type: t.type, chatId: t.chatId } });
      return ok({ target: { type: t.type, chatId: t.chatId } });
    }
    if (segments.length === 2 && method === 'PUT') {
      const id = parseIntId(segments[1]);
      const before = getPerson(db, id);
      guardAdminChange(user, before, b);
      if (before && !isSuperActor && user.personId !== id && changesNotify(before, body)) {
        throw new HttpError(403, `only ${before.name} or the owner can change their WhatsApp number and where nudges go`);
      }
      const row = updatePerson(db, id, body, { superadminEmail: sup, actorIsSuperadmin: isSuperActor });
      audit('person_update', { id: row.id, email: row.email, role: row.role, active: row.active, notifyTarget: row.notifyTarget });
      return ok(row);
    }
    if (segments.length === 2 && method === 'DELETE') {
      const id = parseIntId(segments[1]);
      guardAdminChange(user, getPerson(db, id), { active: false });
      const row = deactivatePerson(db, id, { superadminEmail: sup, actorIsSuperadmin: isSuperActor });
      audit('person_deactivate', { id: row.id, email: row.email });
      return ok({ ok: true });
    }
    return undefined;
  }

  // ----- admin: access grants -----

  function grantRows() {
    return (db.prepare(
      `SELECT g.id, g.grantee_person_id, g.owner_person_id, g.level, g.created_by, g.created_at,
              ge.name AS grantee_name, o.name AS owner_name
       FROM access_grants g JOIN people ge ON ge.id = g.grantee_person_id JOIN people o ON o.id = g.owner_person_id
       ORDER BY ge.name COLLATE NOCASE, o.name COLLATE NOCASE`).all() as {
      id: number; grantee_person_id: number; owner_person_id: number; level: string; created_by: string; created_at: string;
      grantee_name: string; owner_name: string;
    }[]).map((r) => ({
      id: r.id, granteePersonId: r.grantee_person_id, granteeName: r.grantee_name, ownerPersonId: r.owner_person_id,
      ownerName: r.owner_name, level: r.level, createdBy: r.created_by, createdAt: r.created_at,
    }));
  }

  function grantRoutes(user: SessionUser, method: string, segments: string[], body: unknown): ApiResult | undefined {
    const audit = (a: string, d: Record<string, unknown>) => addAudit(db, user.email, a, d);
    if (segments.length === 1 && method === 'GET') return ok(grantRows());
    if (segments.length === 1 && method === 'POST') {
      const v = parseOrThrow(grantSchema, body);
      if (v.granteePersonId === v.ownerPersonId) {
        throw new StoreError('validation', 'validation failed', { granteePersonId: 'must differ from the owner' });
      }
      if (!getPerson(db, v.granteePersonId)) throw new StoreError('validation', 'validation failed', { granteePersonId: 'unknown person' });
      const ownerRow = getPerson(db, v.ownerPersonId);
      if (!ownerRow) throw new StoreError('validation', 'validation failed', { ownerPersonId: 'unknown person' });
      if (isSuperEmail(ownerRow.email) && user.role !== 'superadmin') throw new HttpError(403, "only the superadmin can change access to the superadmin's list");
      // Granting again changes the level (idempotent for an unchanged grant).
      db.prepare(
        `INSERT INTO access_grants (grantee_person_id, owner_person_id, level, created_by, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(grantee_person_id, owner_person_id) DO UPDATE SET level = excluded.level, created_by = excluded.created_by`,
      ).run(v.granteePersonId, v.ownerPersonId, v.level, user.email, clock().toISOString());
      audit('access_grant_set', { granteePersonId: v.granteePersonId, ownerPersonId: v.ownerPersonId, level: v.level });
      const row = grantRows().find((g) => g.granteePersonId === v.granteePersonId && g.ownerPersonId === v.ownerPersonId)!;
      return ok(row, 201);
    }
    if (segments.length === 2 && method === 'DELETE') {
      const id = parseIntId(segments[1]);
      const row = db.prepare(`SELECT grantee_person_id, owner_person_id, level FROM access_grants WHERE id = ?`).get(id) as
        { grantee_person_id: number; owner_person_id: number; level: string } | undefined;
      if (!row) throw new HttpError(404, 'not found');
      const owner = getPerson(db, row.owner_person_id);
      if (owner && isSuperEmail(owner.email) && user.role !== 'superadmin') throw new HttpError(403, "only the superadmin can change access to the superadmin's list");
      db.prepare(`DELETE FROM access_grants WHERE id = ?`).run(id);
      audit('access_grant_remove', { granteePersonId: row.grantee_person_id, ownerPersonId: row.owner_person_id, level: row.level });
      return ok({ ok: true });
    }
    return undefined;
  }

  return async function handle(
    user: SessionUser, method: string, segments: string[], query: URLSearchParams, body: unknown,
  ): Promise<ApiResult> {
    const [resource, sub] = segments;
    let result: ApiResult | undefined;
    switch (resource) {
      case 'me':
        if (method === 'GET' && segments.length === 1) {
          result = ok({ email: user.email, name: user.name, role: user.role, personId: user.personId });
        }
        break;
      case 'app':
        if (sub === 'owners' && method === 'GET' && segments.length === 2) result = ok(visibleOwners(db, user));
        else if (sub === 'nudge-target' && method === 'GET' && segments.length === 2) result = nudgeTarget(user);
        else if (sub === 'nudge-preview' && method === 'GET' && segments.length === 2) result = getPreview(user, query);
        else if (sub === 'nudge-preview' && segments[2] === 'send' && method === 'POST' && segments.length === 3) result = await sendPreview(user, body);
        else if (sub === 'voice-parse' && method === 'POST' && segments.length === 2) result = await voiceParse(user, body);
        else if (sub === 'voice-parse' && method === 'GET' && segments.length === 2) result = ok({ ai: !!deps.voiceLlm });
        else if (sub === 'notify-settings' && method === 'GET' && segments.length === 2) result = notifyView(user, notifySubject(user, query.get('person'), false));
        else if (sub === 'notify-settings' && method === 'PUT' && segments.length === 2) result = putNotify(user, body);
        else if (sub === 'groups' && method === 'GET' && segments.length === 2) {
          // for choosing where your own nudges go; only admins may force a refresh from WhatsApp
          if (user.personId === null && !isAdmin(user)) throw new HttpError(403, 'Create your task list first');
          try {
            result = ok(await groups(isAdmin(user) && query.get('refresh') === '1'));
          } catch (err) {
            log.warn('listing WhatsApp groups failed', { err: err instanceof Error ? err.message : String(err) });
            throw wahaFail('could not list WhatsApp groups', err);
          }
        } else if (sub === 'tasks' && method === 'GET' && segments.length === 2) result = getTasks(user, query);
        else if (sub === 'tasks') result = taskRoutes(user, method, segments, body);
        break;
      case 'nudge':
        requireAdmin(user);
        if (sub === 'groups' && method === 'GET' && segments.length === 2) {
          try {
            result = ok(await groups(query.get('refresh') === '1'));
          } catch (err) {
            log.warn('listing WhatsApp groups failed', { err: err instanceof Error ? err.message : String(err) });
            throw wahaFail('could not list WhatsApp groups', err);
          }
        } else if (sub === 'audit' && method === 'GET' && segments.length === 2) {
          result = ok(listNudgeAudit(db, 200));
        }
        break;
      case 'people':
        requireAdmin(user);
        result = await peopleRoutes(user, method, segments, body);
        break;
      case 'access-grants':
        requireAdmin(user);
        result = grantRoutes(user, method, segments, body);
        break;
      case 'task-settings':
        requireAdmin(user);
        if (segments.length === 1 && method === 'GET') result = ok(getTaskSettings(db));
        if (segments.length === 1 && method === 'PUT') {
          if (user.role !== 'superadmin') throw new HttpError(403, 'only the owner can change the team notification settings');
          const next = setTaskSettings(db, body);
          addAudit(db, user.email, 'task_settings_update', { ...next });
          result = ok(next);
        }
        break;
    }
    if (!result) throw new HttpError(404, 'not found');
    return result;
  };
}
