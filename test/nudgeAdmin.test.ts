import { beforeAll, describe, expect, it } from 'vitest';
import { listAdmins, addAdmin, addAudit } from '../src/store.js';
import { SUPER, setupNudge } from './helpers/nudge.js';

beforeAll(() => { process.env.LOG_LEVEL = 'error'; });

interface Sent { kind: 'group' | 'dm'; chatId: string; text: string; mentions: string[] }

function fakeWa(opts: { groups?: { id: string; name: string }[]; failList?: boolean; failSend?: boolean } = {}) {
  const sent: Sent[] = [];
  let listCalls = 0;
  const groups = opts.groups ?? [{ id: '120363000000000001@g.us', name: 'Sales team' }, { id: '120363000000000002@g.us', name: 'Ops' }];
  return {
    sent,
    get listCalls() { return listCalls; },
    wa: {
      async listGroups() {
        listCalls++;
        if (opts.failList) throw new Error('WAHA groups failed: HTTP 401');
        return groups;
      },
      async sendGroupMessage(chatId: string, text: string, mentions: string[]) {
        if (opts.failSend) throw new Error('WAHA send failed: HTTP 500');
        sent.push({ kind: 'group', chatId, text, mentions });
      },
      async sendDirectMessage(chatId: string, text: string) {
        if (opts.failSend) throw new Error('WAHA send failed: HTTP 500');
        sent.push({ kind: 'dm', chatId, text, mentions: [] });
      },
    },
  };
}

async function setup(waOpts: Parameters<typeof fakeWa>[0] = {}) {
  const f = fakeWa(waOpts);
  const t = await setupNudge({ whatsapp: f.wa, env: { GOOGLE_OAUTH_CLIENT_ID: undefined } });
  const sup = await t.loginSuper();
  const admin = t.person('adm@example.com', 'admin');
  const admC = await t.loginWithCode('adm@example.com');
  const ann = t.person('ann@example.com', 'member', { whatsapp: '919811111111' });
  const annC = await t.loginWithCode('ann@example.com');
  return { t, f, sup, admin, admC, ann, annC };
}

describe('GET /api/nudge/groups', () => {
  it('is admin-only, returns [{id,name}], caches 5 minutes, refresh bypasses, never caches an empty list', async () => {
    const { t, f, sup, admC, annC } = await setup();
    expect((await t.request('GET', '/api/nudge/groups')).status).toBe(401);
    expect((await t.request('GET', '/api/nudge/groups', { cookie: annC })).status).toBe(403);
    const r = await t.request('GET', '/api/nudge/groups', { cookie: admC });
    expect(r.status).toBe(200);
    expect(r.json).toEqual([{ id: '120363000000000001@g.us', name: 'Sales team' }, { id: '120363000000000002@g.us', name: 'Ops' }]);
    await t.request('GET', '/api/nudge/groups', { cookie: sup });
    expect(f.listCalls).toBe(1); // cached
    await t.request('GET', '/api/nudge/groups?refresh=1', { cookie: sup });
    expect(f.listCalls).toBe(2);
    t.advance(5 * 60_000 + 1);
    await t.request('GET', '/api/nudge/groups', { cookie: sup });
    expect(f.listCalls).toBe(3);

    const empty = await setup({ groups: [] });
    await empty.t.request('GET', '/api/nudge/groups', { cookie: empty.sup });
    await empty.t.request('GET', '/api/nudge/groups', { cookie: empty.sup });
    expect(empty.f.listCalls).toBe(2); // an empty list is retried every time
  });

  it('maps WAHA errors to 502 without leaking details, and answers 503 when WhatsApp is not configured', async () => {
    const { t, sup } = await setup({ failList: true });
    const r = await t.request('GET', '/api/nudge/groups', { cookie: sup });
    expect(r.status).toBe(502);
    expect(r.json.error).toBe('could not list WhatsApp groups (WAHA HTTP 401)');
    const bare = await setupNudge();
    const s = await bare.loginSuper();
    expect((await bare.request('GET', '/api/nudge/groups', { cookie: s })).status).toBe(503);
  });
});

describe('POST /api/people/:id/test-nudge', () => {
  it('sends to the resolved target exactly like the nudge job: default group (mention), group override, DM', async () => {
    const { t, f, sup, admC, ann, annC } = await setup();
    const call = (id: number, cookie = admC) => { t.advance(31_000); return t.request('POST', `/api/people/${id}/test-nudge`, { cookie, body: {} }); }; // past the cooldown
    // no default group yet: 409
    const none = await call(ann.id);
    expect(none.status).toBe(409);
    expect(none.json.error).toMatch(/no default group/);
    await t.request('PUT', '/api/task-settings', { cookie: sup, body: { ...(await t.request('GET', '/api/task-settings', { cookie: sup })).json, defaultGroupId: '120363000000000001@g.us' } });
    const ok = await call(ann.id);
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ target: { type: 'group', chatId: '120363000000000001@g.us' } });
    expect(f.sent[0]).toMatchObject({ kind: 'group', chatId: '120363000000000001@g.us', mentions: ['919811111111'] });
    expect(f.sent[0]!.text).toContain('@919811111111');
    expect(f.sent[0]!.text).toContain('✅ Test nudge from Nudge: notifications for ann are set up correctly.');
    // group override
    await t.request('PUT', `/api/people/${ann.id}`, { cookie: sup, body: { email: 'ann@example.com', name: 'Ann', notifyTarget: 'group', notifyGroupId: '120363000000000002@g.us' } });
    expect((await call(ann.id)).json).toEqual({ target: { type: 'group', chatId: '120363000000000002@g.us' } });
    // DM
    await t.request('PUT', `/api/people/${ann.id}`, { cookie: sup, body: { email: 'ann@example.com', name: 'Ann', notifyTarget: 'dm' } });
    expect((await call(ann.id)).json).toEqual({ target: { type: 'dm', chatId: '919811111111@c.us' } });
    expect(f.sent[2]).toMatchObject({ kind: 'dm', chatId: '919811111111@c.us', mentions: [] });
    expect(f.sent[2]!.text).toBe('✅ Test nudge from Nudge: notifications for Ann are set up correctly.');
    // audited, without secrets
    const rows = t.db.prepare(`SELECT actor, details FROM audit_log WHERE action = 'person_test_nudge' ORDER BY id`).all() as { actor: string; details: string }[];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.actor).toBe('adm@example.com');
    expect(JSON.parse(rows[2]!.details)).toMatchObject({ id: ann.id, target: { type: 'dm', chatId: '919811111111@c.us' } });
    expect((await t.request('POST', `/api/people/${ann.id}/test-nudge`, { cookie: annC, body: {} })).status).toBe(403);
  });

  it('409 when the person has no whatsapp number or is deactivated, 404 unknown, 502 when WAHA fails', async () => {
    const { t, sup, admC } = await setup();
    await t.request('PUT', '/api/task-settings', { cookie: sup, body: { ...(await t.request('GET', '/api/task-settings', { cookie: sup })).json, defaultGroupId: '120363000000000001@g.us' } });
    const nonum = t.person('nonum@example.com');
    const r = await t.request('POST', `/api/people/${nonum.id}/test-nudge`, { cookie: admC, body: {} });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/no whatsapp number/);
    await t.request('DELETE', `/api/people/${nonum.id}`, { cookie: sup });
    expect((await t.request('POST', `/api/people/${nonum.id}/test-nudge`, { cookie: admC, body: {} })).status).toBe(409);
    expect((await t.request('POST', '/api/people/9999/test-nudge', { cookie: admC, body: {} })).status).toBe(404);

    const bad = await setup({ failSend: true });
    await bad.t.request('PUT', '/api/task-settings', { cookie: bad.sup, body: { ...(await bad.t.request('GET', '/api/task-settings', { cookie: bad.sup })).json, defaultGroupId: '120363000000000001@g.us' } });
    const f = await bad.t.request('POST', `/api/people/${bad.ann.id}/test-nudge`, { cookie: bad.admC, body: {} });
    expect(f.status).toBe(502);
    expect(f.json.error).toBe('could not send the test nudge (WAHA HTTP 500)');
    expect(bad.t.db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action = 'person_test_nudge'`).get()).toEqual({ n: 0 });
  });

  it("an admin cannot test the superadmin's own row", async () => {
    const { t, sup, admC } = await setup();
    const self = await t.request('POST', '/api/people/self', { cookie: sup, body: { whatsapp: '919800000000' } });
    expect((await t.request('POST', `/api/people/${self.json.id}/test-nudge`, { cookie: admC, body: {} })).status).toBe(403);
  });
});

describe("the superadmin's list is private", () => {
  it('creating or deleting a grant on it is superadmin-only; admins can still manage other lists', async () => {
    const { t, sup, admC, ann } = await setup();
    const self = (await t.request('POST', '/api/people/self', { cookie: sup, body: {} })).json;
    const grant = (cookie: string, owner: number, level = 'view') => t.request('POST', '/api/access-grants', { cookie, body: { granteePersonId: ann.id, ownerPersonId: owner, level } });
    expect((await grant(admC, self.id)).status).toBe(403);
    const made = await grant(sup, self.id);
    expect(made.status).toBe(201);
    expect((await grant(admC, self.id, 'edit')).status).toBe(403); // changing the level too
    expect((await t.request('DELETE', `/api/access-grants/${made.json.id}`, { cookie: admC })).status).toBe(403);
    expect(t.db.prepare(`SELECT COUNT(*) n FROM access_grants`).get()).toEqual({ n: 1 });
    const bob = t.person('bob@example.com');
    expect((await grant(admC, bob.id)).status).toBe(201);
    expect((await t.request('DELETE', `/api/access-grants/${made.json.id}`, { cookie: sup })).status).toBe(200);
  });
});

describe('/self repair and audit read', () => {
  it('audits a legacy-row repair as person_self_repair (and creation as person_self_create)', async () => {
    const { t, sup } = await setup();
    t.db.prepare(`INSERT INTO people (email, name, whatsapp, role, active, notify_target, created_at, updated_at) VALUES (?, 'boss', NULL, 'member', 0, 'default', 't', 't')`).run(SUPER);
    const r = await t.request('POST', '/api/people/self', { cookie: sup, body: {} });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ role: 'admin', active: true });
    expect(t.db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action = 'person_self_repair'`).get()).toEqual({ n: 1 });
    await t.request('POST', '/api/people/self', { cookie: sup, body: {} });
    expect(t.db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action = 'person_self_repair'`).get()).toEqual({ n: 1 }); // nothing to repair the 2nd time
  });

  it('GET /api/nudge/audit returns Nudge rows only (max 200, newest first), admin+ only', async () => {
    const { t, sup, admC, annC } = await setup();
    addAudit(t.db, 'x@example.com', 'closer_create', { id: 1 });
    addAudit(t.db, 'x@example.com', 'settings_update', {});
    await t.request('POST', '/api/people', { cookie: sup, body: { email: 'new@example.com', name: 'New' } });
    const cur = (await t.request('GET', '/api/task-settings', { cookie: sup })).json;
    await t.request('PUT', '/api/task-settings', { cookie: sup, body: { ...cur, leadMinutes: 15 } });
    expect((await t.request('GET', '/api/nudge/audit', { cookie: annC })).status).toBe(403);
    const r = await t.request('GET', '/api/nudge/audit', { cookie: admC });
    expect(r.status).toBe(200);
    const actions = r.json.map((a: any) => a.action);
    expect(actions[0]).toBe('task_settings_update');
    expect(actions).toContain('person_create');
    expect(actions.some((a: string) => ['closer_create', 'settings_update', 'login'].includes(a))).toBe(false);
    for (let i = 0; i < 210; i++) addAudit(t.db, 'sys', 'person_update', { i });
    expect((await t.request('GET', '/api/nudge/audit', { cookie: sup })).json).toHaveLength(200);
  });
});

describe('reminders console Admins list', () => {
  it('listAdmins leaves the superadmin out when its email is passed in', async () => {
    const { t, sup } = await setup();
    await t.request('POST', '/api/people/self', { cookie: sup, body: {} });
    addAdmin(t.db, { email: 'other@example.com' }, SUPER, SUPER);
    expect(listAdmins(t.db).map((a) => a.email)).toEqual(expect.arrayContaining([SUPER, 'adm@example.com', 'other@example.com']));
    expect(listAdmins(t.db, SUPER).map((a) => a.email)).toEqual(['adm@example.com', 'other@example.com']);
    expect(listAdmins(t.db, SUPER.toUpperCase()).map((a) => a.email)).not.toContain(SUPER);
  });
});

describe('review round: reactivate, cooldown, friendly messages', () => {
  it('an admin cannot reactivate an admin the superadmin deactivated; the superadmin can', async () => {
    const { t, sup, admin, admC } = await setup();
    const other = t.person('other@example.com', 'admin');
    expect((await t.request('DELETE', `/api/people/${other.id}`, { cookie: sup })).status).toBe(200);
    const body = { email: 'other@example.com', name: 'other', role: 'admin', active: true };
    const byAdmin = await t.request('PUT', `/api/people/${other.id}`, { cookie: admC, body });
    expect(byAdmin.status).toBe(403);
    expect(t.db.prepare(`SELECT active FROM people WHERE id = ?`).get(other.id)).toEqual({ active: 0 });
    const bySuper = await t.request('PUT', `/api/people/${other.id}`, { cookie: sup, body });
    expect(bySuper.status).toBe(200);
    expect(bySuper.json).toMatchObject({ role: 'admin', active: true });
    // admins still may reactivate a deactivated member
    const m = t.person('mem@example.com');
    await t.request('DELETE', `/api/people/${m.id}`, { cookie: sup });
    expect((await t.request('PUT', `/api/people/${m.id}`, { cookie: admC, body: { email: 'mem@example.com', name: 'mem', role: 'member', active: true } })).status).toBe(200);
    void admin;
  });

  it('test nudge has a 30 s cooldown per person (429), other people are unaffected', async () => {
    const { t, f, sup, admC, ann } = await setup();
    await t.request('PUT', '/api/task-settings', { cookie: sup, body: { ...(await t.request('GET', '/api/task-settings', { cookie: sup })).json, defaultGroupId: '120363000000000001@g.us' } });
    const call = (id: number) => t.request('POST', `/api/people/${id}/test-nudge`, { cookie: admC, body: {} });
    expect((await call(ann.id)).status).toBe(200);
    t.advance(10_000);
    const again = await call(ann.id);
    expect(again.status).toBe(429);
    expect(again.json.error).toBe('Wait a few seconds before sending another test');
    expect(f.sent).toHaveLength(1);
    const bob = t.person('bob2@example.com', 'member', { whatsapp: '919822222222' });
    expect((await call(bob.id)).status).toBe(200);
    t.advance(21_000);
    expect((await call(ann.id)).status).toBe(200);
  });

  it('validation messages are friendly, with the same field keys', async () => {
    const { t, sup } = await setup();
    const cur = (await t.request('GET', '/api/task-settings', { cookie: sup })).json;
    const bad = async (patch: object) => (await t.request('PUT', '/api/task-settings', { cookie: sup, body: { ...cur, ...patch } })).json.fields;
    expect((await bad({ leadMinutes: 0 })).leadMinutes).toBe('Enter a whole number from 1 to 1440');
    expect((await bad({ repeatMinutes: 2 })).repeatMinutes).toBe('Enter a whole number from 5 to 1440');
    expect((await bad({ mergeAheadMinutes: 40 })).mergeAheadMinutes).toBe('Enter a whole number from 0 to 15');
    expect((await bad({ leadMinutes: null })).leadMinutes).toBe('Enter a whole number from 1 to 1440');
    expect((await bad({ quietHours: { enabled: true, start: '9pm', end: '07:00' } })).quietHours).toBe('Use a time like 21:00');
    expect((await bad({ defaultGroupId: 'nope' })).defaultGroupId).toBe('Choose a WhatsApp group');
    const person = await t.request('POST', '/api/people', { cookie: sup, body: { email: 'nope', name: '', whatsapp: '123' } });
    expect(person.status).toBe(400);
    expect(Object.keys(person.json.fields).sort()).toEqual(['email', 'name', 'whatsapp']);
    expect(person.json.fields.email).toBe('Enter a valid email address');
    expect(person.json.fields.name).toBe('Enter a name');
    expect(person.json.fields.whatsapp).toBe('Use the international format with country code, e.g. +91 98765 43210');
    const grp = await t.request('POST', '/api/people', { cookie: sup, body: { email: 'g@example.com', name: 'G', notifyTarget: 'group' } });
    expect(grp.json.fields.notifyGroupId).toBe('Choose a WhatsApp group');
  });
});

import { z } from 'zod';
import { closerSchema, whatsappSchema } from '../src/config.js';

describe('round 3 details', () => {
  it('the reminders console whatsapp/closer validation is exactly what it was (plain z.string base, original wording)', () => {
    const reference = z.string().transform((s) => s.replace(/[\s\-()]/g, '').replace(/^\+/, ''))
      .pipe(z.string().regex(/^[1-9]\d{7,14}$/, 'must be an international number with country code'));
    for (const v of [undefined, null, 5, '', '12345', 'abc', '+91 98765-43210', '919876543210']) {
      const a = whatsappSchema.safeParse(v);
      const b = reference.safeParse(v);
      expect(a.success).toBe(b.success);
      if (!a.success && !b.success) expect(a.error.issues.map((i) => i.message)).toEqual(b.error.issues.map((i) => i.message));
    }
    const missing = closerSchema.safeParse({ name: 'A', email: 'a@b.co' });
    expect(missing.success).toBe(false);
    expect(missing.error!.issues.find((i) => i.path[0] === 'whatsapp')!.message).toBe(reference.safeParse(undefined).error!.issues[0]!.message);
    expect(closerSchema.safeParse({ name: 'A', email: 'a@b.co', whatsapp: '+91 98765 43210' }).success).toBe(true);
  });

  it('refusing to reactivate an admin says so; wrong-type booleans get friendly messages', async () => {
    const { t, sup, admC } = await setup();
    const other = t.person('o2@example.com', 'admin');
    await t.request('DELETE', `/api/people/${other.id}`, { cookie: sup });
    const r = await t.request('PUT', `/api/people/${other.id}`, { cookie: admC, body: { email: 'o2@example.com', name: 'o2', role: 'admin', active: true } });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('only the superadmin can reactivate an admin');
    const bad = await t.request('PUT', `/api/people/${other.id}`, { cookie: sup, body: { email: 'o2@example.com', name: 'o2', active: 'yes' } });
    expect(bad.json.fields.active).toBe('Choose active or inactive');
    const cur = (await t.request('GET', '/api/task-settings', { cookie: sup })).json;
    const q = await t.request('PUT', '/api/task-settings', { cookie: sup, body: { ...cur, quietHours: { enabled: 'on', start: '21:00', end: '09:00' } } });
    expect(q.json.fields.quietHours).toBe('Turn quiet hours on or off');
  });
});
