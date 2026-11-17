import { beforeAll, describe, expect, it } from 'vitest';
import { T0, setupNudge, uuid } from './helpers/nudge.js';

beforeAll(() => { process.env.LOG_LEVEL = 'error'; });

interface Sent { kind: 'group' | 'dm'; chatId: string; text: string; mentions: string[] }

function fakeWa(failSend = false) {
  const sent: Sent[] = [];
  return {
    sent,
    wa: {
      async listGroups() { return []; },
      async sendGroupMessage(chatId: string, text: string, mentions: string[]) {
        if (failSend) throw new Error('WAHA send failed: HTTP 500');
        sent.push({ kind: 'group', chatId, text, mentions });
      },
      async sendDirectMessage(chatId: string, text: string) {
        if (failSend) throw new Error('WAHA send failed: HTTP 500');
        sent.push({ kind: 'dm', chatId, text, mentions: [] });
      },
    },
  };
}

const GROUP = '120363000000000001@g.us';

async function setup(failSend = false) {
  const f = fakeWa(failSend);
  const t = await setupNudge({ whatsapp: f.wa, env: { GOOGLE_OAUTH_CLIENT_ID: undefined } });
  const sup = await t.loginSuper();
  const cur = (await t.request('GET', '/api/task-settings', { cookie: sup })).json;
  await t.request('PUT', '/api/task-settings', { cookie: sup, body: { ...cur, defaultGroupId: GROUP } });
  t.person('adm@example.com', 'admin');
  const admC = await t.loginWithCode('adm@example.com');
  const ann = t.person('ann@example.com', 'member', { whatsapp: '919811111111' });
  const annC = await t.loginWithCode('ann@example.com');
  const bob = t.person('bob@example.com', 'member', { whatsapp: '919822222222', notifyTarget: 'dm' });
  const bobC = await t.loginWithCode('bob@example.com');
  const task = async (cookie: string, title: string, dueInMin: number | null) => {
    const r = await t.request('PUT', `/api/app/tasks/${uuid()}`, {
      cookie, body: { title, dueAt: dueInMin === null ? null : new Date(T0 + dueInMin * 60_000).toISOString() },
    });
    expect(r.status).toBe(201);
    return r.json;
  };
  return { t, f, sup, admC, ann, annC, bob, bobC, task };
}

describe('GET /api/app/nudge-preview', () => {
  it('lets a member preview their own nudge, built like the real digest, without changing anything', async () => {
    const { t, annC, task } = await setup();
    await task(annC, 'Send invoice', 5);
    await task(annC, 'Call Ravi', -20);
    const r = await t.request('GET', '/api/app/nudge-preview', { cookie: annC });
    expect(r.status).toBe(200);
    expect(r.json.ready).toBe(true);
    expect(r.json.mode).toBe('due');
    expect(r.json.target).toEqual({ type: 'group', chatId: GROUP });
    expect(r.json.taskCount).toBe(2);
    expect(r.json.message).toContain('*Reminder: 2 pending tasks* @919811111111');
    expect(r.json.message.indexOf('Call Ravi')).toBeLessThan(r.json.message.indexOf('Send invoice')); // overdue first
    const after = await t.request('GET', '/api/app/tasks', { cookie: annC });
    expect(after.json.tasks.every((x: { firstAlertSentAt?: unknown }) => !x.firstAlertSentAt)).toBe(true);
  });

  it('falls back to upcoming dated tasks when nothing is due yet, and reports when there is nothing to preview', async () => {
    const { t, annC, bobC, task } = await setup();
    await task(annC, 'Board deck', 600);
    await task(annC, 'No date task', null);
    const r = await t.request('GET', '/api/app/nudge-preview', { cookie: annC });
    expect(r.json).toMatchObject({ ready: true, mode: 'upcoming', taskCount: 1 });
    const empty = await t.request('GET', '/api/app/nudge-preview', { cookie: bobC });
    expect(empty.json).toMatchObject({ ready: false, reason: 'no_tasks' });
  });

  it('explains a missing target, and uses a DM for people set to direct message', async () => {
    const { t, sup, annC, bobC, task } = await setup();
    await task(bobC, 'Pay rent', 3);
    const dm = await t.request('GET', '/api/app/nudge-preview', { cookie: bobC });
    expect(dm.json.target).toEqual({ type: 'dm', chatId: '919822222222@c.us' });
    const cur = (await t.request('GET', '/api/task-settings', { cookie: sup })).json;
    await t.request('PUT', '/api/task-settings', { cookie: sup, body: { ...cur, defaultGroupId: null } });
    await task(annC, 'X', 3);
    const none = await t.request('GET', '/api/app/nudge-preview', { cookie: annC });
    expect(none.json).toMatchObject({ ready: false, reason: 'no_target', detail: 'no default group set' });
  });

  it('members can only preview themselves; admins anyone except the superadmin row', async () => {
    const { t, sup, admC, ann, annC, bob } = await setup();
    expect((await t.request('GET', '/api/app/nudge-preview')).status).toBe(401);
    expect((await t.request('GET', `/api/app/nudge-preview?person=${bob.id}`, { cookie: annC })).status).toBe(403);
    expect((await t.request('GET', `/api/app/nudge-preview?person=${ann.id}`, { cookie: admC })).status).toBe(200);
    const me = (await t.request('POST', '/api/people/self', { cookie: sup })).json;
    expect((await t.request('GET', `/api/app/nudge-preview?person=${me.id}`, { cookie: admC })).status).toBe(403);
    expect((await t.request('GET', `/api/app/nudge-preview?person=${me.id}`, { cookie: sup })).status).toBe(200);
    expect((await t.request('GET', '/api/app/nudge-preview?person=abc', { cookie: admC })).status).toBe(404);
  });
});

describe('POST /api/app/nudge-preview/send', () => {
  it('sends the real message marked [TEST] to the real target, audits it, and leaves nudge timing untouched', async () => {
    const { t, f, sup, annC, task } = await setup();
    await task(annC, 'Send invoice', 5);
    const r = await t.request('POST', '/api/app/nudge-preview/send', { cookie: annC, body: {} });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ target: { type: 'group', chatId: GROUP }, taskCount: 1, mode: 'due' });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.text.startsWith('🧪 [TEST]')).toBe(true);
    expect(f.sent[0]!.text).toContain('Send invoice');
    expect(f.sent[0]!.mentions).toEqual(['919811111111@c.us'.replace('@c.us', '')]);
    const state = t.db.prepare('SELECT COUNT(*) AS n FROM task_nudge_state').get() as { n: number };
    expect(state.n).toBe(0);
    const audit = (await t.request('GET', '/api/nudge/audit', { cookie: sup })).json;
    expect(audit.some((a: { action: string }) => a.action === 'person_test_digest')).toBe(true);
  });

  it('has a 30 s cooldown per person, clears it on a failed send, and answers 409 when not ready', async () => {
    const { t, f, annC, bobC, task } = await setup();
    await task(annC, 'A', 5);
    expect((await t.request('POST', '/api/app/nudge-preview/send', { cookie: annC, body: {} })).status).toBe(200);
    expect((await t.request('POST', '/api/app/nudge-preview/send', { cookie: annC, body: {} })).status).toBe(429);
    t.advance(30_001);
    expect((await t.request('POST', '/api/app/nudge-preview/send', { cookie: annC, body: {} })).status).toBe(200);
    expect(f.sent).toHaveLength(2);
    expect((await t.request('POST', '/api/app/nudge-preview/send', { cookie: bobC, body: {} })).status).toBe(409);

    const bad = await setup(true);
    await bad.task(bad.annC, 'B', 5);
    const fail = await bad.t.request('POST', '/api/app/nudge-preview/send', { cookie: bad.annC, body: {} });
    expect(fail.status).toBe(502);
    expect(fail.json.error).toBe('could not send the test message (WAHA HTTP 500)');
    expect((await bad.t.request('POST', '/api/app/nudge-preview/send', { cookie: bad.annC, body: {} })).status).toBe(502); // retry allowed
  });

  it('admins may send for others; members may not', async () => {
    const { t, admC, ann, annC, bob, task } = await setup();
    await task(annC, 'A', 5);
    expect((await t.request('POST', '/api/app/nudge-preview/send', { cookie: admC, body: { personId: ann.id } })).status).toBe(200);
    expect((await t.request('POST', '/api/app/nudge-preview/send', { cookie: annC, body: { personId: bob.id } })).status).toBe(403);
  });
});
