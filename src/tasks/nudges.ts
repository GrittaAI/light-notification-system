// The Nudge engine: decides which owners get a WhatsApp digest now (pure computeDigests) and sends them
// (runTaskNudges). State is written only after WAHA accepts a message, so a failure retries next minute.

import type { DB } from '../db.js';
import { logger } from '../logger.js';
import { type PersonDbRow, type PersonRow, toPerson } from '../people.js';
import type { WhatsApp } from '../whatsapp.js';
import { getTaskSettings, type TaskSettings } from './settings.js';
import { type TaskDbRow, type TaskRow, toTask } from './store.js';

const log = logger.child({ module: 'task-nudges' });

export const MAX_LISTED = 20;
export const WARN_EVERY_MS = 3600_000;
const IST_OFFSET_MIN = 330;

export interface NudgeState { nextDigestAt: string | null; lastDigestAt: string | null }

/** Settings plus the product name used in the message footer (default "Pushup Nudge"). */
export type DigestSettings = TaskSettings & { appName?: string };

export interface DigestTarget {
  type: 'group' | 'dm';
  chatId: string;
  /** Numbers to @mention (digits only); empty for a DM. */
  mentions: string[];
}

export interface Digest {
  ownerId: number;
  /** Every nudgeable task of the owner, overdue first, then by due time. */
  taskIds: string[];
  /** The subset that has never been alerted since it was (re)armed. */
  newTaskIds: string[];
  target: DigestTarget;
  message: string;
  /** The owner's repeat interval (personal or team default): next_digest_at = sent time + this. */
  repeatMinutes: number;
}

/** The settings that apply to one person: their own timing and quiet hours where set, else the team default. */
export function effectiveSettings<S extends TaskSettings>(p: PersonRow, s: S): S {
  return { ...s, leadMinutes: p.leadMinutes ?? s.leadMinutes, repeatMinutes: p.repeatMinutes ?? s.repeatMinutes, quietHours: p.quietHours ?? s.quietHours };
}

// ---------- formatting ----------

const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });
const istTime = (iso: string) => timeFmt.format(new Date(iso)).replace(/[  ]/g, ' ');

function span(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h >= 48) return `${Math.floor(h / 24)} d`;
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "due in 10 min", "overdue by 25 min" or "due now". */
export function relativeDue(dueIso: string, now: Date): string {
  const diff = Date.parse(dueIso) - now.getTime();
  if (diff > 0) return `due in ${span(Math.ceil(diff / 60_000))}`;
  const late = Math.floor(-diff / 60_000);
  return late < 1 ? 'due now' : `overdue by ${span(late)}`;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** "Due in 5 min, at 12:05 PM", "Overdue by 20 min (was due 11:40 AM)" or "Due now, at 12:05 PM". */
function dueLine(dueIso: string, now: Date): string {
  const rel = relativeDue(dueIso, now);
  const at = istTime(dueIso);
  if (rel.startsWith('overdue')) return `Overdue${rel.slice('overdue'.length)} (was due ${at})`;
  return `${rel[0]!.toUpperCase()}${rel.slice(1)}, at ${at}`;
}

/**
 * WhatsApp text: bold header, one bold title + italic due line per task, and a closing hint. No links, so WhatsApp
 * shows no preview card and the tasks stay the focus. `who` is "@number" in a group, empty in a DM.
 */
function buildMessage(tasks: TaskRow[], now: Date, who: string, appName: string): string {
  const tag = who ? ` ${who}` : '';
  const footer = `_Mark done or snooze in the ${appName} app._`;
  if (tasks.length === 1) {
    const t = tasks[0]!;
    return [`*Reminder: task ${relativeDue(t.dueAt!, now)}*${tag}`, '', `*${oneLine(t.title)}*`, `_${dueLine(t.dueAt!, now)}_`, '', footer].join('\n');
  }
  const lines = [`*Reminder: ${tasks.length} pending tasks*${tag}`];
  tasks.slice(0, MAX_LISTED).forEach((t, i) => {
    lines.push('', `*${i + 1}. ${oneLine(t.title)}*`, `_${dueLine(t.dueAt!, now)}_`);
  });
  if (tasks.length > MAX_LISTED) lines.push('', `+ ${tasks.length - MAX_LISTED} more`);
  lines.push('', footer);
  return lines.join('\n');
}

// ---------- quiet hours ----------

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Quiet hours in Asia/Kolkata; the window may cross midnight. Start is inclusive, end exclusive. */
export function inQuietHours(now: Date, q: TaskSettings['quietHours']): boolean {
  if (!q.enabled) return false;
  const istMin = (((Math.floor(now.getTime() / 60_000) + IST_OFFSET_MIN) % 1440) + 1440) % 1440;
  const start = toMinutes(q.start);
  const end = toMinutes(q.end);
  return start < end ? istMin >= start && istMin < end : istMin >= start || istMin < end;
}

// ---------- the pure decision ----------

/** Nudgeable: owner active, not done, not deleted, has a due time, within the lead window, and not snoozed. */
export function isNudgeable(t: TaskRow, now: Date, leadMinutes: number): boolean {
  if (t.status === 'done' || t.deletedAt !== null || t.dueAt === null) return false;
  if (now.getTime() < Date.parse(t.dueAt) - leadMinutes * 60_000) return false;
  return t.snoozedUntil === null || Date.parse(t.snoozedUntil) <= now.getTime();
}

/** Where this person's nudges go (the same decision the nudge job makes), or why there is no usable target. */
export function targetFor(p: PersonRow, s: DigestSettings): { target: DigestTarget; who: string } | { skip: string } {
  const number = p.whatsapp;
  if (p.notifyTarget === 'dm') {
    return number ? { target: { type: 'dm', chatId: `${number}@c.us`, mentions: [] }, who: '' } : { skip: 'no whatsapp number for a direct message' };
  }
  const chatId = p.notifyTarget === 'group' ? p.notifyGroupId : s.defaultGroupId;
  if (!chatId) return { skip: p.notifyTarget === 'group' ? 'no group id set for this person' : 'no default group set' };
  if (!number) return { skip: 'no whatsapp number to mention' };
  return { target: { type: 'group', chatId, mentions: [number] }, who: `@${number}` };
}

/**
 * Pure: which digests to send at `now`. No I/O, no clock reads.
 * An owner gets one when any nudgeable task was never alerted, or their repeat timer has passed, and their quiet hours
 * are off. Lead time, repeat and quiet hours are per person (falling back to the team settings).
 * Such a digest also lists tasks that become nudgeable within `mergeAheadMinutes` (never the reason for a digest).
 * `onSkip` is told about owners that are due but have no usable target.
 */
export function computeDigests(
  now: Date,
  people: readonly PersonRow[],
  tasksByOwner: ReadonlyMap<number, readonly TaskRow[]>,
  nudgeStateByOwner: ReadonlyMap<number, NudgeState>,
  settings: DigestSettings,
  onSkip?: (ownerId: number, reason: string) => void,
): Digest[] {
  const out: Digest[] = [];
  for (const p of people) {
    if (!p.active) continue;
    const es = effectiveSettings(p, settings);
    if (inQuietHours(now, es.quietHours)) continue;
    const mine = tasksByOwner.get(p.id) ?? [];
    const nudgeable = mine.filter((t) => isNudgeable(t, now, es.leadMinutes));
    if (nudgeable.length === 0) continue;
    const next = nudgeStateByOwner.get(p.id)?.nextDigestAt ?? null;
    const newOnes = nudgeable.filter((t) => t.firstAlertSentAt === null);
    const repeatDue = next !== null && Date.parse(next) <= now.getTime();
    if (newOnes.length === 0 && !repeatDue) continue;
    // The digest is due anyway (decided only by tasks nudgeable NOW, so merging can never delay an alert).
    // Pull in tasks that become nudgeable within the look-ahead window: one message instead of pings minutes apart.
    const ahead = new Date(now.getTime() + settings.mergeAheadMinutes * 60_000);
    const listed = (settings.mergeAheadMinutes > 0 ? mine.filter((t) => isNudgeable(t, ahead, es.leadMinutes)) : nudgeable)
      .sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const resolved = targetFor(p, settings);
    if ('skip' in resolved) {
      onSkip?.(p.id, resolved.skip);
      continue;
    }
    out.push({
      ownerId: p.id,
      taskIds: listed.map((t) => t.id),
      newTaskIds: listed.filter((t) => t.firstAlertSentAt === null).map((t) => t.id),
      target: resolved.target,
      message: buildMessage(listed, now, resolved.who, settings.appName ?? 'Pushup Nudge'),
      repeatMinutes: es.repeatMinutes,
    });
  }
  return out;
}

// ---------- preview (test notifications) ----------

export type PreviewMode = 'due' | 'upcoming';

export type DigestPreview =
  | { ok: true; mode: PreviewMode; target: DigestTarget; message: string; taskIds: string[] }
  | { ok: false; reason: 'no_target'; detail: string }
  | { ok: false; reason: 'no_tasks' };

/**
 * Pure: the WhatsApp message this person would get if a nudge went out at `now`, built with the real
 * formatter and target rules. Uses the tasks nudgeable now (plus the merge-ahead window, as a real digest
 * would); if none are, it previews their open dated tasks instead, so the format can still be checked.
 * Ignores quiet hours and the repeat timer, and changes nothing.
 */
export function previewDigest(person: PersonRow, tasks: readonly TaskRow[], now: Date, settings: DigestSettings): DigestPreview {
  const resolved = targetFor(person, settings);
  if ('skip' in resolved) return { ok: false, reason: 'no_target', detail: resolved.skip };
  const byDue = (a: TaskRow, b: TaskRow) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  const ahead = new Date(now.getTime() + settings.mergeAheadMinutes * 60_000);
  let mode: PreviewMode = 'due';
  const lead = effectiveSettings(person, settings).leadMinutes;
  let listed = tasks.filter((t) => isNudgeable(t, ahead, lead)).sort(byDue);
  if (listed.length === 0) {
    mode = 'upcoming';
    listed = tasks.filter((t) => t.status !== 'done' && t.deletedAt === null && t.dueAt !== null).sort(byDue);
  }
  if (listed.length === 0) return { ok: false, reason: 'no_tasks' };
  return { ok: true, mode, target: resolved.target, message: buildMessage(listed, now, resolved.who, settings.appName ?? 'Pushup Nudge'), taskIds: listed.map((t) => t.id) };
}

// ---------- the job ----------

export interface NudgeDeps {
  whatsapp: Pick<WhatsApp, 'sendGroupMessage' | 'sendDirectMessage'>;
  /** Product name for the message footer (APP_NAME). */
  appName?: string;
  /** When each owner was last warned about a missing target (so the warning is logged at most hourly). */
  warned?: Map<number, number>;
}

export interface NudgeRunResult { digests: number; sent: number; failed: number; ok: boolean }

const defaultWarned = new Map<number, number>();

/**
 * One run of the nudge job. Never throws. For each digest: send; only after WAHA accepts it, in ONE transaction,
 * set first_alert_sent_at on newly alerted tasks, last_notified_at on all listed tasks, the owner's nudge state
 * and a task_digests row. On a send failure nothing changes, so the next minute retries.
 */
export async function runTaskNudges(db: DB, deps: NudgeDeps, now: Date = new Date()): Promise<NudgeRunResult> {
  const result: NudgeRunResult = { digests: 0, sent: 0, failed: 0, ok: true };
  try {
    const settings: DigestSettings = { ...getTaskSettings(db), ...(deps.appName && { appName: deps.appName }) };
    const people = (db.prepare(`SELECT * FROM people WHERE active = 1 ORDER BY id`).all() as PersonDbRow[]).map(toPerson);
    const tasksByOwner = new Map<number, TaskRow[]>();
    const rows = db
      .prepare(
        `SELECT t.* FROM tasks t JOIN people p ON p.id = t.owner_person_id
         WHERE p.active = 1 AND t.deleted_at IS NULL AND t.status != 'done' AND t.due_at IS NOT NULL`,
      )
      .all() as TaskDbRow[];
    for (const r of rows) {
      const t = toTask(r);
      (tasksByOwner.get(t.ownerPersonId) ?? tasksByOwner.set(t.ownerPersonId, []).get(t.ownerPersonId)!).push(t);
    }
    const state = new Map<number, NudgeState>(
      (db.prepare(`SELECT owner_person_id, next_digest_at, last_digest_at FROM task_nudge_state`).all() as
        { owner_person_id: number; next_digest_at: string | null; last_digest_at: string | null }[])
        .map((r) => [r.owner_person_id, { nextDigestAt: r.next_digest_at, lastDigestAt: r.last_digest_at }]),
    );
    const warned = deps.warned ?? defaultWarned;
    const digests = computeDigests(now, people, tasksByOwner, state, settings, (ownerId, reason) => {
      const last = warned.get(ownerId);
      if (last !== undefined && now.getTime() - last < WARN_EVERY_MS) return;
      warned.set(ownerId, now.getTime());
      log.warn('task nudge skipped: no usable target', { ownerId, reason });
    });
    result.digests = digests.length;

    const nowIso = now.toISOString();
    for (const d of digests) {
      const nextIso = new Date(now.getTime() + d.repeatMinutes * 60_000).toISOString();
      try {
        if (d.target.type === 'dm') await deps.whatsapp.sendDirectMessage(d.target.chatId, d.message);
        else await deps.whatsapp.sendGroupMessage(d.target.chatId, d.message, d.target.mentions);
      } catch (err) {
        result.failed++;
        result.ok = false;
        log.error('task digest send failed; will retry next run', { ownerId: d.ownerId, tasks: d.taskIds.length, err });
        continue;
      }
      try {
        db.transaction(() => {
          const alert = db.prepare(`UPDATE tasks SET first_alert_sent_at = ? WHERE id = ? AND first_alert_sent_at IS NULL`);
          for (const id of d.newTaskIds) alert.run(nowIso, id);
          const notified = db.prepare(`UPDATE tasks SET last_notified_at = ? WHERE id = ?`);
          for (const id of d.taskIds) notified.run(nowIso, id);
          db.prepare(
            `INSERT INTO task_nudge_state (owner_person_id, next_digest_at, last_digest_at) VALUES (?, ?, ?)
             ON CONFLICT(owner_person_id) DO UPDATE SET next_digest_at = excluded.next_digest_at, last_digest_at = excluded.last_digest_at`,
          ).run(d.ownerId, nextIso, nowIso);
          db.prepare(`INSERT INTO task_digests (owner_person_id, sent_at, target, task_ids) VALUES (?, ?, ?, ?)`)
            .run(d.ownerId, nowIso, d.target.chatId, JSON.stringify(d.taskIds));
        })();
        result.sent++;
        log.info('task digest sent', { ownerId: d.ownerId, tasks: d.taskIds.length, target: d.target.type });
      } catch (err) {
        // Sent but not recorded: the next run would resend. Loud, because it means the database is unhealthy.
        result.failed++;
        result.ok = false;
        log.error('task digest sent but state write failed', { ownerId: d.ownerId, err });
      }
    }
  } catch (err) {
    result.ok = false;
    log.error('task nudge run crashed', { err });
  }
  return result;
}
