import { beforeAll, describe, expect, it, vi } from 'vitest';
import { type DB, openDb } from '../src/db.js';
import { createPerson, type PersonRow } from '../src/people.js';
import { computeDigests, inQuietHours, runTaskNudges } from '../src/tasks/nudges.js';
import { DEFAULT_TASK_SETTINGS, setTaskSettings, type TaskSettings } from '../src/tasks/settings.js';
import { applyAction, getTask, saveTask, type TaskRow } from '../src/tasks/store.js';
import { uuid } from './helpers/nudge.js';

beforeAll(() => { process.env.LOG_LEVEL = 'error'; });

const MIN = 60_000;
const BASE = Date.parse('2026-11-16T06:00:00.000Z'); // 11:30 IST
const at = (min: number) => new Date(BASE + min * MIN);
const GROUP = '120363000000000001@g.us';
const NUM = '919876543210';

const settings = (o: Partial<TaskSettings> & { appName?: string } = {}) => ({ ...DEFAULT_TASK_SETTINGS, defaultGroupId: GROUP, ...o });

const person = (o: Partial<PersonRow> = {}): PersonRow => ({
  id: 1, email: 'ann@example.com', name: 'Ann', whatsapp: NUM, role: 'member', active: true, notifyTarget: 'default',
  notifyGroupId: null, leadMinutes: null, repeatMinutes: null, quietHours: null, createdAt: 't', updatedAt: 't', ...o,
});

const task = (o: Partial<TaskRow> = {}): TaskRow => ({
  id: uuid(), ownerPersonId: 1, title: 'Prepare deck', notes: '', status: 'todo', priority: 'medium', dueAt: at(10).toISOString(),
  checklist: [], snoozedUntil: null, completedAt: null, firstAlertSentAt: null, lastNotifiedAt: null, createdBy: 'ann@example.com',
  createdAt: 't', updatedAt: 't', version: 1, deletedAt: null, ...o,
});

const run = (now: Date, tasks: TaskRow[], o: { people?: PersonRow[]; state?: Map<number, { nextDigestAt: string | null; lastDigestAt: string | null }>; settings?: ReturnType<typeof settings> } = {}) =>
  computeDigests(now, o.people ?? [person()], new Map([[1, tasks]]), o.state ?? new Map(), o.settings ?? settings());

describe('computeDigests: when', () => {
  it('first alert exactly at due - lead (10 min), not before', () => {
    const t = task();
    expect(run(at(-1), [t])).toHaveLength(0); // 11 min before
    expect(run(at(0), [t])).toHaveLength(1); // exactly 10 min before
    expect(run(at(5), [t])).toHaveLength(1);
  });

  it('after the first alert it repeats only when the repeat timer has passed', () => {
    const t = task({ firstAlertSentAt: at(0).toISOString() });
    const state = (next: Date) => new Map([[1, { nextDigestAt: next.toISOString(), lastDigestAt: at(0).toISOString() }]]);
    expect(run(at(9), [t], { state: state(at(10)) })).toHaveLength(0);
    expect(run(at(10), [t], { state: state(at(10)) })).toHaveLength(1);
    expect(run(at(11), [t], { state: state(at(10)) })).toHaveLength(1);
    expect(run(at(11), [t])).toHaveLength(0); // no timer, nothing new: nothing to send
  });

  it('excludes snoozed, done, deleted, undated tasks and inactive owners', () => {
    expect(run(at(0), [task({ snoozedUntil: at(5).toISOString() })])).toHaveLength(0);
    expect(run(at(5), [task({ snoozedUntil: at(5).toISOString() })])).toHaveLength(1); // <= now
    expect(run(at(0), [task({ status: 'done' })])).toHaveLength(0);
    expect(run(at(0), [task({ deletedAt: 'x' })])).toHaveLength(0);
    expect(run(at(0), [task({ dueAt: null })])).toHaveLength(0);
    expect(run(at(0), [task()], { people: [person({ active: false })] })).toHaveLength(0);
    expect(run(at(0), [task({ status: 'in_progress' })])).toHaveLength(1);
  });

  it('honours custom lead minutes', () => {
    expect(run(at(-5), [task()], { settings: settings({ leadMinutes: 15 }) })).toHaveLength(1);
    expect(run(at(-6), [task()], { settings: settings({ leadMinutes: 15 }) })).toHaveLength(0);
  });

  it('lists ALL nudgeable tasks, overdue first then by due time, in one digest per owner', () => {
    const a = task({ title: 'late', dueAt: at(-30).toISOString(), firstAlertSentAt: 'x' });
    const b = task({ title: 'soon', dueAt: at(5).toISOString() });
    const c = task({ title: 'later', dueAt: at(9).toISOString() });
    const [d] = run(at(0), [c, b, a]);
    expect(d!.taskIds).toEqual([a.id, b.id, c.id]);
    expect(d!.newTaskIds).toEqual([b.id, c.id]);
  });
});

describe('computeDigests: look-ahead merge', () => {
  const due = (min: number, o: Partial<TaskRow> = {}) => task({ dueAt: at(min).toISOString(), ...o });

  it('a digest that is due anyway also lists tasks that become nudgeable within the window, and marks them new', () => {
    const now = task({ title: 'now', dueAt: at(5).toISOString() });
    const soon = due(14, { title: 'soon' }); // nudgeable at +4 min: inside 5
    const edge = due(15, { title: 'edge' }); // nudgeable at +5 min: inside (<=)
    const far = due(16, { title: 'far' }); // nudgeable at +6 min: outside
    const [d] = run(at(0), [far, edge, soon, now]);
    expect(d!.taskIds).toEqual([now.id, soon.id, edge.id]);
    expect(d!.newTaskIds).toEqual([now.id, soon.id, edge.id]);
    expect(d!.message).toContain('*3. edge*\n_Due in 15 min, at');
  });

  it('never causes a digest by itself and never delays one', () => {
    const upcoming = due(14);
    expect(run(at(0), [upcoming])).toHaveLength(0); // nothing nudgeable now: no digest
    expect(run(at(4), [upcoming])).toHaveLength(1); // its own time: alerts on time
  });

  it('respects snoozes: a snooze ending inside the window is merged, one beyond it is not', () => {
    const now = due(5);
    const inside = due(8, { snoozedUntil: at(4).toISOString() });
    const beyond = due(8, { snoozedUntil: at(6).toISOString() });
    const [d] = run(at(0), [now, inside, beyond]);
    expect(d!.taskIds).toEqual([now.id, inside.id]);
  });

  it('skips done and deleted tasks, and is off with mergeAheadMinutes 0', () => {
    const now = due(5);
    expect(run(at(0), [now, due(14, { status: 'done' }), due(14, { deletedAt: 'x' })])[0]!.taskIds).toEqual([now.id]);
    const off = run(at(0), [now, due(14)], { settings: settings({ mergeAheadMinutes: 0 }) });
    expect(off[0]!.taskIds).toEqual([now.id]);
  });

  it('a single nudgeable task plus one merged task is a multi-task message', () => {
    const [d] = run(at(0), [due(5, { title: 'A' }), due(14, { title: 'B' })]);
    expect(d!.message.split('\n')[0]).toBe(`*Reminder: 2 pending tasks* @${NUM}`);
  });
});

describe('computeDigests: quiet hours', () => {
  const quiet = (start: string, end: string) => settings({ quietHours: { enabled: true, start, end } });
  const utcAtIst = (hh: number, mm: number) => new Date(Date.UTC(2026, 10, 16, hh, mm) - 330 * MIN);
  const due = (d: Date) => task({ dueAt: new Date(d.getTime() + 5 * MIN).toISOString() });

  it('suppresses nudges inside a window that crosses midnight and resumes at its end', () => {
    const s = quiet('21:00', '09:00');
    for (const [h, m] of [[21, 0], [23, 59], [0, 0], [3, 0], [8, 59]] as const) {
      const now = utcAtIst(h, m);
      expect(run(now, [due(now)], { settings: s }), `${h}:${m}`).toHaveLength(0);
    }
    for (const [h, m] of [[9, 0], [12, 0], [20, 59]] as const) {
      const now = utcAtIst(h, m);
      expect(run(now, [due(now)], { settings: s }), `${h}:${m}`).toHaveLength(1);
    }
  });

  it('works for a window within one day, and is off by default', () => {
    const s = quiet('13:00', '14:00');
    expect(inQuietHours(utcAtIst(13, 30), s.quietHours)).toBe(true);
    expect(inQuietHours(utcAtIst(14, 0), s.quietHours)).toBe(false);
    expect(inQuietHours(utcAtIst(12, 59), s.quietHours)).toBe(false);
    expect(inQuietHours(utcAtIst(3, 0), DEFAULT_TASK_SETTINGS.quietHours)).toBe(false);
  });

  it('a pending task alerts at the end of quiet hours (first alert still NULL)', () => {
    const s = quiet('21:00', '09:00');
    const night = utcAtIst(23, 0);
    const t = task({ dueAt: utcAtIst(23, 5).toISOString() });
    expect(run(night, [t], { settings: s })).toHaveLength(0);
    expect(run(new Date(utcAtIst(9, 0).getTime() + 24 * 60 * MIN), [t], { settings: s })[0]!.message).toContain('overdue by');
  });
});

describe('computeDigests: targets', () => {
  it('default: the default group, tagging the owner by number', () => {
    const [d] = run(at(0), [task()]);
    expect(d!.target).toEqual({ type: 'group', chatId: GROUP, mentions: [NUM] });
    expect(d!.message.split('\n')[0]).toBe(`*Reminder: task due in 10 min* @${NUM}`);
  });

  it('group override uses notify_group_id, still tagging the owner', () => {
    const g = '120363000000000077@g.us';
    const [d] = run(at(0), [task()], { people: [person({ notifyTarget: 'group', notifyGroupId: g })], settings: settings({ defaultGroupId: null }) });
    expect(d!.target).toEqual({ type: 'group', chatId: g, mentions: [NUM] });
  });

  it('dm: <whatsapp>@c.us, no mention and no tag in the text', () => {
    const [d] = run(at(0), [task()], { people: [person({ notifyTarget: 'dm' })], settings: settings({ defaultGroupId: null }) });
    expect(d!.target).toEqual({ type: 'dm', chatId: `${NUM}@c.us`, mentions: [] });
    expect(d!.message.split('\n')[0]).toBe('*Reminder: task due in 10 min*');
    expect(d!.message).not.toContain('@');
  });

  it('skips owners without a usable target and reports why', () => {
    const skips: [number, string][] = [];
    const go = (p: PersonRow, s = settings()) =>
      computeDigests(at(0), [p], new Map([[1, [task()]]]), new Map(), s, (id, reason) => skips.push([id, reason]));
    expect(go(person(), settings({ defaultGroupId: null }))).toHaveLength(0); // no default group
    expect(go(person({ whatsapp: null }))).toHaveLength(0); // nothing to mention
    expect(go(person({ notifyTarget: 'dm', whatsapp: null }))).toHaveLength(0);
    expect(go(person({ notifyTarget: 'group', notifyGroupId: null }))).toHaveLength(0);
    expect(skips.map((s) => s[1])).toEqual([
      'no default group set', 'no whatsapp number to mention', 'no whatsapp number for a direct message', 'no group id set for this person',
    ]);
  });
});

describe('computeDigests: message format', () => {
  const NOW = new Date('2026-11-16T11:20:00.000Z'); // 4:50 PM IST
  const dueIn = (min: number, o: Partial<TaskRow> = {}) => task({ dueAt: new Date(NOW.getTime() + min * MIN).toISOString(), ...o });

  it('single task, due soon: bold title, italic due line, footer, no link', () => {
    const [d] = run(NOW, [dueIn(10)], { settings: settings({ appName: 'Nudge' }) });
    expect(d!.message).toBe(`*Reminder: task due in 10 min* @${NUM}\n\n*Prepare deck*\n_Due in 10 min, at 5:00 PM_\n\n_Mark done or snooze in the Nudge app._`);
  });

  it('single task overdue', () => {
    const t = dueIn(-25, { firstAlertSentAt: 'x' });
    const [d] = computeDigests(NOW, [person()], new Map([[1, [t]]]), new Map([[1, { nextDigestAt: NOW.toISOString(), lastDigestAt: null }]]), settings());
    expect(d!.message).toBe(`*Reminder: task overdue by 25 min* @${NUM}\n\n*Prepare deck*\n_Overdue by 25 min (was due 4:25 PM)_\n\n_Mark done or snooze in the Pushup Nudge app._`);
  });

  it('several tasks: numbered bold titles, overdue first, footer with the app name', () => {
    const a = dueIn(-25, { title: 'Send proposal', firstAlertSentAt: 'x' });
    const b = dueIn(5, { title: 'Call Ravi' });
    const [d] = run(NOW, [b, a], { settings: settings({ appName: 'Tasks' }) });
    expect(d!.message).toBe([
      `*Reminder: 2 pending tasks* @${NUM}`, '',
      '*1. Send proposal*', '_Overdue by 25 min (was due 4:25 PM)_', '',
      '*2. Call Ravi*', '_Due in 5 min, at 4:55 PM_', '',
      '_Mark done or snooze in the Tasks app._',
    ].join('\n'));
  });

  it('more than 20 tasks: capped with "+ k more"; never any link', () => {
    const many = Array.from({ length: 25 }, (_, i) => dueIn(i % 9, { title: `T${i}` }));
    const [d] = run(NOW, many);
    expect(d!.taskIds).toHaveLength(25);
    const lines = d!.message.split('\n');
    expect(lines[0]).toBe(`*Reminder: 25 pending tasks* @${NUM}`);
    expect(lines.filter((l) => /^\*\d+\. /.test(l))).toHaveLength(20);
    expect(lines).toContain('+ 5 more');
    expect(d!.message).not.toMatch(/http|Open:|Manage:/);
  });

  it('a multi-line title stays on one line; the DM version uses the name', () => {
    const [d] = run(NOW, [dueIn(5, { title: 'one\ntwo' }), dueIn(6)], { people: [person({ notifyTarget: 'dm' })] });
    expect(d!.message).toContain('*1. one two*\n_Due in 5 min');
    expect(d!.message.split('\n')[0]).toBe('*Reminder: 2 pending tasks*');
  });
});

// ---------- the job against a real database ----------

function world(opts: { whatsapp?: string | null; target?: 'default' | 'group' | 'dm' } = {}) {
  const db = openDb(':memory:');
  const ann = createPerson(db, { email: 'ann@example.com', name: 'Ann', whatsapp: opts.whatsapp === undefined ? NUM : opts.whatsapp, notifyTarget: opts.target ?? 'default' });
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('tasks.default_group_id', ?, 't')`).run(JSON.stringify(GROUP));
  const sent: { to: string; text: string; mentions: string[]; at: string }[] = [];
  let failing = false;
  let clock = at(0);
  const whatsapp = {
    async sendGroupMessage(g: string, text: string, mentions: string[]) {
      if (failing) throw new Error('WAHA down');
      sent.push({ to: g, text, mentions, at: clock.toISOString() });
    },
    async sendDirectMessage(c: string, text: string) {
      if (failing) throw new Error('WAHA down');
      sent.push({ to: c, text, mentions: [], at: clock.toISOString() });
    },
  };
  const warned = new Map<number, number>();
  const create = (title: string, dueMin: number, who = ann.id) => {
    const id = uuid();
    saveTask(db, id, { title, dueAt: at(dueMin).toISOString() } as any, { email: 'ann@example.com', personId: who }, at(-200).toISOString());
    return id;
  };
  const tick = (min: number) => { clock = at(min); return runTaskNudges(db, { whatsapp, warned }, clock); };
  return { db, ann, sent, whatsapp, create, tick, setFailing: (f: boolean) => { failing = f; }, warned };
}

const state = (db: DB) => db.prepare(`SELECT * FROM task_nudge_state`).all();
const col = (db: DB, id: string, c: string) => (db.prepare(`SELECT ${c} v FROM tasks WHERE id = ?`).get(id) as { v: unknown }).v;

describe('runTaskNudges', () => {
  it('success writes first_alert, last_notified, nudge state and the digest row', async () => {
    const w = world();
    const id = w.create('Prepare deck', 10);
    const r = await w.tick(0);
    expect(r).toMatchObject({ digests: 1, sent: 1, failed: 0, ok: true });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ to: GROUP, mentions: [NUM] });
    expect(col(w.db, id, 'first_alert_sent_at')).toBe(at(0).toISOString());
    expect(col(w.db, id, 'last_notified_at')).toBe(at(0).toISOString());
    expect(state(w.db)).toEqual([{ owner_person_id: w.ann.id, next_digest_at: at(10).toISOString(), last_digest_at: at(0).toISOString() }]);
    expect(w.db.prepare(`SELECT owner_person_id, sent_at, target, task_ids FROM task_digests`).all())
      .toEqual([{ owner_person_id: w.ann.id, sent_at: at(0).toISOString(), target: GROUP, task_ids: JSON.stringify([id]) }]);
  });

  it('a send failure changes nothing and the next run retries', async () => {
    const w = world();
    const id = w.create('Prepare deck', 10);
    w.setFailing(true);
    const r = await w.tick(0);
    expect(r).toMatchObject({ sent: 0, failed: 1, ok: false });
    expect(col(w.db, id, 'first_alert_sent_at')).toBeNull();
    expect(col(w.db, id, 'last_notified_at')).toBeNull();
    expect(state(w.db)).toEqual([]);
    expect(w.db.prepare(`SELECT COUNT(*) n FROM task_digests`).get()).toEqual({ n: 0 });
    w.setFailing(false);
    const r2 = await w.tick(1);
    expect(r2.sent).toBe(1);
    expect(w.sent).toHaveLength(1);
    expect(col(w.db, id, 'first_alert_sent_at')).toBe(at(1).toISOString());
  });

  it('writes the state in ONE transaction (a failing step rolls everything back)', async () => {
    const w = world();
    const id = w.create('Prepare deck', 10);
    w.db.exec(`CREATE TRIGGER boom BEFORE INSERT ON task_digests BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const r = await w.tick(0);
    expect(r.ok).toBe(false);
    expect(col(w.db, id, 'first_alert_sent_at')).toBeNull();
    expect(col(w.db, id, 'last_notified_at')).toBeNull();
    expect(state(w.db)).toEqual([]);
  });

  it('never throws, even when the database is broken', async () => {
    const w = world();
    w.db.exec(`DROP TABLE task_nudge_state`);
    await expect(w.tick(0)).resolves.toMatchObject({ ok: false });
  });

  it('does not send a duplicate digest within the repeat window, then repeats every 10 minutes', async () => {
    const w = world();
    w.create('Prepare deck', 10);
    const minutes: number[] = [];
    for (let m = 0; m <= 45; m++) {
      const before = w.sent.length;
      await w.tick(m);
      if (w.sent.length > before) minutes.push(m);
    }
    expect(minutes).toEqual([0, 10, 20, 30, 40]);
    expect(w.sent[2]!.text).toMatch(/Overdue by 10 min/);
  });

  const batch = async (w: ReturnType<typeof world>, upTo: number) => {
    const ids = [w.create('C', 92), w.create('B', 93), w.create('A', 95)];
    const log: { m: number; n: number }[] = [];
    for (let m = 0; m <= upTo; m++) {
      const before = w.sent.length;
      await w.tick(m);
      if (w.sent.length > before) log.push({ m, n: w.sent.at(-1)!.text.split('\n').filter((l) => /^\*\d+\. /.test(l)).length || 1 });
    }
    return { ids, log };
  };

  it('merge window (default 5 min): tasks due 92, 93 and 95 min ahead give ONE first digest at +82, then aligned repeats', async () => {
    const w = world();
    const { ids, log } = await batch(w, 106);
    expect(log).toEqual([{ m: 82, n: 3 }, { m: 92, n: 3 }, { m: 102, n: 3 }]);
    // the first digest already lists all three as "due in N min" and marks all three alerted
    expect(w.sent[0]!.text).toContain('*1. C*\n_Due in 10 min');
    expect(w.sent[0]!.text).toContain('*2. B*\n_Due in 11 min');
    expect(w.sent[0]!.text).toContain('*3. A*\n_Due in 13 min');
    expect(w.sent[0]!.text).not.toContain('⚠️');
    expect(col(w.db, ids[2]!, 'first_alert_sent_at')).toBe(at(82).toISOString());
    expect(w.sent.at(-1)!.text).toContain('*1. C*\n_Overdue by 10 min');
    expect(w.db.prepare(`SELECT COUNT(*) n FROM task_digests`).get()).toEqual({ n: 3 });
  });

  it('merge_ahead_minutes = 0 restores separate first alerts, then ONE aligned digest at the next repeat', async () => {
    const w = world();
    setTaskSettings(w.db, { mergeAheadMinutes: 0 });
    const { log } = await batch(w, 106);
    expect(log.slice(0, 3)).toEqual([{ m: 82, n: 1 }, { m: 83, n: 2 }, { m: 85, n: 3 }]);
    expect(log.slice(3)).toEqual([{ m: 95, n: 3 }, { m: 105, n: 3 }]);
    expect(w.sent.at(-1)!.text).toContain('*1. C*\n_Overdue by 13 min');
  });

  it('snoozed tasks are left out, and alert again when the snooze expires', async () => {
    const w = world();
    const id = w.create('Prepare deck', 10);
    await w.tick(0);
    expect(w.sent).toHaveLength(1);
    applyAction(w.db, getTask(w.db, id)!, 'snooze', 'ann@example.com', at(1).toISOString(), 30);
    const minutes: number[] = [];
    for (let m = 1; m <= 40; m++) {
      const before = w.sent.length;
      await w.tick(m);
      if (w.sent.length > before) minutes.push(m);
    }
    expect(minutes[0]).toBe(31); // snoozed_until = 1 + 30; re-armed, so it alerts immediately when it expires
  });

  it('done tasks stop; so do deleted tasks and deactivated owners', async () => {
    const w = world();
    const id = w.create('Prepare deck', 10);
    await w.tick(0);
    applyAction(w.db, getTask(w.db, id)!, 'done', 'ann@example.com', at(5).toISOString());
    for (let m = 6; m <= 40; m++) await w.tick(m);
    expect(w.sent).toHaveLength(1);

    const w2 = world();
    w2.create('x', 10);
    w2.db.prepare(`UPDATE people SET active = 0`).run();
    await w2.tick(0);
    expect(w2.sent).toHaveLength(0);
  });

  it('a task reopened or re-dated alerts again', async () => {
    const w = world();
    const id = w.create('Prepare deck', 10);
    await w.tick(0);
    applyAction(w.db, getTask(w.db, id)!, 'done', 'x', at(1).toISOString());
    applyAction(w.db, getTask(w.db, id)!, 'reopen', 'x', at(2).toISOString());
    await w.tick(2);
    expect(w.sent).toHaveLength(2);
  });

  it('sends a DM for the dm target', async () => {
    const w = world({ target: 'dm' });
    w.create('Prepare deck', 10);
    await w.tick(0);
    expect(w.sent[0]).toMatchObject({ to: `${NUM}@c.us`, mentions: [] });
    expect(w.sent[0]!.text.split('\n')[0]).toBe('*Reminder: task due in 10 min*');
  });

  it('skips an owner with no usable target and warns at most once per hour', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'warn';
    try {
      const w = world({ whatsapp: null });
      w.create('Prepare deck', 10);
      for (const m of [0, 1, 2, 30, 59]) await w.tick(m);
      expect(w.sent).toHaveLength(0);
      expect(col(w.db, (w.db.prepare(`SELECT id FROM tasks`).get() as { id: string }).id, 'first_alert_sent_at')).toBeNull();
      const warns = () => err.mock.calls.filter((c) => String(c[0]).includes('no usable target')).length;
      expect(warns()).toBe(1);
      await w.tick(61);
      expect(warns()).toBe(2);
    } finally {
      process.env.LOG_LEVEL = prev;
      err.mockRestore();
    }
  });

  it("one owner's failure does not block another owner's digest", async () => {
    const w = world();
    const bob = createPerson(w.db, { email: 'bob@example.com', name: 'Bob', whatsapp: '919000000002' });
    w.create('Ann task', 10);
    w.create('Bob task', 10, bob.id);
    let calls = 0;
    const whatsapp = {
      ...w.whatsapp,
      async sendGroupMessage(g: string, t: string, m: string[]) {
        if (calls++ === 0) throw new Error('first fails');
        return w.whatsapp.sendGroupMessage(g, t, m);
      },
    };
    const r = await runTaskNudges(w.db, { whatsapp, warned: w.warned }, at(0));
    expect(r).toMatchObject({ digests: 2, sent: 1, failed: 1 });
    expect(w.sent).toHaveLength(1);
  });
});
