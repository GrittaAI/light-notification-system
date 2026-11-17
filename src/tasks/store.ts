// Task repository: validation, optimistic versioning, the single place that re-arms alerts, and activity rows.
// Access checks happen in the API layer (access.ts) before these functions are called.

import { z } from 'zod';
import type { DB } from '../db.js';
import { parseOrThrow } from '../store-errors.js';

export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export interface ChecklistItem { id: string; text: string; done: boolean }

export interface TaskRow {
  id: string;
  ownerPersonId: number;
  title: string;
  notes: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: string | null;
  checklist: ChecklistItem[];
  snoozedUntil: string | null;
  completedAt: string | null;
  firstAlertSentAt: string | null;
  lastNotifiedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  deletedAt: string | null;
}

export interface TaskDbRow {
  id: string; owner_person_id: number; title: string; notes: string; status: TaskStatus; priority: TaskPriority;
  due_at: string | null; checklist_json: string; snoozed_until: string | null; completed_at: string | null;
  first_alert_sent_at: string | null; last_notified_at: string | null; created_by: string; created_at: string;
  updated_at: string; version: number; deleted_at: string | null;
}

export function toTask(r: TaskDbRow): TaskRow {
  let checklist: ChecklistItem[] = [];
  try { checklist = JSON.parse(r.checklist_json) as ChecklistItem[]; } catch { /* corrupt: show empty */ }
  return {
    id: r.id, ownerPersonId: r.owner_person_id, title: r.title, notes: r.notes, status: r.status, priority: r.priority,
    dueAt: r.due_at, checklist, snoozedUntil: r.snoozed_until, completedAt: r.completed_at,
    firstAlertSentAt: r.first_alert_sent_at, lastNotifiedAt: r.last_notified_at, createdBy: r.created_by,
    createdAt: r.created_at, updatedAt: r.updated_at, version: r.version, deletedAt: r.deleted_at,
  };
}

/** What the API returns: no internal alert bookkeeping; deleted tasks carry deleted:true. */
export function publicTask(t: TaskRow) {
  const { firstAlertSentAt: _a, deletedAt, ...rest } = t;
  void _a;
  return { ...rest, deleted: deletedAt !== null };
}

// ---------- validation ----------

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isoDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Pick a valid date and time')
  .transform((v) => new Date(v).toISOString());

const checklistSchema = z
  .array(z.object({
    id: z.string().trim().min(1).max(64),
    text: z.string().max(300, 'Use at most 300 characters'),
    done: z.boolean({ error: 'Check or uncheck the item' }),
  }))
  .max(100, 'Use at most 100 items');

export const taskInputSchema = z.object({
  ownerPersonId: z.number().int().positive().optional(),
  title: z.string({ error: 'Enter a title' }).trim().min(1, 'Enter a title').max(200, 'Use at most 200 characters'),
  notes: z.string().max(10_000, 'Use at most 10000 characters').optional(),
  status: z.enum(['todo', 'in_progress', 'done']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  dueAt: isoDate.nullable().optional(),
  checklist: checklistSchema.optional(),
  baseVersion: z.number().int().min(1).optional(),
  /** Only `false` is accepted: it undeletes a soft-deleted task. Use DELETE to delete. */
  deleted: z.literal(false, { error: 'Use the delete action to delete a task' }).optional(),
});
export type TaskInput = z.output<typeof taskInputSchema>;

export const snoozeSchema = z.object({ minutes: z.number({ error: 'Choose between 15 minutes and 7 days' }).int('Choose between 15 minutes and 7 days').min(15, 'Choose between 15 minutes and 7 days').max(10_080, 'Choose between 15 minutes and 7 days') });

export function parseTaskInput(input: unknown): TaskInput {
  return parseOrThrow(taskInputSchema, input);
}

// ---------- reads ----------

export function getTask(db: DB, id: string): TaskRow | undefined {
  const r = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskDbRow | undefined;
  return r && toTask(r);
}

/** Tasks of the given owners. With `since`: everything changed at or after it, soft-deleted included. Otherwise non-deleted only. */
export function listTasks(db: DB, ownerIds: number[], since?: string): TaskRow[] {
  if (ownerIds.length === 0) return [];
  const marks = ownerIds.map(() => '?').join(',');
  // >= (not >): an update in the same millisecond as the client's last serverTime must not be missed; the client upserts by id.
  const sql = since
    ? `SELECT * FROM tasks WHERE owner_person_id IN (${marks}) AND updated_at >= ? ORDER BY updated_at, id`
    : `SELECT * FROM tasks WHERE owner_person_id IN (${marks}) AND deleted_at IS NULL ORDER BY COALESCE(due_at, '9999'), created_at, id`;
  const rows = db.prepare(sql).all(...ownerIds, ...(since ? [since] : [])) as TaskDbRow[];
  return rows.map(toTask);
}

export function listActivity(db: DB, taskId: string, limit = 200) {
  return (db.prepare(`SELECT id, at, actor, action, details FROM task_activity WHERE task_id = ? ORDER BY id DESC LIMIT ?`)
    .all(taskId, limit) as { id: number; at: string; actor: string; action: string; details: string }[])
    .map((r) => ({ ...r, details: JSON.parse(r.details) as unknown }));
}

// ---------- the single place that decides state transitions and re-arming ----------

type Mutable = Pick<TaskRow,
  'ownerPersonId' | 'title' | 'notes' | 'status' | 'priority' | 'dueAt' | 'checklist' | 'snoozedUntil' | 'completedAt' | 'firstAlertSentAt' | 'deletedAt'>;

const FIELDS: (keyof Mutable)[] = ['ownerPersonId', 'title', 'notes', 'status', 'priority', 'dueAt', 'checklist', 'snoozedUntil', 'completedAt', 'deletedAt'];
/** Fields whose before/after values are small enough to keep in the activity details. */
const SHOWN = new Set<keyof Mutable>(['ownerPersonId', 'status', 'priority', 'dueAt', 'snoozedUntil', 'deletedAt']);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Applies `patch` to `prev` (null for a create) and returns the next state plus the changed field names.
 * Re-arming (first_alert_sent_at = NULL) is decided here and nowhere else: on create, and when due_at changes,
 * the task is snoozed or unsnoozed, reopened, undeleted (and, conservatively, when it moves to another owner).
 */
export function transition(prev: Mutable | null, patch: Partial<Mutable>, nowIso: string): { next: Mutable; changed: string[]; rearmed: boolean } {
  const base: Mutable = prev ?? {
    ownerPersonId: 0, title: '', notes: '', status: 'todo', priority: 'medium', dueAt: null, checklist: [],
    snoozedUntil: null, completedAt: null, firstAlertSentAt: null, deletedAt: null,
  };
  const next: Mutable = { ...base, ...patch };
  let rearm = prev === null;
  if (next.status === 'done' && base.status !== 'done') next.completedAt = nowIso;
  if (next.status !== 'done' && base.status === 'done') { next.completedAt = null; rearm = true; } // reopened
  if (prev) {
    if (!same(next.dueAt, base.dueAt)) rearm = true;
    if (!same(next.snoozedUntil, base.snoozedUntil)) rearm = true;
    if (base.deletedAt !== null && next.deletedAt === null) rearm = true; // undeleted
    if (next.ownerPersonId !== base.ownerPersonId) rearm = true;
  }
  if (rearm) next.firstAlertSentAt = null;
  const changed: string[] = prev ? FIELDS.filter((f) => !same(base[f], next[f])) : ['title'];
  return { next, changed, rearmed: rearm };
}

function activityDetails(prev: Mutable | null, next: Mutable, changed: string[]): Record<string, unknown> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of changed as (keyof Mutable)[]) {
    if (SHOWN.has(f)) changes[f] = { from: prev ? prev[f] : null, to: next[f] };
  }
  return { fields: changed, changes };
}

function addActivity(db: DB, taskId: string, actor: string, action: string, at: string, details: Record<string, unknown>): void {
  db.prepare(`INSERT INTO task_activity (task_id, at, actor, action, details) VALUES (?, ?, ?, ?, ?)`)
    .run(taskId, at, actor, action, JSON.stringify(details));
}

export type SaveResult = { ok: true; task: TaskRow } | { ok: false; conflict: TaskRow };

/** Writes `next` over `prev` (or inserts it), bumps the version and records activity. All in one transaction. */
function persist(db: DB, id: string, prev: TaskRow | null, next: Mutable, changed: string[], action: string, actor: string, nowIso: string): TaskRow {
  return db.transaction(() => {
    if (!prev) {
      db.prepare(
        `INSERT INTO tasks (id, owner_person_id, title, notes, status, priority, due_at, checklist_json, snoozed_until, completed_at,
           first_alert_sent_at, last_notified_at, created_by, created_at, updated_at, version, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?)`,
      ).run(id, next.ownerPersonId, next.title, next.notes, next.status, next.priority, next.dueAt, JSON.stringify(next.checklist),
        next.snoozedUntil, next.completedAt, next.firstAlertSentAt, actor, nowIso, nowIso, next.deletedAt);
    } else {
      const info = db.prepare(
        `UPDATE tasks SET owner_person_id = ?, title = ?, notes = ?, status = ?, priority = ?, due_at = ?, checklist_json = ?,
           snoozed_until = ?, completed_at = ?, first_alert_sent_at = ?, deleted_at = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND version = ?`,
      ).run(next.ownerPersonId, next.title, next.notes, next.status, next.priority, next.dueAt, JSON.stringify(next.checklist),
        next.snoozedUntil, next.completedAt, next.firstAlertSentAt, next.deletedAt, nowIso, id, prev.version);
      if (info.changes !== 1) throw new Error('task changed concurrently');
    }
    if (changed.length > 0 || !prev) addActivity(db, id, actor, action, nowIso, activityDetails(prev, next, changed));
    return getTask(db, id)!;
  })();
}

/**
 * Create or update by client UUID. For an existing task `input.baseVersion` must equal the current version,
 * otherwise the server copy comes back as a conflict. The caller has already checked edit access.
 */
export function saveTask(db: DB, id: string, input: TaskInput, actor: { email: string; personId: number | null }, nowIso: string): SaveResult {
  const prev = getTask(db, id) ?? null;
  if (prev) {
    if (input.baseVersion !== prev.version) return { ok: false, conflict: prev };
    // A soft-deleted task is only revived on purpose.
    if (prev.deletedAt !== null && input.deleted !== false) return { ok: false, conflict: prev };
  }
  const patch: Partial<Mutable> = {
    title: input.title,
    ...(input.notes !== undefined && { notes: input.notes }),
    ...(input.status !== undefined && { status: input.status }),
    ...(input.priority !== undefined && { priority: input.priority }),
    ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
    ...(input.checklist !== undefined && { checklist: input.checklist }),
    ...(input.deleted === false && { deletedAt: null }),
  };
  const owner = input.ownerPersonId ?? prev?.ownerPersonId ?? actor.personId;
  if (owner === null || owner === undefined) throw new Error('owner required'); // callers validate this first
  patch.ownerPersonId = owner;
  const { next, changed } = transition(prev, patch, nowIso);
  const undeleting = prev !== null && prev.deletedAt !== null && next.deletedAt === null;
  const action = !prev ? 'create' : undeleting ? 'undelete' : 'update';
  return { ok: true, task: persist(db, id, prev, next, changed, action, actor.email, nowIso) };
}

export type TaskAction = 'done' | 'reopen' | 'snooze' | 'unsnooze' | 'delete';

/** Idempotent actions; no baseVersion. Returns the task (unchanged, and not version-bumped, if there was nothing to do). */
export function applyAction(db: DB, task: TaskRow, action: TaskAction, actor: string, nowIso: string, minutes?: number): TaskRow {
  if (task.deletedAt !== null) return task;
  let patch: Partial<Mutable> | null = null;
  switch (action) {
    case 'done':
      if (task.status !== 'done') patch = { status: 'done' };
      break;
    case 'reopen':
      if (task.status === 'done') patch = { status: 'todo' };
      break;
    case 'snooze':
      if (task.status !== 'done') patch = { snoozedUntil: new Date(Date.parse(nowIso) + (minutes ?? 0) * 60_000).toISOString() };
      break;
    case 'unsnooze':
      if (task.snoozedUntil !== null) patch = { snoozedUntil: null };
      break;
    case 'delete':
      patch = { deletedAt: nowIso };
      break;
  }
  if (!patch) return task;
  const { next, changed } = transition(task, patch, nowIso);
  if (changed.length === 0) return task;
  return persist(db, task.id, task, next, changed, action, actor, nowIso);
}
