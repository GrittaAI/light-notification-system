// @ts-nocheck (imports the browser ES module public/nudge/sync-core.js, which is plain JS)
import { describe, expect, it } from 'vitest';
import {
  applyPushed, dueChip, enqueue, groupTasks, istDayStart, istInputToIso, isoToIstInput, mergePull, pruneInvisible, pushOutbox,
  reconcileOutbox, fmtTime, fmtDateTime,
} from '../public/nudge/sync-core.js';

const T = (id: string, extra: Record<string, unknown> = {}) => ({
  id, ownerPersonId: 1, title: id, notes: '', status: 'todo', priority: 'medium', dueAt: null, checklist: [], snoozedUntil: null,
  completedAt: null, createdAt: '2026-11-16T00:00:00.000Z', updatedAt: '2026-11-16T00:00:00.000Z', version: 1, deleted: false, ...extra,
});
const body = (title: string) => ({ title, notes: '', status: 'todo', priority: 'medium', dueAt: null, checklist: [] });

describe('IST helpers', () => {
  it('formats in Asia/Kolkata and round-trips datetime-local', () => {
    expect(fmtTime(Date.parse('2026-11-17T11:30:00Z'))).toBe('5:00 PM');
    expect(istInputToIso('2026-11-17T18:00')).toBe('2026-11-17T12:30:00.000Z');
    expect(isoToIstInput('2026-11-17T12:30:00.000Z')).toBe('2026-11-17T18:00');
    const now = Date.parse('2026-11-17T04:00:00Z');
    expect(fmtDateTime(Date.parse('2026-11-18T04:30:00Z'), now)).toBe('Tomorrow 10:00 AM');
    expect(dueChip('2026-11-17T03:35:00Z', now)).toEqual({ text: 'Overdue 25m', overdue: true });
    expect(dueChip('2026-11-17T11:30:00Z', now)).toEqual({ text: '5:00 PM', overdue: false });
  });
});

describe('groupTasks (IST)', () => {
  it('groups into overdue, today, upcoming, none and done', () => {
    const now = Date.parse('2026-11-17T06:00:00Z'); // 11:30 IST
    const g = groupTasks([
      T('over', { dueAt: '2026-11-17T05:00:00Z' }), T('today', { dueAt: '2026-11-17T12:00:00Z' }), T('tom', { dueAt: '2026-11-18T05:00:00Z' }),
      T('none'), T('done', { status: 'done', completedAt: '2026-11-16T10:00:00Z' }),
      T('old', { status: 'done', completedAt: '2026-09-01T10:00:00Z' }), T('gone', { deleted: true }),
    ], now);
    expect(g.overdue.map((t) => t.id)).toEqual(['over']);
    expect(g.today.map((t) => t.id)).toEqual(['today']);
    expect(g.upcoming.map((t) => t.id)).toEqual(['tom']);
    expect(g.none.map((t) => t.id)).toEqual(['none']);
    expect(g.done.map((t) => t.id)).toEqual(['done']);
  });

  it('uses the IST day boundary around midnight (18:30 UTC)', () => {
    const justBefore = Date.parse('2026-11-17T18:29:00Z'); // 23:59 IST on the 17th
    const justAfter = Date.parse('2026-11-17T18:31:00Z'); // 00:01 IST on the 18th
    const due = '2026-11-17T18:45:00Z'; // 00:15 IST on the 18th
    expect(groupTasks([T('x', { dueAt: due })], justBefore).upcoming).toHaveLength(1);
    expect(groupTasks([T('x', { dueAt: due })], justAfter).today).toHaveLength(1);
    expect(istDayStart(justBefore)).toBe(Date.parse('2026-11-16T18:30:00Z'));
    expect(istDayStart(justAfter)).toBe(Date.parse('2026-11-17T18:30:00Z'));
    // 23:50 IST on the 17th is today, not tomorrow, even though the UTC date is also the 17th
    expect(groupTasks([T('y', { dueAt: '2026-11-17T18:20:00Z' })], Date.parse('2026-11-17T10:00:00Z')).today).toHaveLength(1);
  });
});

describe('outbox compaction', () => {
  it('coalesces several edits to one task into one PUT with the first baseVersion', () => {
    let o: any[] = [];
    o = enqueue(o, { taskId: 'a', kind: 'put', body: body('1'), baseVersion: 3 });
    o = enqueue(o, { taskId: 'b', kind: 'put', body: body('b'), baseVersion: 1 });
    o = enqueue(o, { taskId: 'a', kind: 'put', body: body('2'), baseVersion: 3 });
    o = enqueue(o, { taskId: 'a', kind: 'put', body: body('3'), baseVersion: 3 });
    expect(o.map((e) => [e.seq, e.taskId, e.body.title, e.baseVersion])).toEqual([[1, 'a', '3', 3], [2, 'b', 'b', 1]]);
  });

  it('keeps order across actions and does not merge across them', () => {
    let o: any[] = [];
    o = enqueue(o, { taskId: 'a', kind: 'put', body: body('1'), baseVersion: 1 });
    o = enqueue(o, { taskId: 'a', kind: 'action', action: 'done' });
    o = enqueue(o, { taskId: 'a', kind: 'put', body: body('2'), baseVersion: 1 });
    expect(o.map((e) => e.kind)).toEqual(['put', 'action', 'put']);
    o = enqueue(o, { taskId: 'a', kind: 'action', action: 'snooze', minutes: 60 });
    o = enqueue(o, { taskId: 'a', kind: 'action', action: 'snooze', minutes: 120 });
    expect(o.filter((e) => e.action === 'snooze')).toEqual([expect.objectContaining({ minutes: 120 })]);
  });

  it('delete removes earlier entries, except an unconfirmed create', () => {
    let o: any[] = [];
    o = enqueue(o, { taskId: 'a', kind: 'put', body: body('1'), baseVersion: 2 });
    o = enqueue(o, { taskId: 'a', kind: 'action', action: 'done' });
    o = enqueue(o, { taskId: 'a', kind: 'delete' });
    expect(o.map((e) => e.kind)).toEqual(['delete']);
    let c: any[] = enqueue([], { taskId: 'n', kind: 'put', body: body('n'), baseVersion: null, isCreate: true });
    c = enqueue(c, { taskId: 'n', kind: 'delete' });
    expect(c.map((e) => e.kind)).toEqual(['put', 'delete']);
  });
});

const ok = (task: object) => ({ status: 200, body: task });

describe('pushOutbox', () => {
  it('pushes in order, rebasing later puts of a task onto our own new version', async () => {
    let o: any[] = [];
    o = enqueue(o, { taskId: 'a', kind: 'put', body: body('1'), baseVersion: 1 });
    o = enqueue(o, { taskId: 'a', kind: 'action', action: 'done' });
    o = enqueue(o, { taskId: 'a', kind: 'put', body: body('2'), baseVersion: 1 });
    const seen: any[] = [];
    let v = 1;
    const r = await pushOutbox(o, async (req: any) => { seen.push(req); v += 1; return ok(T('a', { version: v })); });
    expect(seen.map((s) => s.method + ' ' + s.path)).toEqual(['PUT /api/app/tasks/a', 'POST /api/app/tasks/a/done', 'PUT /api/app/tasks/a']);
    expect(seen[0].body.baseVersion).toBe(1);
    expect(seen[2].body.baseVersion).toBe(3);
    expect(r.state).toBe('ok');
    expect(r.remaining).toEqual([]);
  });

  it('409: takes the server copy, drops that task\'s other queued edits, and continues with other tasks', async () => {
    let o: any[] = [];
    o = enqueue(o, { taskId: 'a', kind: 'put', body: body('mine'), baseVersion: 1 });
    o = enqueue(o, { taskId: 'a', kind: 'action', action: 'done' });
    o = enqueue(o, { taskId: 'b', kind: 'put', body: body('b'), baseVersion: 1 });
    const server = T('a', { title: 'theirs', version: 5 });
    const calls: string[] = [];
    const r = await pushOutbox(o, async (req: any) => {
      calls.push(req.method + req.path);
      return req.path.endsWith('/a') ? { status: 409, body: { error: 'conflict', task: server } } : ok(T('b', { version: 2 }));
    });
    expect(calls).toEqual(['PUT/api/app/tasks/a', 'PUT/api/app/tasks/b']);
    expect(r.conflicts).toEqual([{ taskId: 'a', task: server }]);
    expect(r.remaining).toEqual([]);
    expect(r.applied.map((a: any) => a.taskId)).toEqual(['b']);
  });

  it('409 on a replayed create rebases onto the server version instead of losing the task', async () => {
    const o = enqueue([], { taskId: 'n', kind: 'put', body: body('n'), baseVersion: null, isCreate: true });
    const sent: any[] = [];
    const r = await pushOutbox(o, async (req: any) => {
      sent.push(req.body.baseVersion);
      return req.body.baseVersion ? ok(T('n', { version: 2 })) : { status: 409, body: { task: T('n', { title: 'older body', version: 1 }) } };
    });
    expect(sent).toEqual([undefined, 1]);
    expect(r.conflicts).toEqual([]);
    expect(r.applied).toHaveLength(1);
  });

  it('a 409 whose server copy already holds our change counts as applied (lost response)', async () => {
    const o = enqueue([], { taskId: 'a', kind: 'put', body: body('same'), baseVersion: 1 });
    const r = await pushOutbox(o, async () => ({ status: 409, body: { task: T('a', { title: 'same', version: 2 }) } }));
    expect(r.conflicts).toEqual([]);
    expect(r.applied).toHaveLength(1);
  });

  it('401 and network errors stop and keep the whole outbox; other 4xx drops only that task', async () => {
    let o: any[] = [];
    o = enqueue(o, { taskId: 'a', kind: 'put', body: body('a'), baseVersion: 1 });
    o = enqueue(o, { taskId: 'b', kind: 'put', body: body('b'), baseVersion: 1 });
    const un = await pushOutbox(o, async () => ({ status: 401, body: { error: 'not signed in' } }));
    expect(un.state).toBe('unauthorized');
    expect(un.remaining).toHaveLength(2);
    const off = await pushOutbox(o, async () => { throw new TypeError('fetch failed'); });
    expect(off.state).toBe('offline');
    expect(off.remaining).toHaveLength(2);
    const srv = await pushOutbox(o, async () => ({ status: 503, body: null }));
    expect(srv.state).toBe('retry');
    expect(srv.remaining).toHaveLength(2);
    const rej = await pushOutbox(o, async (req: any) => (req.path.endsWith('/a') ? { status: 403, body: { error: 'you can only view this list' } } : ok(T('b', { version: 2 }))));
    expect(rej.rejected).toEqual([{ taskId: 'a', status: 403, error: 'you can only view this list' }]);
    expect(rej.remaining).toEqual([]);
  });

  it('a delete of a task that is already gone is fine', async () => {
    const o = enqueue([], { taskId: 'a', kind: 'delete' });
    const r = await pushOutbox(o, async () => ({ status: 404, body: { error: 'not found' } }));
    expect(r.state).toBe('ok');
    expect(r.remaining).toEqual([]);
  });
});

describe('reconcileOutbox (edits made while a push was running)', () => {
  it('keeps an entry edited meanwhile, rebased on the version our push produced; drops conflicted tasks', () => {
    const e1 = { seq: 1, taskId: 'a', kind: 'put', body: body('old'), baseVersion: 1, isCreate: false };
    const snapshot = [e1, { seq: 2, taskId: 'c', kind: 'put', body: body('c'), baseVersion: 1, isCreate: false }];
    const current = [
      { ...e1, body: body('newer') },
      snapshot[1],
      { seq: 3, taskId: 'c', kind: 'action', action: 'done' },
      { seq: 4, taskId: 'd', kind: 'put', body: body('d'), baseVersion: 1, isCreate: false },
    ];
    const results = { applied: [{ taskId: 'a', task: T('a', { version: 2 }) }], conflicts: [{ taskId: 'c', task: T('c') }], rejected: [] };
    const out = reconcileOutbox(snapshot, [], current, results);
    expect(out.map((e: any) => [e.seq, e.baseVersion])).toEqual([[1, 2], [4, 1]]);
    expect(out[0].body.title).toBe('newer');
  });
});

describe('mergePull and pruning', () => {
  it('upserts by id, removes soft-deleted tasks, leaves tasks with queued edits alone', () => {
    const local = [T('a', { title: 'old' }), T('b'), T('c', { title: 'mine' })];
    const pulled = [T('a', { title: 'new', version: 2 }), T('b', { deleted: true }), T('c', { title: 'server', version: 9 }), T('d')];
    const m = mergePull(local, pulled, { pendingIds: new Set(['c']) });
    expect(m.put.map((t: any) => t.id)).toEqual(['a', 'd']);
    expect(m.remove).toEqual(['b']);
  });

  it('a full pull also removes local tasks the server no longer lists (except pending ones)', () => {
    const m = mergePull([T('a'), T('b'), T('new')], [T('a')], { full: true, pendingIds: new Set(['new']) });
    expect(m.remove).toEqual(['b']);
  });

  it('applyPushed: a task with queued edits keeps its local fields, only the version moves', () => {
    const local = T('a', { title: 'local edit', version: 1 });
    expect(applyPushed({ taskId: 'a', kind: 'put', task: T('a', { title: 'sent', version: 2 }) }, local, true)).toEqual({ put: { ...local, version: 2 } });
    expect(applyPushed({ taskId: 'a', kind: 'delete', task: T('a', { deleted: true }) }, local, false)).toEqual({ remove: 'a' });
  });

  it('prunes cached tasks whose owner is no longer visible', () => {
    const tasks = [T('a', { ownerPersonId: 1 }), T('b', { ownerPersonId: 2 }), T('c', { ownerPersonId: 3 })];
    expect(pruneInvisible(tasks, [{ id: 1 }, { id: 3 }])).toEqual(['b']);
    expect(pruneInvisible(tasks, [])).toEqual(['a', 'b', 'c']);
  });
});

import { diffOutbox, mergeOutbox, newOwnerIds } from '../public/nudge/sync-core.js';

describe('review fixes', () => {
  it('reconcile: leftover puts of a task whose version our own pushed action moved are rebased (no false 409)', async () => {
    let o: any[] = [];
    o = enqueue(o, { taskId: 'a', kind: 'action', action: 'done' });
    o = enqueue(o, { taskId: 'a', kind: 'put', body: body('edit'), baseVersion: 1 });
    let calls = 0;
    const r = await pushOutbox(o, async () => { calls += 1; if (calls === 1) return ok(T('a', { status: 'done', version: 2 })); throw new TypeError('network dropped'); });
    expect(r.state).toBe('offline');
    expect(r.remaining.map((e: any) => e.kind)).toEqual(['put']);
    const after = reconcileOutbox(o, r.remaining, o, r);
    expect(after).toHaveLength(1);
    expect(after[0].baseVersion).toBe(2);
    // retry now succeeds with baseVersion 2
    const sent: number[] = [];
    await pushOutbox(after, async (req: any) => { sent.push(req.body.baseVersion); return ok(T('a', { version: 3 })); });
    expect(sent).toEqual([2]);
  });

  it('replayed create: an admin edit made after a lost-response create survives (conflict, never overwritten)', async () => {
    const o = enqueue([], { taskId: 'n', kind: 'put', body: body('mine'), baseVersion: null, isCreate: true });
    const adminCopy = T('n', { title: 'admin changed it', version: 2 });
    const sent: any[] = [];
    const r = await pushOutbox(o, async (req: any) => { sent.push(req.body.baseVersion); return { status: 409, body: { error: 'conflict', task: adminCopy } }; });
    expect(sent).toEqual([undefined]); // no rebased retry
    expect(r.conflicts).toEqual([{ taskId: 'n', task: adminCopy }]);
    expect(r.applied).toEqual([]);
    expect(r.remaining).toEqual([]);
  });

  it('replayed create: an unchanged server copy (version 1) is rebased; one that already holds our edit counts as applied', async () => {
    const o = enqueue([], { taskId: 'n', kind: 'put', body: body('mine'), baseVersion: null, isCreate: true });
    const sent: any[] = [];
    const r = await pushOutbox(o, async (req: any) => {
      sent.push(req.body.baseVersion);
      return req.body.baseVersion === 1 ? ok(T('n', { title: 'mine', version: 2 })) : { status: 409, body: { task: T('n', { title: 'older body', version: 1 }) } };
    });
    expect(sent).toEqual([undefined, 1]);
    expect(r.applied).toHaveLength(1);
    const same = await pushOutbox(o, async () => ({ status: 409, body: { task: T('n', { title: 'mine', version: 4 }) } }));
    expect(same.conflicts).toEqual([]);
    expect(same.applied).toHaveLength(1);
  });

  it('a newly granted owner is detected so its whole list is pulled (not just changes since lastSync)', () => {
    expect(newOwnerIds([{ id: 1 }, { id: 2 }], [{ id: 1 }, { id: 2 }, { id: 7 }])).toEqual([7]);
    expect(newOwnerIds([], [{ id: 1 }])).toEqual([1]);
    expect(newOwnerIds([{ id: 1 }], [{ id: 1 }])).toEqual([]);
  });

  it('per-entry outbox persistence: only changed entries are put and only missing seqs are deleted; stored entries of another writer survive', () => {
    const e1 = { seq: 1, taskId: 'a', kind: 'put', body: body('1'), baseVersion: 1, isCreate: false };
    const e2 = { seq: 2, taskId: 'b', kind: 'delete' };
    const e3 = { seq: 3, taskId: 'c', kind: 'action', action: 'done' };
    expect(diffOutbox([e1, e2], [e1, e2])).toEqual({ put: [], remove: [] });
    expect(diffOutbox([e1, e2], [{ ...e1, body: body('x') }, e3])).toEqual({ put: [{ ...e1, body: body('x') }, e3], remove: [2] });
    expect(diffOutbox([], [e1])).toEqual({ put: [e1], remove: [] });
    // re-reading storage: another writer's entry is kept, memory wins on a shared seq
    expect(mergeOutbox([e1, e3], [{ ...e1, baseVersion: 5 }, e2]).map((e: any) => [e.seq, e.baseVersion ?? null])).toEqual([[1, 5], [2, null], [3, null]]);
  });
});

import { previewText } from '../public/nudge/admin.js';

describe('admin notification preview', () => {
  it('describes the settings in plain English, in IST', () => {
    const base = { leadMinutes: 10, repeatMinutes: 10, mergeAheadMinutes: 5, quietHours: { enabled: false, start: '21:00', end: '09:00' } };
    expect(previewText(base)).toBe('First nudge 10 min before the due time, then every 10 min until done. Tasks due within 5 min are grouped.');
    expect(previewText({ ...base, mergeAheadMinutes: 0 })).toContain('never grouped');
    expect(previewText({ ...base, quietHours: { enabled: true, start: '22:00', end: '07:00' } })).toContain('no nudges from 10:00 PM to 7:00 AM IST');
  });
});

import { toastReplaces } from '../public/nudge/sync-core.js';

describe('toast replacement rules', () => {
  it('passive toasts never remove an action toast (Undo or the update prompt)', () => {
    expect(toastReplaces('passive', 'passive')).toBe(true);
    expect(toastReplaces('passive', 'undo')).toBe(false);
    expect(toastReplaces('passive', 'sticky')).toBe(false);
  });
  it('a new Undo replaces an older Undo (and passive ones) but not the update prompt; the prompt replaces only passive or an older prompt', () => {
    expect(toastReplaces('undo', 'undo')).toBe(true);
    expect(toastReplaces('undo', 'passive')).toBe(true);
    expect(toastReplaces('undo', 'sticky')).toBe(false);
    expect(toastReplaces('sticky', 'undo')).toBe(false);
    expect(toastReplaces('sticky', 'sticky')).toBe(true);
    expect(toastReplaces('sticky', 'passive')).toBe(true);
  });
});
