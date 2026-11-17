import { beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { createPerson, getPerson, type PersonRow } from '../src/people.js';
import { computeDigests, runTaskNudges } from '../src/tasks/nudges.js';
import { DEFAULT_TASK_SETTINGS, setTaskSettings } from '../src/tasks/settings.js';
import { saveTask, type TaskRow } from '../src/tasks/store.js';
import { T0, setupNudge, uuid } from './helpers/nudge.js';

beforeAll(() => { process.env.LOG_LEVEL = 'error'; });

const MIN = 60_000;
const GROUP = '120363000000000001@g.us';
const OTHER = '120363000000000002@g.us';

async function setup() {
  const wa = {
    async listGroups() { return [{ id: GROUP, name: 'Sales team' }, { id: OTHER, name: 'Ops' }]; },
    async sendGroupMessage() {}, async sendDirectMessage() {},
  };
  const t = await setupNudge({ whatsapp: wa, env: { GOOGLE_OAUTH_CLIENT_ID: undefined } });
  const sup = await t.loginSuper();
  const cur = (await t.request('GET', '/api/task-settings', { cookie: sup })).json;
  await t.request('PUT', '/api/task-settings', { cookie: sup, body: { ...cur, defaultGroupId: GROUP } });
  t.person('adm@example.com', 'admin');
  const admC = await t.loginWithCode('adm@example.com');
  const ann = t.person('ann@example.com', 'member', { whatsapp: '919811111111' });
  const annC = await t.loginWithCode('ann@example.com');
  const bob = t.person('bob@example.com', 'member');
  const bobC = await t.loginWithCode('bob@example.com');
  return { t, sup, admC, ann, annC, bob, bobC };
}

describe('personal notification settings API', () => {
  it('a member reads their settings with the team defaults, and changes timing, quiet hours, number and target', async () => {
    const { t, annC, ann } = await setup();
    const r = await t.request('GET', '/api/app/notify-settings', { cookie: annC });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      person: { id: ann.id, name: expect.any(String) }, canEdit: true,
      prefs: { whatsapp: '919811111111', notifyTarget: 'default', leadMinutes: null, repeatMinutes: null, quietHours: null },
      team: { leadMinutes: 10, repeatMinutes: 10, defaultGroupId: GROUP },
    });
    const put = await t.request('PUT', '/api/app/notify-settings', { cookie: annC, body: {
      whatsapp: '+91 98222 22222', notifyTarget: 'group', notifyGroupId: OTHER,
      leadMinutes: 30, repeatMinutes: 15, quietHours: { enabled: true, start: '22:00', end: '08:00' },
    } });
    expect(put.status).toBe(200);
    expect(put.json.prefs).toEqual({ whatsapp: '919822222222', notifyTarget: 'group', notifyGroupId: OTHER, leadMinutes: 30, repeatMinutes: 15,
      quietHours: { enabled: true, start: '22:00', end: '08:00' } });
    // back to the team default
    const reset = await t.request('PUT', '/api/app/notify-settings', { cookie: annC, body: { leadMinutes: null, repeatMinutes: null, quietHours: null, notifyTarget: 'default' } });
    expect(reset.json.prefs).toMatchObject({ leadMinutes: null, repeatMinutes: null, quietHours: null, notifyTarget: 'default', notifyGroupId: null, whatsapp: '919822222222' });
    const audit = t.db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action = 'person_notify_update'`).get() as { n: number };
    expect(audit.n).toBe(2);
  });

  it('validates every write', async () => {
    const { t, bobC } = await setup();
    const put = (body: unknown) => t.request('PUT', '/api/app/notify-settings', { cookie: bobC, body });
    expect((await put({ notifyTarget: 'dm' })).json.fields).toMatchObject({ whatsapp: expect.any(String) }); // no number yet
    expect((await put({ notifyTarget: 'group' })).json.fields).toMatchObject({ notifyGroupId: expect.any(String) });
    expect((await put({ repeatMinutes: 3 })).status).toBe(400);
    expect((await put({ leadMinutes: 0 })).status).toBe(400);
    expect((await put({ quietHours: { enabled: true, start: '22:00', end: '22:00' } })).status).toBe(400);
    expect((await put({ whatsapp: '12' })).status).toBe(400);
  });

  it('members see only their own; admins can view anyone but not change; the superadmin can change and reset anyone', async () => {
    const { t, sup, admC, ann, annC, bob } = await setup();
    expect((await t.request('GET', `/api/app/notify-settings?person=${bob.id}`, { cookie: annC })).status).toBe(403);
    expect((await t.request('PUT', '/api/app/notify-settings', { cookie: annC, body: { personId: bob.id, repeatMinutes: 20 } })).status).toBe(403);
    const view = await t.request('GET', `/api/app/notify-settings?person=${ann.id}`, { cookie: admC });
    expect(view.status).toBe(200);
    expect(view.json.canEdit).toBe(false);
    expect((await t.request('PUT', '/api/app/notify-settings', { cookie: admC, body: { personId: ann.id, repeatMinutes: 20 } })).status).toBe(403);
    const s = await t.request('PUT', '/api/app/notify-settings', { cookie: sup, body: { personId: ann.id, repeatMinutes: 20 } });
    expect(s.status).toBe(200);
    expect(s.json.canEdit).toBe(true);
    expect(getPerson(t.db, ann.id)!.repeatMinutes).toBe(20);
    expect((await t.request('PUT', '/api/app/notify-settings', { cookie: sup, body: { personId: ann.id, repeatMinutes: null } })).json.prefs.repeatMinutes).toBeNull();
  });

  it('only the superadmin changes the team defaults; admins can still read them', async () => {
    const { t, sup, admC } = await setup();
    const cur = (await t.request('GET', '/api/task-settings', { cookie: admC })).json;
    expect(cur.leadMinutes).toBe(10);
    expect((await t.request('PUT', '/api/task-settings', { cookie: admC, body: { ...cur, repeatMinutes: 30 } })).status).toBe(403);
    expect((await t.request('PUT', '/api/task-settings', { cookie: sup, body: { ...cur, repeatMinutes: 30 } })).json.repeatMinutes).toBe(30);
  });

  it('people with a task list can list WhatsApp groups to choose their own', async () => {
    const { t, bobC } = await setup();
    const r = await t.request('GET', '/api/app/groups', { cookie: bobC });
    expect(r.status).toBe(200);
    expect(r.json.map((g: { name: string }) => g.name)).toEqual(['Sales team', 'Ops']);
  });

  it('a changed repeat interval applies from the last nudge', async () => {
    const { t, annC, ann } = await setup();
    t.db.prepare(`INSERT INTO task_nudge_state (owner_person_id, next_digest_at, last_digest_at) VALUES (?, ?, ?)`)
      .run(ann.id, new Date(T0 + 60 * MIN).toISOString(), new Date(T0).toISOString());
    await t.request('PUT', '/api/app/notify-settings', { cookie: annC, body: { repeatMinutes: 5 } });
    const st = t.db.prepare(`SELECT next_digest_at FROM task_nudge_state WHERE owner_person_id = ?`).get(ann.id) as { next_digest_at: string };
    expect(st.next_digest_at).toBe(new Date(T0 + 5 * MIN).toISOString());
  });
});

describe('nudge engine with personal settings', () => {
  const BASE = Date.parse('2026-11-16T06:00:00.000Z'); // 11:30 IST
  const at = (m: number) => new Date(BASE + m * MIN);
  const settings = { ...DEFAULT_TASK_SETTINGS, defaultGroupId: GROUP, mergeAheadMinutes: 0 };
  const person = (id: number, o: Partial<PersonRow> = {}): PersonRow => ({
    id, email: `p${id}@example.com`, name: `P${id}`, whatsapp: `9198000000${id}0`, role: 'member', active: true, notifyTarget: 'default',
    notifyGroupId: null, leadMinutes: null, repeatMinutes: null, quietHours: null, createdAt: 't', updatedAt: 't', ...o,
  });
  const task = (owner: number, dueMin: number): TaskRow => ({
    id: uuid(), ownerPersonId: owner, title: 'T', notes: '', status: 'todo', priority: 'medium', dueAt: at(dueMin).toISOString(),
    checklist: [], snoozedUntil: null, completedAt: null, firstAlertSentAt: null, lastNotifiedAt: null, createdBy: 'x',
    createdAt: 't', updatedAt: 't', version: 1, deletedAt: null,
  });

  it('uses each person\'s lead time, falling back to the team default', () => {
    const people = [person(1, { leadMinutes: 30 }), person(2)];
    const tasks = new Map([[1, [task(1, 25)]], [2, [task(2, 25)]]]);
    expect(computeDigests(at(0), people, tasks, new Map(), settings).map((d) => d.ownerId)).toEqual([1]); // 25 min out: inside 30, outside 10
    expect(computeDigests(at(15), people, tasks, new Map(), settings).map((d) => d.ownerId)).toEqual([1, 2]);
  });

  it('applies quiet hours per person', () => {
    const quiet = { enabled: true, start: '11:00', end: '12:00' }; // now is 11:30 IST
    const people = [person(1, { quietHours: quiet }), person(2)];
    const tasks = new Map([[1, [task(1, 5)]], [2, [task(2, 5)]]]);
    expect(computeDigests(at(0), people, tasks, new Map(), settings).map((d) => d.ownerId)).toEqual([2]);
    // a person can also switch team quiet hours off for themselves
    const teamQuiet = { ...settings, quietHours: quiet };
    const off = [person(1, { quietHours: { ...quiet, enabled: false } }), person(2)];
    expect(computeDigests(at(0), off, tasks, new Map(), teamQuiet).map((d) => d.ownerId)).toEqual([1]);
  });

  it('schedules the next digest with each person\'s own repeat interval', async () => {
    const db = openDb(':memory:');
    setTaskSettings(db, { defaultGroupId: GROUP, repeatMinutes: 15 });
    const a = createPerson(db, { email: 'a@example.com', name: 'A', whatsapp: '919800000001' });
    const b = createPerson(db, { email: 'b@example.com', name: 'B', whatsapp: '919800000002' });
    db.prepare(`UPDATE people SET repeat_minutes = 5 WHERE id = ?`).run(a.id);
    const actor = { email: 'x', role: 'superadmin', personId: null } as any;
    for (const p of [a, b]) saveTask(db, uuid(), { ownerPersonId: p.id, title: 'T', dueAt: at(5).toISOString() } as any, actor, at(-60).toISOString());
    const sent: string[] = [];
    const whatsapp = { async sendGroupMessage(_c: string, text: string) { sent.push(text); }, async sendDirectMessage() {} };
    await runTaskNudges(db, { whatsapp }, at(0));
    const next = (id: number) => (db.prepare(`SELECT next_digest_at FROM task_nudge_state WHERE owner_person_id = ?`).get(id) as { next_digest_at: string }).next_digest_at;
    expect(next(a.id)).toBe(at(5).toISOString());
    expect(next(b.id)).toBe(at(15).toISOString());
    expect(sent).toHaveLength(2);
  });
});
