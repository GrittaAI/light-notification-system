import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { KV_PEOPLE_MIGRATED_AT, migrateAdminUsers, openDb } from '../src/db.js';
import { createAdminServer, startAdminServer } from '../src/admin/server.js';
import { getPersonByEmail, listPeople } from '../src/people.js';
import { addAdmin, listAdmins, removeAdmin } from '../src/store.js';
import { PASSWORD, setupNudge, SUPER, uuid } from './helpers/nudge.js';

beforeAll(() => { process.env.LOG_LEVEL = 'error'; });

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'nudge-db-')), 'app.db');

describe('admin_users -> people migration', () => {
  it('copies every admin_users row once, idempotently, with role admin and name from the email', () => {
    const path = tmpFile();
    const db = openDb(path);
    db.exec(`INSERT INTO admin_users (email, role, added_by, created_at) VALUES ('ann@example.com','admin','x','2026-01-01T00:00:00.000Z'), ('bob.s@example.com','admin','x','2026-01-02T00:00:00.000Z')`);
    db.prepare(`DELETE FROM kv WHERE key = ?`).run(KV_PEOPLE_MIGRATED_AT); // as on a database from before the migration
    expect(migrateAdminUsers(db)).toBe(2);
    expect(migrateAdminUsers(db)).toBe(0);
    const people = listPeople(db);
    expect(people.map((p) => [p.email, p.name, p.role, p.active])).toEqual([
      ['ann@example.com', 'ann', 'admin', true], ['bob.s@example.com', 'bob.s', 'admin', true],
    ]);
    db.close();
    const again = openDb(path); // restarting does not duplicate
    expect(listPeople(again)).toHaveLength(2);
    again.close();
  });

  it('does not resurrect a removed admin on restart', () => {
    const path = tmpFile();
    const db = openDb(path);
    db.exec(`INSERT INTO admin_users (email, role, added_by, created_at) VALUES ('ann@example.com','admin','x','2026-01-01T00:00:00.000Z')`);
    db.prepare(`DELETE FROM kv WHERE key = ?`).run(KV_PEOPLE_MIGRATED_AT);
    migrateAdminUsers(db);
    removeAdmin(db, 'ann@example.com', SUPER);
    db.close();
    const again = openDb(path);
    expect(listAdmins(again)).toEqual([]);
    expect(getPersonByEmail(again, 'ann@example.com')?.role).toBe('member');
  });

  it('openDb twice in sequence on the same file is safe', () => {
    const path = tmpFile();
    const a = openDb(path);
    a.exec(`INSERT INTO closers (name, email, whatsapp, active, created_at, updated_at) VALUES ('c','c@example.com','919000000001',1,'t','t')`);
    const b = openDb(path);
    expect((b.prepare(`SELECT COUNT(*) n FROM closers`).get() as { n: number }).n).toBe(1);
    a.close(); b.close();
  });
});

describe('/api/admins is backed by people', () => {
  it('lists, adds (promoting an existing person) and removes (demoting) through the reminders console', async () => {
    const db = openDb(':memory:');
    addAdmin(db, { email: 'Adm@Example.com' }, SUPER, SUPER);
    expect(getPersonByEmail(db, 'adm@example.com')).toMatchObject({ role: 'admin', name: 'adm', active: true });
    expect(listAdmins(db).map((a) => a.email)).toEqual(['adm@example.com']);
    expect(() => addAdmin(db, { email: 'adm@example.com' }, SUPER, SUPER)).toThrow(/already exists/);
    removeAdmin(db, 'adm@example.com', SUPER);
    expect(listAdmins(db)).toEqual([]);
    expect(getPersonByEmail(db, 'adm@example.com')?.role).toBe('member');
  });
});

describe('roles in the Nudge server', () => {
  it('a migrated admin can use the Nudge admin APIs; a member gets 403 on them', async () => {
    const t = await setupNudge();
    t.person('adm@example.com', 'admin');
    t.person('mem@example.com', 'member');
    const adm = await t.loginWithCode('adm@example.com');
    const mem = await t.loginWithCode('mem@example.com');
    expect((await t.request('GET', '/api/people', { cookie: adm })).status).toBe(200);
    for (const [m, p] of [['GET', '/api/people'], ['GET', '/api/access-grants'], ['GET', '/api/task-settings'], ['PUT', '/api/task-settings'], ['POST', '/api/people']] as const) {
      expect((await t.request(m, p, { cookie: mem, body: m === 'GET' ? undefined : {} })).status, `${m} ${p}`).toBe(403);
    }
    const me = await t.request('GET', '/api/me', { cookie: mem });
    expect(me.json).toMatchObject({ email: 'mem@example.com', name: 'mem', role: 'member', personId: expect.any(Number) });
  });

  it('/api/me for the superadmin has no personId until a person row exists', async () => {
    const t = await setupNudge();
    const cookie = await t.loginSuper();
    expect((await t.request('GET', '/api/me', { cookie })).json).toEqual({ email: SUPER, name: 'boss', role: 'superadmin', personId: null });
  });

  it('only the superadmin can create or demote admins; duplicates are 409; writes are audited', async () => {
    const t = await setupNudge();
    t.person('adm@example.com', 'admin');
    const adm = await t.loginWithCode('adm@example.com');
    const sup = await t.loginSuper();
    const mk = (cookie: string, body: object) => t.request('POST', '/api/people', { cookie, body });
    expect((await mk(adm, { email: 'x@example.com', name: 'X', role: 'admin' })).status).toBe(403);
    expect((await mk(adm, { email: 'm@example.com', name: 'M', whatsapp: '+91 98765 43210' })).status).toBe(201);
    expect((await mk(adm, { email: 'M@example.com', name: 'M2' })).status).toBe(409);
    expect((await mk(sup, { email: 'x@example.com', name: 'X', role: 'admin' })).status).toBe(201);
    const bad = await mk(adm, { email: 'nope', name: '' });
    expect(bad.status).toBe(400);
    expect(bad.json.fields).toHaveProperty('email');
    const grp = await mk(adm, { email: 'g@example.com', name: 'G', notifyTarget: 'group' });
    expect(grp.status).toBe(400);
    expect(grp.json.fields.notifyGroupId).toBeDefined();

    const m = getPersonByEmail(t.db, 'm@example.com')!;
    expect(m.whatsapp).toBe('919876543210');
    // an admin cannot demote or deactivate another admin; the superadmin can
    const x = getPersonByEmail(t.db, 'x@example.com')!;
    expect((await t.request('PUT', `/api/people/${x.id}`, { cookie: adm, body: { email: x.email, name: 'X', role: 'member' } })).status).toBe(403);
    expect((await t.request('DELETE', `/api/people/${x.id}`, { cookie: adm })).status).toBe(403);
    expect((await t.request('DELETE', `/api/people/${x.id}`, { cookie: sup })).status).toBe(200);
    expect(getPersonByEmail(t.db, 'x@example.com')?.active).toBe(false);
    // members can be updated and deactivated by admins
    expect((await t.request('PUT', `/api/people/${m.id}`, { cookie: adm, body: { email: m.email, name: 'Mm', notifyTarget: 'dm' } })).json.notifyTarget).toBe('dm');
    expect((await t.request('DELETE', `/api/people/${m.id}`, { cookie: adm })).status).toBe(200);
    const actions = (t.db.prepare(`SELECT action FROM audit_log`).all() as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['person_create', 'person_update', 'person_deactivate']));
  });

  it('a deactivated person is signed out and cannot sign in again', async () => {
    const t = await setupNudge();
    const p = t.person('mem@example.com');
    const cookie = await t.loginWithCode('mem@example.com');
    const sup = await t.loginSuper();
    await t.request('DELETE', `/api/people/${p.id}`, { cookie: sup });
    expect((await t.request('GET', '/api/me', { cookie })).status).toBe(401);
    await t.request('POST', '/api/auth/email-code', { body: { email: 'mem@example.com' } });
    expect(t.mails).toHaveLength(1); // only the first login's code
  });
});

describe('privilege rules for people', () => {
  it('a non-superadmin admin cannot change an admin\'s email; the superadmin can; a case-only change is not a change', async () => {
    const t = await setupNudge();
    t.person('adm@example.com', 'admin');
    const other = t.person('other@example.com', 'admin');
    const adm = await t.loginWithCode('adm@example.com');
    const sup = await t.loginSuper();
    const put = (cookie: string, body: object) => t.request('PUT', `/api/people/${other.id}`, { cookie, body });
    const r = await put(adm, { email: 'attacker@evil.test', name: 'x' });
    expect(r.status).toBe(403);
    expect((await put(adm, { email: ' Attacker@Evil.test ', name: 'x' })).status).toBe(403);
    expect(getPersonByEmail(t.db, 'other@example.com')?.role).toBe('admin');
    expect(getPersonByEmail(t.db, 'attacker@evil.test')).toBeUndefined();
    // same email (any case) and other edits are fine for an admin
    expect((await put(adm, { email: 'OTHER@example.com', name: 'Renamed' })).status).toBe(200);
    // the superadmin may change it
    const ok = await put(sup, { email: 'new@example.com', name: 'Renamed' });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ email: 'new@example.com', role: 'admin' });
    // changing a MEMBER's email is allowed for admins
    const mem = t.person('mem@example.com');
    expect((await t.request('PUT', `/api/people/${mem.id}`, { cookie: adm, body: { email: 'mem2@example.com', name: 'M' } })).status).toBe(200);
  });

  it('ordinary admins cannot create, rename to, edit, re-role or deactivate the superadmin row; sessions stay intact', async () => {
    const t = await setupNudge();
    t.person('adm@example.com', 'admin');
    const mem = t.person('mem@example.com');
    const adm = await t.loginWithCode('adm@example.com');
    const sup = await t.loginSuper();
    const c = await t.request('POST', '/api/people', { cookie: adm, body: { email: 'BOSS@example.com', name: 'Boss' } });
    expect(c.status).toBe(400);
    expect(c.json.fields.email).toBe('is the superadmin');
    expect((await t.request('POST', '/api/people/self', { cookie: adm, body: {} })).status).toBe(403);
    expect(getPersonByEmail(t.db, SUPER)).toBeUndefined();
    // nobody (not even the superadmin) can rename another person to the superadmin address
    for (const cookie of [adm, sup]) {
      expect((await t.request('PUT', `/api/people/${mem.id}`, { cookie, body: { email: SUPER, name: 'M' } })).status).toBe(400);
    }
    expect(getPersonByEmail(t.db, 'mem@example.com')).toBeDefined();

    const created = await t.request('POST', '/api/people/self', { cookie: sup, body: {} });
    expect(created.status).toBe(201);
    const row = getPersonByEmail(t.db, SUPER)!;
    const sessions = () => (t.db.prepare(`SELECT COUNT(*) n FROM admin_sessions WHERE email = ?`).get(SUPER) as { n: number }).n;
    const before = sessions();
    expect(before).toBeGreaterThan(0);
    expect((await t.request('DELETE', `/api/people/${row.id}`, { cookie: adm })).status).toBe(403); // the row is an admin
    expect((await t.request('DELETE', `/api/people/${row.id}`, { cookie: sup })).status).toBe(400); // nobody deactivates it
    for (const body of [{ email: SUPER, name: 'Hacked' }, { email: SUPER, name: 'Boss', active: false }, { email: SUPER, name: 'Boss', role: 'member' },
      { email: 'attacker@evil.test', name: 'Boss' }]) {
      expect((await t.request('PUT', `/api/people/${row.id}`, { cookie: adm, body })).status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
    }
    expect(getPersonByEmail(t.db, SUPER)).toMatchObject({ name: 'boss', active: true, role: 'admin' });
    // the superadmin cannot re-role, deactivate or change the email of their own row either
    for (const body of [{ email: SUPER, name: 'Boss', role: 'member' }, { email: SUPER, name: 'Boss', active: false }, { email: 'x@example.com', name: 'Boss' }]) {
      expect((await t.request('PUT', `/api/people/${row.id}`, { cookie: sup, body })).status, JSON.stringify(body)).toBe(400);
    }
    expect(sessions()).toBe(before);
    expect((await t.request('GET', '/api/me', { cookie: sup })).status).toBe(200);
  });

  it('a legacy superadmin row (member role) is untouchable by admins and repaired by the superadmin', async () => {
    const t = await setupNudge();
    t.person('adm@example.com', 'admin');
    const adm = await t.loginWithCode('adm@example.com');
    const sup = await t.loginSuper();
    t.db.prepare(`INSERT INTO people (email, name, role, active, notify_target, created_at, updated_at) VALUES (?, 'Boss', 'member', 1, 'default', 't', 't')`).run(SUPER);
    const row = getPersonByEmail(t.db, SUPER)!;
    expect((await t.request('PUT', `/api/people/${row.id}`, { cookie: adm, body: { email: SUPER, name: 'x' } })).status).toBe(400);
    const again = await t.request('POST', '/api/people/self', { cookie: sup, body: {} });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ id: row.id, role: 'admin', active: true });
  });
});

describe('the superadmin\'s own person row', () => {
  it('POST /api/people/self creates it (201, role admin, name from the email, optional WhatsApp); a repeat returns the same row', async () => {
    const t = await setupNudge();
    const sup = await t.loginSuper();
    expect((await t.request('GET', '/api/me', { cookie: sup })).json.personId).toBeNull();
    const r = await t.request('POST', '/api/people/self', { cookie: sup, body: { whatsapp: '+91 98765 43210' } });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ email: SUPER, name: 'boss', role: 'admin', active: true, whatsapp: '919876543210' });
    const again = await t.request('POST', '/api/people/self', { cookie: sup, body: { name: 'Other', whatsapp: '+1 555 0100 0000' } });
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(r.json.id);
    expect(again.json.name).toBe('boss'); // a repeat changes nothing
    expect(t.db.prepare(`SELECT COUNT(*) n FROM people WHERE email = ?`).get(SUPER)).toEqual({ n: 1 });
    expect(t.db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action = 'person_self_create'`).get()).toEqual({ n: 1 });
    // /api/me now has a personId and the role is still superadmin
    expect((await t.request('GET', '/api/me', { cookie: sup })).json).toEqual({ email: SUPER, name: 'boss', role: 'superadmin', personId: r.json.id });
  });

  it('a plain POST /api/people with the superadmin email works for the superadmin only, and forces role admin', async () => {
    const t = await setupNudge();
    const sup = await t.loginSuper();
    const r = await t.request('POST', '/api/people', { cookie: sup, body: { email: 'Boss@Example.com', name: 'The Boss', role: 'member' } });
    expect(r.status).toBe(400); // an explicit member role is refused
    const ok = await t.request('POST', '/api/people', { cookie: sup, body: { email: 'Boss@Example.com', name: 'The Boss' } });
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ email: SUPER, name: 'The Boss', role: 'admin' });
    expect((await t.request('POST', '/api/people', { cookie: sup, body: { email: SUPER, name: 'dup' } })).status).toBe(409);
  });

  it('the superadmin can edit their own name and WhatsApp; the role stays admin and sessions survive', async () => {
    const t = await setupNudge();
    const sup = await t.loginSuper();
    const self = (await t.request('POST', '/api/people/self', { cookie: sup, body: {} })).json;
    const r = await t.request('PUT', `/api/people/${self.id}`, { cookie: sup, body: { email: SUPER, name: 'Prakash', whatsapp: '919000000009', notifyTarget: 'dm' } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ name: 'Prakash', whatsapp: '919000000009', role: 'admin', notifyTarget: 'dm' });
    expect((await t.request('GET', '/api/me', { cookie: sup })).json).toMatchObject({ name: 'Prakash', role: 'superadmin', personId: self.id });
  });

  it('the superadmin\'s own tasks work end to end, and ordinary members cannot see them', async () => {
    const t = await setupNudge();
    const mem = t.person('mem@example.com');
    const memC = await t.loginWithCode('mem@example.com');
    const sup = await t.loginSuper();
    const self = (await t.request('POST', '/api/people/self', { cookie: sup, body: {} })).json;
    const id = uuid();
    const created = await t.request('PUT', `/api/app/tasks/${id}`, { cookie: sup, body: { title: 'Review numbers', dueAt: '2026-11-16T05:00:00Z' } });
    expect(created.status).toBe(201);
    expect(created.json.ownerPersonId).toBe(self.id); // defaults to the superadmin's own list
    expect((await t.request('PUT', `/api/app/tasks/${id}`, { cookie: sup, body: { title: 'Review numbers v2', baseVersion: 1 } })).json.version).toBe(2);
    expect((await t.request('POST', `/api/app/tasks/${id}/snooze`, { cookie: sup, body: { minutes: 30 } })).status).toBe(200);
    expect((await t.request('POST', `/api/app/tasks/${id}/done`, { cookie: sup, body: {} })).json.status).toBe('done');
    const owners = (await t.request('GET', '/api/app/owners', { cookie: sup })).json as { id: number; level: string }[];
    expect(owners[0]).toMatchObject({ id: self.id, level: 'edit' }); // the superadmin first
    expect(owners.some((o) => o.id === mem.id)).toBe(true);
    expect((await t.request('GET', `/api/app/tasks?owner=${self.id}`, { cookie: sup })).json.tasks).toHaveLength(1);
    // the member has no grant: the task is invisible
    expect((await t.request('PUT', `/api/app/tasks/${id}`, { cookie: memC, body: { title: 'x', baseVersion: 3 } })).status).toBe(404);
    expect((await t.request('GET', `/api/app/tasks?owner=${self.id}`, { cookie: memC })).status).toBe(403);
    // the superadmin also edits a member's list
    expect((await t.request('PUT', `/api/app/tasks/${uuid()}`, { cookie: sup, body: { title: 'for mem', ownerPersonId: mem.id } })).status).toBe(201);
  });
});

describe('added_by', () => {
  it('is persisted by addAdmin and by people creation, and copied from admin_users when migrating', async () => {
    const db = openDb(':memory:');
    addAdmin(db, { email: 'a@example.com' }, 'boss@example.com', SUPER);
    expect(listAdmins(db)).toMatchObject([{ email: 'a@example.com', addedBy: 'boss@example.com' }]);
    db.exec(`INSERT INTO admin_users (email, role, added_by, created_at) VALUES ('old@example.com','admin','legacy@example.com','2026-01-01T00:00:00.000Z')`);
    db.prepare(`DELETE FROM kv WHERE key = ?`).run(KV_PEOPLE_MIGRATED_AT);
    migrateAdminUsers(db);
    expect(listAdmins(db).find((a) => a.email === 'old@example.com')?.addedBy).toBe('legacy@example.com');
    const t = await setupNudge();
    const sup = await t.loginSuper();
    await t.request('POST', '/api/people', { cookie: sup, body: { email: 'x@example.com', name: 'X', role: 'admin' } });
    expect(listAdmins(t.db).find((a) => a.email === 'x@example.com')?.addedBy).toBe(SUPER);
  });

  it('the column is added to an older people table idempotently', () => {
    const path = tmpFile();
    const db = openDb(path);
    db.exec(`DROP TABLE people`);
    db.exec(`CREATE TABLE people (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, whatsapp TEXT, role TEXT NOT NULL CHECK (role IN ('admin','member')), active INTEGER NOT NULL DEFAULT 1, notify_target TEXT NOT NULL DEFAULT 'default', notify_group_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.close();
    const again = openDb(path);
    expect((again.prepare(`PRAGMA table_info(people)`).all() as { name: string }[]).some((c) => c.name === 'added_by')).toBe(true);
    again.close();
    openDb(path).close();
  });
});

describe('server log message', () => {
  it('the console still logs exactly "admin server listening"', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'info';
    const db = openDb(':memory:');
    const srv = startAdminServer({ db, env: { SUPERADMIN_EMAIL: SUPER, ADMIN_PASSWORD: PASSWORD, ADMIN_TRUST_PROXY: false, ADMIN_COOKIE_SECURE: false } as any,
      whatsapp: {} as any, getLastSyncResult: () => undefined }, 0, '127.0.0.1');
    try {
      await new Promise((r) => srv.once('listening', r));
      expect(spy.mock.calls.some((c) => String(c[0]).includes('"msg":"admin server listening"') && String(c[0]).includes('"module":"admin-server"'))).toBe(true);
    } finally {
      process.env.LOG_LEVEL = prev;
      spy.mockRestore();
      srv.close(); srv.closeAllConnections();
    }
  });
});

describe('reminders console vs Nudge', () => {
  it('a member cannot sign in to the reminders console, and sessions are not shared between products', async () => {
    const t = await setupNudge();
    t.person('mem@example.com');
    t.person('adm@example.com', 'admin');
    const nudgeCookie = await t.loginWithCode('adm@example.com');

    const admin = createAdminServer({
      db: t.db, env: t.env, whatsapp: { async getSessionStatus() { return 'WORKING'; }, async sendGroupMessage() {}, async listGroups() { return []; } },
      getLastSyncResult: () => undefined,
      verifyIdToken: async () => ({ email: 'mem@example.com', email_verified: true }),
    });
    await new Promise<void>((r) => admin.listen(0, '127.0.0.1', r));
    const port = (admin.address() as import('node:net').AddressInfo).port;
    const call = async (path: string, init: RequestInit = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers as object) } });
      return { status: res.status, json: await res.json().catch(() => undefined), headers: res.headers };
    };
    try {
      // member via Google: refused
      expect((await call('/api/auth/google', { method: 'POST', body: JSON.stringify({ credential: 't' }) })).status).toBe(403);
      // a Nudge cookie value under the console cookie name is not a console session
      const token = nudgeCookie.split('=')[1]!;
      expect((await call('/api/closers', { headers: { Cookie: `admin_session=${token}` } })).status).toBe(401);
      // a console login works for the superadmin and is not accepted by Nudge
      const login = await call('/api/auth/password', { method: 'POST', body: JSON.stringify({ email: SUPER, password: PASSWORD }) });
      expect(login.status).toBe(200);
      const adminToken = login.headers.get('set-cookie')!.split(';')[0]!.split('=')[1]!;
      expect((await t.request('GET', '/api/me', { cookie: `nudge_session=${adminToken}` })).status).toBe(401);
      // the console exposes no Nudge routes or email-code login
      const cookie = `admin_session=${adminToken}`;
      for (const p of ['/api/app/tasks', '/api/app/owners', '/api/people', '/api/access-grants', '/api/task-settings']) {
        expect((await call(p, { headers: { Cookie: cookie } })).status, p).toBe(404);
      }
      expect((await call('/api/auth/email-code', { method: 'POST', body: JSON.stringify({ email: 'adm@example.com' }) })).status).toBe(404);
      expect((await call('/api/auth/config')).json).toEqual({ googleClientId: 'client-id', passwordLogin: true });
    } finally {
      admin.close(); admin.closeAllConnections();
    }
  });

  it('Nudge sets its own host-only cookie nudge_session', async () => {
    const t = await setupNudge();
    const r = await t.request('POST', '/api/auth/password', { body: { email: SUPER, password: PASSWORD } });
    const c = r.headers['set-cookie']![0]!;
    expect(c).toMatch(/^nudge_session=[\w-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200$/);
    expect(c).not.toMatch(/Domain=/i);
  });
});
