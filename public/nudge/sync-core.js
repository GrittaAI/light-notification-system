// Nudge sync core: pure functions only (no DOM, no IndexedDB, no fetch of its own), so they are unit-tested in Node.
//  - IST time helpers (Nudge shows every time in Asia/Kolkata, UTC+05:30, no DST)
//  - grouping of tasks into Overdue / Today / Upcoming / No date / Done
//  - the outbox: enqueue with compaction, and pushing it through an injected `send`
//  - merging a server pull into the local copy, and pruning owners that are no longer visible

export const IST_OFFSET_MS = 330 * 60_000;
export const DAY_MS = 86_400_000;
export const DONE_DAYS = 30;
export const MAX_CHECKLIST = 100;

// ---------- IST time ----------

/** Start (as epoch ms, UTC) of the IST calendar day containing `ms`. */
export function istDayStart(ms) {
  return Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

/** The wall-clock parts of `ms` in IST. */
export function istParts(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: d.getUTCDay(),
  };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

/** "5:00 PM" (IST). */
export function fmtTime(ms) {
  const p = istParts(ms);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}:${pad(p.minute)} ${p.hour < 12 ? 'AM' : 'PM'}`;
}

/** "Thu 20 Nov" (IST), with the year when it is not the current IST year. */
export function fmtDate(ms, nowMs) {
  const p = istParts(ms);
  const year = nowMs !== undefined && istParts(nowMs).year !== p.year ? ` ${p.year}` : '';
  return `${WEEKDAYS[p.weekday]} ${p.day} ${MONTHS[p.month - 1]}${year}`;
}

/** "Today 5:00 PM", "Tomorrow 10:00 AM", "Yesterday 9:00 AM", "Thu 20 Nov, 3:00 PM". */
export function fmtDateTime(ms, nowMs) {
  const dayDiff = Math.round((istDayStart(ms) - istDayStart(nowMs)) / DAY_MS);
  const when = dayDiff === 0 ? 'Today' : dayDiff === 1 ? 'Tomorrow' : dayDiff === -1 ? 'Yesterday' : null;
  return when ? `${when} ${fmtTime(ms)}` : `${fmtDate(ms, nowMs)}, ${fmtTime(ms)}`;
}

/** A compact span: "25m", "3h", "2d". */
export function fmtSpan(ms) {
  const min = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  if (min < 60) return `${min}m`;
  if (min < 48 * 60) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}

/** "in 12m" / "25m ago". */
export function fmtRelative(ms, nowMs) {
  const diff = ms - nowMs;
  return diff >= 0 ? `in ${fmtSpan(diff)}` : `${fmtSpan(diff)} ago`;
}

/**
 * The due chip of a list row: "5:00 PM" (today), "Tomorrow 10:00 AM", "Thu 20 Nov, 3:00 PM", "Overdue 25m".
 * Returns { text, overdue }.
 */
export function dueChip(dueAt, nowMs) {
  const ms = Date.parse(dueAt);
  if (ms < nowMs) return { text: `Overdue ${fmtSpan(nowMs - ms)}`, overdue: true };
  const dayDiff = Math.round((istDayStart(ms) - istDayStart(nowMs)) / DAY_MS);
  if (dayDiff === 0) return { text: fmtTime(ms), overdue: false };
  return { text: fmtDateTime(ms, nowMs), overdue: false };
}

/** <input type="datetime-local"> value ("2026-11-17T18:00", read as IST) to an ISO UTC string; null if invalid. */
export function istInputToIso(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value || '');
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - IST_OFFSET_MS;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** ISO UTC to a datetime-local value in IST. */
export function isoToIstInput(iso) {
  const p = istParts(Date.parse(iso));
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** ISO UTC for IST wall-clock `hour:00` on the IST day `dayOffset` days from today. */
export function istAt(nowMs, dayOffset, hour) {
  return new Date(istDayStart(nowMs) + dayOffset * DAY_MS + hour * 3_600_000).toISOString();
}

// ---------- grouping ----------

const byDue = (a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/**
 * Groups one owner's tasks for the home list. Snoozed tasks stay in their section (the row shows a badge).
 * Done tasks are shown for DONE_DAYS after completion, newest first. Deleted tasks never show.
 */
export function groupTasks(tasks, nowMs) {
  const out = { overdue: [], today: [], upcoming: [], none: [], done: [] };
  const endOfToday = istDayStart(nowMs) + DAY_MS;
  for (const t of tasks) {
    if (t.deleted) continue;
    if (t.status === 'done') {
      const at = Date.parse(t.completedAt || t.updatedAt);
      if (!Number.isNaN(at) && nowMs - at <= DONE_DAYS * DAY_MS) out.done.push(t);
      continue;
    }
    if (!t.dueAt) out.none.push(t);
    else {
      const due = Date.parse(t.dueAt);
      if (due < nowMs) out.overdue.push(t);
      else if (due < endOfToday) out.today.push(t);
      else out.upcoming.push(t);
    }
  }
  out.overdue.sort(byDue); out.today.sort(byDue); out.upcoming.sort(byDue);
  out.none.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  out.done.sort((a, b) => Date.parse(b.completedAt || b.updatedAt) - Date.parse(a.completedAt || a.updatedAt));
  return out;
}

/** Is the task currently snoozed? */
export const isSnoozed = (t, nowMs) => !!t.snoozedUntil && Date.parse(t.snoozedUntil) > nowMs && t.status !== 'done';

/** "2/5" progress hint for a checklist, or null. */
export function checklistProgress(t) {
  const n = (t.checklist || []).length;
  return n === 0 ? null : { done: t.checklist.filter((c) => c.done).length, total: n };
}

// ---------- outbox ----------
// Entries (ordered by seq):
//   { seq, taskId, kind: 'put', body, baseVersion, isCreate }   PUT /api/app/tasks/:id   (body without baseVersion)
//   { seq, taskId, kind: 'action', action, minutes? }           POST /api/app/tasks/:id/<action>
//   { seq, taskId, kind: 'delete' }                             DELETE /api/app/tasks/:id

const lastFor = (outbox, taskId) => {
  for (let i = outbox.length - 1; i >= 0; i--) if (outbox[i].taskId === taskId) return i;
  return -1;
};

/**
 * Returns a new outbox with `op` added. `op` is { taskId, kind, ... } without seq.
 * Compaction (never changes what the server ends up with):
 *  - a put merges into the task's last queued entry when that is a put (one PUT, the first baseVersion kept);
 *  - snooze/unsnooze after snooze/unsnooze replaces it;
 *  - a delete removes the task's earlier entries, except an unconfirmed create (kept so a lost response can never leave a ghost task).
 */
export function enqueue(outbox, op) {
  const seq = outbox.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
  const i = lastFor(outbox, op.taskId);
  const last = i >= 0 ? outbox[i] : null;
  if (op.kind === 'put') {
    if (last && last.kind === 'put') {
      return outbox.map((e, k) => (k === i ? { ...e, body: op.body } : e));
    }
    return [...outbox, { seq, taskId: op.taskId, kind: 'put', body: op.body, baseVersion: op.baseVersion ?? null, isCreate: !!op.isCreate }];
  }
  if (op.kind === 'action') {
    const entry = { seq, taskId: op.taskId, kind: 'action', action: op.action, ...(op.minutes !== undefined && { minutes: op.minutes }) };
    const isSnoozeish = (a) => a === 'snooze' || a === 'unsnooze';
    if (last && last.kind === 'action' && isSnoozeish(last.action) && isSnoozeish(op.action)) {
      return outbox.map((e, k) => (k === i ? { ...entry, seq: e.seq } : e));
    }
    if (last && last.kind === 'action' && last.action === op.action && op.action !== 'snooze') return outbox;
    return [...outbox, entry];
  }
  if (op.kind === 'delete') {
    const kept = outbox.filter((e) => e.taskId !== op.taskId || (e.kind === 'put' && e.isCreate));
    return [...kept, { seq, taskId: op.taskId, kind: 'delete' }];
  }
  throw new Error(`unknown outbox op: ${op.kind}`);
}

/** Drops every queued entry of a task. */
export const dropTask = (outbox, taskId) => outbox.filter((e) => e.taskId !== taskId);

/** Per-entry persistence: what to put and which seqs to delete to turn `prev` into `next`. */
export function diffOutbox(prev, next) {
  const before = new Map(prev.map((e) => [e.seq, JSON.stringify(e)]));
  const after = new Set(next.map((e) => e.seq));
  return {
    put: next.filter((e) => before.get(e.seq) !== JSON.stringify(e)),
    remove: prev.filter((e) => !after.has(e.seq)).map((e) => e.seq),
  };
}

/** The outbox as re-read from storage merged with the in-memory one: union by seq, memory wins, ordered by seq. */
export function mergeOutbox(stored, memory) {
  const bySeq = new Map(stored.map((e) => [e.seq, e]));
  for (const e of memory) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export const pendingTaskIds = (outbox) => new Set(outbox.map((e) => e.taskId));

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const EDITABLE = ['title', 'notes', 'status', 'priority', 'dueAt', 'checklist'];

/** True when a server copy already holds what a queued put wanted (a retry whose first attempt had succeeded). */
export function putAlreadyApplied(body, server) {
  return EDITABLE.every((k) => body[k] === undefined || sameJson(body[k], server[k] === undefined ? null : server[k]));
}

/** The HTTP request for an entry. `baseVersion` is the possibly rebased one. */
export function requestFor(entry, baseVersion) {
  const id = encodeURIComponent(entry.taskId);
  if (entry.kind === 'put') {
    return { method: 'PUT', path: `/api/app/tasks/${id}`, body: baseVersion ? { ...entry.body, baseVersion } : { ...entry.body } };
  }
  if (entry.kind === 'action') {
    return { method: 'POST', path: `/api/app/tasks/${id}/${entry.action}`, body: entry.action === 'snooze' ? { minutes: entry.minutes } : {} };
  }
  return { method: 'DELETE', path: `/api/app/tasks/${id}`, body: undefined };
}

/**
 * Pushes the outbox in order through `send(request) -> { status, body }` (it throws on a network failure).
 * Per entry:
 *   2xx  applied; later puts of that task are rebased onto the returned version
 *   409  the server copy wins: the task's remaining entries are dropped and reported as a conflict.
 *        Exceptions: a put the server copy already contains counts as applied, and a replayed create whose server copy
 *        is still version 1 (unchanged since we created it) is retried on that version
 *   401  stop, keep everything (sign in again)
 *   network error, 429, 5xx  stop, keep everything (retry later)
 *   other 4xx  the entry can never succeed: the task's entries are dropped and reported as rejected
 * Returns { remaining, applied: [{taskId, kind, task}], conflicts: [{taskId, task}], rejected: [{taskId, status, error}], state }
 * with state 'ok' | 'offline' | 'unauthorized' | 'retry'.
 */
export async function pushOutbox(outbox, send) {
  let queue = outbox.slice();
  const applied = [];
  const conflicts = [];
  const rejected = [];
  const versions = new Map(); // taskId -> version after our own last successful write
  let state = 'ok';

  while (queue.length > 0) {
    const entry = queue[0];
    let baseVersion = entry.baseVersion;
    if (entry.kind === 'put' && versions.has(entry.taskId)) baseVersion = versions.get(entry.taskId);
    let res;
    try {
      res = await send(requestFor(entry, baseVersion));
      if (res.status === 409 && entry.kind === 'put' && entry.isCreate && res.body && res.body.task
        && res.body.task.version === 1 && !putAlreadyApplied(entry.body, res.body.task)) {
        // Replayed create (the first response was lost): the server copy is still exactly as created (version 1), so
        // nobody else has changed it and it is safe to rebase onto it. Any later version is someone else's edit: a normal conflict.
        res = await send(requestFor(entry, 1));
      }
    } catch {
      state = 'offline';
      break;
    }
    const { status } = res;
    if (status >= 200 && status < 300) {
      applied.push({ taskId: entry.taskId, kind: entry.kind, task: res.body });
      if (res.body && typeof res.body.version === 'number') versions.set(entry.taskId, res.body.version);
      queue = queue.slice(1);
    } else if (status === 409) {
      const task = res.body && res.body.task;
      if (entry.kind === 'put' && task && putAlreadyApplied(entry.body, task)) {
        applied.push({ taskId: entry.taskId, kind: entry.kind, task });
        versions.set(entry.taskId, task.version);
        queue = queue.slice(1);
      } else {
        conflicts.push({ taskId: entry.taskId, task: task || null });
        queue = dropTask(queue, entry.taskId);
      }
    } else if (status === 401) {
      state = 'unauthorized';
      break;
    } else if (status === 429 || status >= 500) {
      state = 'retry';
      break;
    } else if (entry.kind === 'delete' && status === 404) {
      applied.push({ taskId: entry.taskId, kind: 'delete', task: null }); // already gone
      queue = queue.slice(1);
    } else {
      rejected.push({ taskId: entry.taskId, status, error: (res.body && res.body.error) || `HTTP ${status}` });
      queue = dropTask(queue, entry.taskId);
    }
  }
  return { remaining: queue, applied, conflicts, rejected, state };
}

/**
 * The outbox after a push, taking into account edits made while the push was in flight.
 * `snapshot` is what was pushed, `remaining` what the push left, `current` the live outbox, `results` the push result.
 *  - entries of tasks that hit a conflict or rejection are dropped (the server copy replaces the task)
 *  - a snapshot entry that was applied is dropped, unless it was edited meanwhile (then it stays, rebased)
 *  - entries queued meanwhile stay, rebased onto the version our own push produced
 */
export function reconcileOutbox(snapshot, remaining, current, results) {
  const dropped = new Set([...results.conflicts.map((c) => c.taskId), ...results.rejected.map((r) => r.taskId)]);
  const versions = new Map();
  for (const a of results.applied) if (a.task && typeof a.task.version === 'number') versions.set(a.taskId, a.task.version);
  const snap = new Map(snapshot.map((e) => [e.seq, e]));
  const left = new Set(remaining.map((e) => e.seq));
  const out = [];
  for (const e of current) {
    if (dropped.has(e.taskId)) continue;
    const was = snap.get(e.seq);
    if (was && left.has(e.seq)) { // not pushed: later puts of a task whose version our own writes already moved are rebased
      out.push(e.kind === 'put' && versions.has(e.taskId) ? { ...e, baseVersion: versions.get(e.taskId), isCreate: false } : e);
      continue;
    }
    if (was && JSON.stringify(was) === JSON.stringify(e)) continue; // pushed as is
    // edited or queued while the push was running
    if (e.kind === 'put' && versions.has(e.taskId)) out.push({ ...e, baseVersion: versions.get(e.taskId), isCreate: false });
    else out.push(e);
  }
  return out;
}

// ---------- merging server state ----------

/**
 * What to write locally after a successful push of one entry. A task that still has queued edits keeps its local fields
 * (only the version moves on); otherwise the server copy replaces it. Returns { put } or { remove } (a task id).
 */
export function applyPushed(item, local, stillPending) {
  if (item.kind === 'delete' || (item.task && item.task.deleted)) return { remove: item.taskId };
  if (!item.task) return {};
  if (stillPending && local) return { put: { ...local, version: item.task.version } };
  return { put: item.task };
}

/**
 * Merges a pull into the local tasks. `pulled` is the server's list: with `full` it is every visible non-deleted task
 * (local tasks missing from it are removed); otherwise only what changed since lastSync, soft-deleted included.
 * Tasks with queued local edits are left alone (they are pushed first and a conflict is detected there).
 * Returns { put: [task], remove: [id] }.
 */
export function mergePull(localTasks, pulled, { pendingIds = new Set(), full = false } = {}) {
  const put = [];
  const remove = [];
  const seen = new Set();
  for (const t of pulled) {
    seen.add(t.id);
    if (t.deleted) { remove.push(t.id); continue; }
    if (pendingIds.has(t.id)) continue;
    put.push(t);
  }
  if (full) {
    for (const t of localTasks) {
      if (!seen.has(t.id) && !pendingIds.has(t.id)) remove.push(t.id);
    }
  }
  return { put, remove };
}

/** Ids of cached tasks whose owner is no longer visible to this user. */
export function pruneInvisible(tasks, owners) {
  const visible = new Set(owners.map((o) => o.id));
  return tasks.filter((t) => !visible.has(t.ownerPersonId)).map((t) => t.id);
}

/** Owner ids in `owners` that were not in `previous`: their tasks have never been pulled and need a full pull. */
export function newOwnerIds(previous, owners) {
  const had = new Set(previous.map((o) => o.id));
  return owners.filter((o) => !had.has(o.id)).map((o) => o.id);
}

// ---------- toasts ----------

/**
 * Which existing toasts a new one replaces. Kinds: 'passive' (plain info/errors), 'undo' (has an action, times out) and
 * 'sticky' (has an action, stays until tapped: the "New version available" prompt).
 * Passive toasts replace only passive ones; an Undo may also replace an older Undo; a sticky prompt only an older sticky one.
 * Toasts with an action are never removed by a passive toast.
 */
export function toastReplaces(newKind, existingKind) {
  if (newKind === 'passive') return existingKind === 'passive';
  if (newKind === 'undo') return existingKind === 'passive' || existingKind === 'undo';
  return existingKind === 'passive' || existingKind === 'sticky';
}

// ---------- local edits (optimistic) ----------

/** A new local task (version 0 = not on the server yet). */
export function newTask({ id, ownerPersonId, title, dueAt = null, priority = 'medium', notes = '', createdBy = '' }, nowIso) {
  return {
    id, ownerPersonId, title, notes: String(notes || '').slice(0, 10_000), status: 'todo', priority, dueAt, checklist: [], snoozedUntil: null,
    completedAt: null, lastNotifiedAt: null, createdBy, createdAt: nowIso, updatedAt: nowIso, version: 0, deleted: false,
  };
}

/** The PUT body (without baseVersion) for a task's editable fields. */
export function putBody(t) {
  return {
    ownerPersonId: t.ownerPersonId, title: t.title, notes: t.notes, status: t.status, priority: t.priority,
    dueAt: t.dueAt, checklist: t.checklist,
  };
}

/** Local effect of an action (what the server will do), for instant UI. */
export function applyActionLocal(t, action, nowIso, minutes) {
  switch (action) {
    case 'done': return t.status === 'done' ? t : { ...t, status: 'done', completedAt: nowIso, updatedAt: nowIso };
    case 'reopen': return t.status !== 'done' ? t : { ...t, status: 'todo', completedAt: null, updatedAt: nowIso };
    case 'snooze': return t.status === 'done' ? t : { ...t, snoozedUntil: new Date(Date.parse(nowIso) + minutes * 60_000).toISOString(), updatedAt: nowIso };
    case 'unsnooze': return { ...t, snoozedUntil: null, updatedAt: nowIso };
    default: return t;
  }
}

// ---------- calendar ----------

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The IST calendar day of an instant: "2026-11-17". */
export function dayKey(ms) {
  const p = istParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Start of an IST day key as epoch ms (midnight IST). */
export function dayKeyStart(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d) - IST_OFFSET_MS;
}

/** "Tue, 17 Nov" for a day key. */
export function fmtDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${d} ${MONTHS[m - 1]}`;
}

/**
 * A month grid (weeks start on Sunday), in IST. Each cell: { key, day, inMonth, today, past, open, overdue, done }
 * where open/overdue/done count the non-deleted tasks due that day. `month` is 1..12.
 */
export function calendarMonth(year, month, tasks, nowMs) {
  const counts = new Map();
  for (const t of tasks) {
    if (t.deleted || !t.dueAt) continue;
    const ms = Date.parse(t.dueAt);
    if (Number.isNaN(ms)) continue;
    const k = dayKey(ms);
    const c = counts.get(k) || { open: 0, overdue: 0, done: 0 };
    if (t.status === 'done') c.done++;
    else if (ms < nowMs) c.overdue++;
    else c.open++;
    counts.set(k, c);
  }
  const todayKey = dayKey(nowMs);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = first.getUTCDay();
  const total = Math.ceil((lead + daysInMonth) / 7) * 7;
  const weeks = [];
  for (let i = 0; i < total; i++) {
    const d = new Date(Date.UTC(year, month - 1, 1 - lead + i));
    const key = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const c = counts.get(key) || { open: 0, overdue: 0, done: 0 };
    if (i % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1].push({ key, day: d.getUTCDate(), inMonth: d.getUTCMonth() === month - 1, today: key === todayKey, past: key < todayKey, ...c });
  }
  return { label: `${MONTH_NAMES[month - 1]} ${year}`, weeks };
}

/** Tasks due on an IST day: open ones first (by due time), then done ones. Deleted tasks never show. */
export function tasksOnDay(tasks, key) {
  return tasks.filter((t) => !t.deleted && t.dueAt && dayKey(Date.parse(t.dueAt)) === key)
    .sort((a, b) => (a.status === 'done') - (b.status === 'done') || byDue(a, b));
}

/** The month after / before (month 1..12). */
export const shiftMonth = (year, month, d) => {
  const i = year * 12 + (month - 1) + d;
  return { year: Math.floor(i / 12), month: (i % 12) + 1 };
};
