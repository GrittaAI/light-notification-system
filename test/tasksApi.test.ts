import { beforeAll, describe, expect, it } from 'vitest';
import { setupNudge, uuid } from './helpers/nudge.js';

beforeAll(() => { process.env.LOG_LEVEL = 'error'; });

async function twoUsers() {
  const t = await setupNudge();
  const ann = t.person('ann@example.com');
  const bob = t.person('bob@example.com');
  const annC = await t.loginWithCode('ann@example.com');
  const bobC = await t.loginWithCode('bob@example.com');
  const put = (cookie: string, id: string, body: object) => t.request('PUT', `/api/app/tasks/${id}`, { cookie, body });
  const act = (cookie: string, id: string, a: string, body: object = {}) => t.request('POST', `/api/app/tasks/${id}/${a}`, { cookie, body });
  const armed = (id: string) => (t.db.prepare(`SELECT first_alert_sent_at a FROM tasks WHERE id = ?`).get(id) as { a: string | null }).a;
  const markAlerted = (id: string) => t.db.prepare(`UPDATE tasks SET first_alert_sent_at = 'x' WHERE id = ?`).run(id);
  return { t, ann, bob, annC, bobC, put, act, armed, markAlerted };
}

describe('tasks API: create and update', () => {
  it('creates with a client UUID for the actor by default and rejects bad ids and bad fields', async () => {
    const { t, ann, annC, put } = await twoUsers();
    const id = uuid();
    const r = await put(annC, id, { title: '  Call Ravi  ', notes: 'n', priority: 'high', dueAt: '2026-11-16T05:00:00+00:00', checklist: [{ id: 'a', text: 'x', done: false }] });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ id, ownerPersonId: ann.id, title: 'Call Ravi', status: 'todo', priority: 'high', dueAt: '2026-11-16T05:00:00.000Z', version: 1, deleted: false, createdBy: 'ann@example.com' });
    expect(r.json.firstAlertSentAt).toBeUndefined();
    expect((await put(annC, 'not-a-uuid', { title: 'x' })).status).toBe(400);
    expect((await put(annC, '00000000-0000-1000-8000-000000000001', { title: 'x' })).status).toBe(400); // not v4
    for (const bad of [{ title: '' }, { title: 'x'.repeat(201) }, { title: 'x', notes: 'n'.repeat(10_001) }, { title: 'x', status: 'nope' },
      { title: 'x', priority: 'asap' }, { title: 'x', dueAt: 'soon' }, { title: 'x', checklist: Array.from({ length: 101 }, (_, i) => ({ id: String(i), text: 'a', done: false })) },
      { title: 'x', checklist: [{ id: 'a', text: 'y'.repeat(301), done: false }] }]) {
      expect((await put(annC, uuid(), bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
    expect(t.db.prepare(`SELECT COUNT(*) n FROM tasks`).get()).toEqual({ n: 1 });
  });

  it('updates with the correct baseVersion (version increments) and returns 409 + server copy when stale', async () => {
    const { annC, put } = await twoUsers();
    const id = uuid();
    await put(annC, id, { title: 'v1' });
    const u = await put(annC, id, { title: 'v2', baseVersion: 1 });
    expect(u.status).toBe(200);
    expect(u.json).toMatchObject({ title: 'v2', version: 2 });
    const stale = await put(annC, id, { title: 'stale', baseVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ error: 'conflict', task: { id, title: 'v2', version: 2 } });
    // no baseVersion for an existing task is also a conflict (a replayed create)
    expect((await put(annC, id, { title: 'again' })).status).toBe(409);
    expect((await put(annC, id, { title: 'v3', baseVersion: 2 })).json.version).toBe(3);
  });

  it('moving a task needs edit access to both the old and the new owner', async () => {
    const { t, ann, bob, annC, bobC, put } = await twoUsers();
    const id = uuid();
    await put(annC, id, { title: 'mine' });
    expect((await put(annC, id, { title: 'mine', baseVersion: 1, ownerPersonId: bob.id })).status).toBe(403);
    expect((await put(annC, uuid(), { title: 'for bob', ownerPersonId: bob.id })).status).toBe(403);
    expect((await put(annC, uuid(), { title: 'x', ownerPersonId: 9999 })).status).toBe(400);
    // bob may edit ann's list, but cannot move ann's task into a list he cannot edit... ann can edit bob's after a grant
    t.db.prepare(`INSERT INTO access_grants (grantee_person_id, owner_person_id, level, created_by, created_at) VALUES (?, ?, 'edit', 'x', 't')`).run(ann.id, bob.id);
    const moved = await put(annC, id, { title: 'mine', baseVersion: 1, ownerPersonId: bob.id });
    expect(moved.status).toBe(200);
    expect(moved.json.ownerPersonId).toBe(bob.id);
    // ann lost nothing: she still has edit on bob's list; but a view grant is not enough to move IN
    t.db.prepare(`UPDATE access_grants SET level = 'view'`).run();
    expect((await put(annC, uuid(), { title: 'x', ownerPersonId: bob.id })).status).toBe(403);
    // bob (the owner now) can edit
    expect((await put(bobC, id, { title: 'bob edits', baseVersion: 2 })).status).toBe(200);
    // ann (view grant only) cannot move it back
    expect((await put(annC, id, { title: 'x', baseVersion: 3, ownerPersonId: ann.id })).status).toBe(403);
  });

  it('a task of someone with no grant is invisible: 404 on reads and writes', async () => {
    const { annC, bobC, put, act } = await twoUsers();
    const id = uuid();
    await put(annC, id, { title: 'private' });
    expect((await put(bobC, id, { title: 'hijack', baseVersion: 1 })).status).toBe(404);
    expect((await act(bobC, id, 'done')).status).toBe(404);
  });
});

describe('tasks API: sync pull', () => {
  it('without since returns non-deleted tasks of visible owners; with since returns changes incl. soft-deleted, plus serverTime', async () => {
    const { t, annC, bobC, put } = await twoUsers();
    const a = uuid(); const b = uuid(); const c = uuid();
    await put(annC, a, { title: 'a' });
    await put(annC, b, { title: 'b' });
    await put(bobC, c, { title: 'bob' });
    t.advance(60_000);
    const checkpoint = (await t.request('GET', '/api/app/tasks', { cookie: annC })).json.serverTime as string;
    t.advance(60_000);
    await t.request('DELETE', `/api/app/tasks/${b}`, { cookie: annC });
    await put(annC, a, { title: 'a2', baseVersion: 1 });

    const all = await t.request('GET', '/api/app/tasks', { cookie: annC });
    expect(all.json.tasks.map((x: any) => x.title).sort()).toEqual(['a2']); // b is deleted, bob's task is not visible
    expect(all.json.serverTime).toBe(t.now().toISOString());

    const since = await t.request('GET', `/api/app/tasks?since=${encodeURIComponent(checkpoint)}`, { cookie: annC });
    expect(since.status).toBe(200);
    const byId = Object.fromEntries(since.json.tasks.map((x: any) => [x.id, x]));
    expect(Object.keys(byId).sort()).toEqual([a, b].sort());
    expect(byId[b]).toMatchObject({ deleted: true, version: 2 });
    expect(byId[a]).toMatchObject({ deleted: false, title: 'a2' });
    expect((await t.request('GET', '/api/app/tasks?since=garbage', { cookie: annC })).status).toBe(400);
    expect((await t.request('GET', `/api/app/tasks?owner=${(await t.request('GET', '/api/me', { cookie: bobC })).json.personId}`, { cookie: annC })).status).toBe(403);
  });

  it('GET /api/app/owners lists the actor first', async () => {
    const { t, ann, bob, annC } = await twoUsers();
    t.db.prepare(`INSERT INTO access_grants (grantee_person_id, owner_person_id, level, created_by, created_at) VALUES (?, ?, 'view', 'x', 't')`).run(ann.id, bob.id);
    expect((await t.request('GET', '/api/app/owners', { cookie: annC })).json).toEqual([
      { id: ann.id, name: 'ann', level: 'edit' }, { id: bob.id, name: 'bob', level: 'view' },
    ]);
  });

  it('requires a session', async () => {
    const t = await setupNudge();
    expect((await t.request('GET', '/api/app/tasks')).status).toBe(401);
  });
});

describe('tasks API: actions', () => {
  it('done and reopen are idempotent and set/clear completed_at', async () => {
    const { annC, put, act } = await twoUsers();
    const id = uuid();
    await put(annC, id, { title: 'x', dueAt: '2026-11-16T05:00:00Z' });
    const d1 = await act(annC, id, 'done');
    expect(d1.json).toMatchObject({ status: 'done', version: 2 });
    expect(d1.json.completedAt).toBeTruthy();
    const d2 = await act(annC, id, 'done');
    expect(d2.json).toMatchObject({ status: 'done', version: 2, completedAt: d1.json.completedAt });
    const r1 = await act(annC, id, 'reopen');
    expect(r1.json).toMatchObject({ status: 'todo', completedAt: null, version: 3 });
    expect((await act(annC, id, 'reopen')).json.version).toBe(3);
  });

  it('snooze (15..10080) and unsnooze are idempotent; delete is a soft delete that bumps the version', async () => {
    const { t, annC, put, act } = await twoUsers();
    const id = uuid();
    await put(annC, id, { title: 'x', dueAt: '2026-11-16T05:00:00Z' });
    for (const bad of [14, 10_081, 1.5, 'x', undefined]) {
      expect((await act(annC, id, 'snooze', { minutes: bad })).status, String(bad)).toBe(400);
    }
    const s = await act(annC, id, 'snooze', { minutes: 60 });
    expect(s.json.snoozedUntil).toBe(new Date(t.now().getTime() + 3600_000).toISOString());
    expect((await act(annC, id, 'unsnooze')).json.snoozedUntil).toBeNull();
    const v = (await act(annC, id, 'unsnooze')).json.version;
    expect((await act(annC, id, 'unsnooze')).json.version).toBe(v);
    const del = await t.request('DELETE', `/api/app/tasks/${id}`, { cookie: annC });
    expect(del.json).toMatchObject({ deleted: true, version: v + 1 });
    expect((await t.request('DELETE', `/api/app/tasks/${id}`, { cookie: annC })).json.version).toBe(v + 1);
    expect((await act(annC, id, 'done')).status).toBe(404); // deleted tasks accept no actions
  });

  it('actions need edit access (403 for a viewer)', async () => {
    const { t, ann, bob, annC, bobC, put, act } = await twoUsers();
    const id = uuid();
    await put(bobC, id, { title: 'bob' });
    t.db.prepare(`INSERT INTO access_grants (grantee_person_id, owner_person_id, level, created_by, created_at) VALUES (?, ?, 'view', 'x', 't')`).run(ann.id, bob.id);
    expect((await act(annC, id, 'done')).status).toBe(403);
    expect((await t.request('DELETE', `/api/app/tasks/${id}`, { cookie: annC })).status).toBe(403);
    expect((await t.request('GET', `/api/app/tasks/${id}/activity`, { cookie: annC })).status).toBe(200);
    void bob;
  });
});

describe('tasks API: re-arming (first_alert_sent_at)', () => {
  it('is NULL on create and re-armed by due_at change, snooze, unsnooze, reopen and undelete, but not by other edits', async () => {
    const { annC, put, act, armed, markAlerted } = await twoUsers();
    const id = uuid();
    await put(annC, id, { title: 'x', dueAt: '2026-11-16T05:00:00Z' });
    expect(armed(id)).toBeNull();

    markAlerted(id);
    await put(annC, id, { title: 'renamed', priority: 'low', notes: 'n', baseVersion: 1 });
    expect(armed(id)).toBe('x'); // unrelated edit keeps it
    await put(annC, id, { title: 'renamed', dueAt: '2026-11-16T05:00:00Z', baseVersion: 2 });
    expect(armed(id)).toBe('x'); // same due_at (different spelling would also normalise equal)
    await put(annC, id, { title: 'renamed', dueAt: '2026-11-16T06:00:00Z', baseVersion: 3 });
    expect(armed(id)).toBeNull(); // due_at changed

    markAlerted(id);
    await act(annC, id, 'snooze', { minutes: 30 });
    expect(armed(id)).toBeNull();
    markAlerted(id);
    await act(annC, id, 'unsnooze');
    expect(armed(id)).toBeNull();

    await act(annC, id, 'done');
    markAlerted(id);
    await act(annC, id, 'reopen');
    expect(armed(id)).toBeNull();
  });

  it('undelete via PUT {deleted:false} re-arms; a PUT on a deleted task without it is a conflict', async () => {
    const { t, annC, put, armed, markAlerted } = await twoUsers();
    const id = uuid();
    await put(annC, id, { title: 'x', dueAt: '2026-11-16T05:00:00Z' });
    markAlerted(id);
    await t.request('DELETE', `/api/app/tasks/${id}`, { cookie: annC });
    expect(armed(id)).toBe('x');
    const blind = await put(annC, id, { title: 'x', baseVersion: 2 });
    expect(blind.status).toBe(409);
    expect(blind.json.task.deleted).toBe(true);
    const back = await put(annC, id, { title: 'x', baseVersion: 2, deleted: false });
    expect(back.status).toBe(200);
    expect(back.json.deleted).toBe(false);
    expect(armed(id)).toBeNull();
  });

  it('marking done through PUT status behaves like the done action; reopening through PUT re-arms', async () => {
    const { annC, put, armed, markAlerted } = await twoUsers();
    const id = uuid();
    await put(annC, id, { title: 'x', dueAt: '2026-11-16T05:00:00Z' });
    const done = await put(annC, id, { title: 'x', status: 'done', baseVersion: 1 });
    expect(done.json.completedAt).toBeTruthy();
    markAlerted(id);
    const re = await put(annC, id, { title: 'x', status: 'in_progress', baseVersion: 2 });
    expect(re.json).toMatchObject({ status: 'in_progress', completedAt: null });
    expect(armed(id)).toBeNull();
  });
});

describe('tasks API: activity', () => {
  it('records the actor and the changed fields for every change, never secrets', async () => {
    const { t, ann, bob, annC, bobC, put, act } = await twoUsers();
    t.db.prepare(`INSERT INTO access_grants (grantee_person_id, owner_person_id, level, created_by, created_at) VALUES (?, ?, 'edit', 'x', 't')`).run(bob.id, ann.id);
    const id = uuid();
    await put(annC, id, { title: 'x', dueAt: '2026-11-16T05:00:00Z' });
    await put(bobC, id, { title: 'x2', priority: 'urgent', baseVersion: 1 });
    await act(annC, id, 'snooze', { minutes: 30 });
    await act(annC, id, 'done');
    await t.request('DELETE', `/api/app/tasks/${id}`, { cookie: annC });
    const r = await t.request('GET', `/api/app/tasks/${id}/activity`, { cookie: annC });
    expect(r.status).toBe(200);
    const rows = r.json as { action: string; actor: string; details: { fields: string[]; changes: any } }[];
    expect(rows.map((x) => x.action)).toEqual(['delete', 'done', 'snooze', 'update', 'create']);
    expect(rows.map((x) => x.actor)).toEqual(['ann@example.com', 'ann@example.com', 'ann@example.com', 'bob@example.com', 'ann@example.com']);
    expect(rows[3]!.details.fields.sort()).toEqual(['priority', 'title']);
    expect(rows[3]!.details.changes.priority).toEqual({ from: 'medium', to: 'urgent' });
    expect(rows[2]!.details.fields).toEqual(['snoozedUntil']);
    expect(JSON.stringify(rows)).not.toMatch(/token|secret|password|cookie/i);
    expect((await t.request('GET', `/api/app/tasks/${id}/activity`, { cookie: bobC })).status).toBe(200);
  });
});

describe('task settings API', () => {
  it('has defaults, validates, merges partial updates and audits', async () => {
    const t = await setupNudge();
    const cookie = await t.loginSuper();
    const d = await t.request('GET', '/api/task-settings', { cookie });
    expect(d.json).toEqual({ leadMinutes: 10, repeatMinutes: 10, mergeAheadMinutes: 5, defaultGroupId: null, quietHours: { enabled: false, start: '21:00', end: '09:00' } });
    for (const bad of [{ leadMinutes: 0 }, { leadMinutes: 1441 }, { repeatMinutes: 4 }, { mergeAheadMinutes: 16 }, { mergeAheadMinutes: -1 }, { mergeAheadMinutes: 2.5 }, { defaultGroupId: 'abc' }, { quietHours: { enabled: true, start: '9:00', end: '10:00' } },
      { quietHours: { enabled: true, start: '10:00', end: '10:00' } }, { leadMinutes: 1.5 }]) {
      expect((await t.request('PUT', '/api/task-settings', { cookie, body: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    const ok = await t.request('PUT', '/api/task-settings', { cookie, body: { repeatMinutes: 15, defaultGroupId: '120363000000000009@g.us' } });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ leadMinutes: 10, repeatMinutes: 15, defaultGroupId: '120363000000000009@g.us' });
    expect((await t.request('GET', '/api/task-settings', { cookie })).json.repeatMinutes).toBe(15);
    const m = await t.request('PUT', '/api/task-settings', { cookie, body: { mergeAheadMinutes: 0 } });
    expect(m.json.mergeAheadMinutes).toBe(0);
    expect((await t.request('PUT', '/api/task-settings', { cookie, body: { mergeAheadMinutes: 15 } })).status).toBe(200);
    expect(t.db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action = 'task_settings_update'`).get()).toEqual({ n: 3 });
  });
});
