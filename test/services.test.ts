import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { envSchema } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createPerson } from '../src/people.js';
import { type ServiceHandle, startRemindersService, startTasksService } from '../src/services.js';
import { PASSWORD, SUPER } from './helpers/nudge.js';

const dir = mkdtempSync(join(tmpdir(), 'roles-test-'));

beforeAll(() => {
  process.env.LOG_LEVEL = 'error';
  process.env.CONFIG_PATH = join(dir, 'no-such-config.json'); // never import the real config.json
});

const handles: ServiceHandle[] = [];
afterEach(async () => { for (const h of handles.splice(0)) await h.stop(); });

const baseEnv = {
  SUPERADMIN_EMAIL: SUPER, ADMIN_PASSWORD: PASSWORD, ADMIN_COOKIE_SECURE: false, ADMIN_TRUST_PROXY: false,
  HEALTH_PORT: 0, ADMIN_PORT: 0, ADMIN_HOST: '127.0.0.1', TASKS_PORT: 0, TASKS_HOST: '127.0.0.1', TASKS_HEALTH_PORT: 0, APP_NAME: 'Nudge',
} as any;

function mocks() {
  const sent: string[] = [];
  const whatsapp = {
    async getSessionStatus() { return 'WORKING'; },
    async sendGroupMessage(_g: string, t: string) { sent.push(t); },
    async sendDirectMessage(_c: string, t: string) { sent.push(t); },
    async listGroups() { return []; },
  } as any;
  const scheduled: string[] = [];
  const schedule = (expr: string) => { scheduled.push(expr); return { stop() {} }; };
  return { whatsapp, sent, scheduled, schedule, alerts: { async send() {}, async sendTo() {} } as any };
}

const portOf = async (s: import('node:http').Server) => {
  if (!s.listening) await new Promise((r) => s.once('listening', r));
  return (s.address() as AddressInfo).port;
};
const get = async (port: number, path: string, cookie?: string) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
  return { status: res.status, json: await res.json().catch(() => undefined) };
};

describe('service roles', () => {
  it('reminders role: starts sync, reminders and monitor only, and exposes no Nudge routes', async () => {
    const m = mocks();
    const db = openDb(join(dir, 'a.db'));
    const h = await startRemindersService(baseEnv, { db, whatsapp: m.whatsapp, alerts: m.alerts, calendar: {} as any, clientEmail: 'sa@x.iam', schedule: m.schedule });
    handles.push(h);
    expect(h.role).toBe('reminders');
    expect(h.jobs).toEqual(['sync', 'reminders', 'monitor']);
    expect(h.jobs).not.toContain('task-nudges');
    expect(m.scheduled).toHaveLength(3);
    const admin = h.servers[1]!;
    const login = await fetch(`http://127.0.0.1:${(await portOf(admin))}/api/auth/password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: SUPER, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect(cookie.startsWith('admin_session=')).toBe(true);
    for (const p of ['/api/app/tasks', '/api/app/owners', '/api/people', '/api/access-grants', '/api/task-settings']) {
      expect((await get((await portOf(admin)), p, cookie)).status, p).toBe(404);
    }
    expect((await get((await portOf(admin)), '/api/closers', cookie)).status).toBe(200);
    // the nudge job never ran: no digests, no nudge tables touched
    expect(db.prepare(`SELECT COUNT(*) n FROM task_digests`).get()).toEqual({ n: 0 });
  });

  it('tasks role: starts only the nudge job; the reminder, sync and monitor jobs are not started', async () => {
    const m = mocks();
    const db = openDb(join(dir, 'b.db'));
    const h = await startTasksService(baseEnv, { db, whatsapp: m.whatsapp, mailer: m.alerts, schedule: m.schedule });
    handles.push(h);
    expect(h.role).toBe('tasks');
    expect(h.jobs).toEqual(['task-nudges']);
    for (const j of ['sync', 'reminders', 'monitor']) expect(h.jobs).not.toContain(j);
    expect(m.scheduled).toHaveLength(1);
    // no config.json import, no calendar work: the call-reminder tables stay empty
    expect(db.prepare(`SELECT COUNT(*) n FROM clients`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) n FROM events`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT value FROM kv WHERE key = 'last_successful_sync'`).get()).toBeUndefined();

    const [health, nudge] = h.servers;
    const hr = await get((await portOf(health!)), '/health');
    expect(hr.status).toBe(200);
    expect(hr.json).toMatchObject({ ok: true, waha: { status: 'WORKING' }, nudgeOk: true });
    expect(hr.json.lastNudgeRun).toBeTruthy();
    // Nudge API is there, the console API is not
    expect((await get((await portOf(nudge!)), '/api/app/tasks')).status).toBe(401);
    const login = await fetch(`http://127.0.0.1:${(await portOf(nudge!))}/api/auth/password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: SUPER, password: PASSWORD }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect(cookie.startsWith('nudge_session=')).toBe(true);
    for (const p of ['/api/closers', '/api/clients', '/api/status', '/api/whatsapp/session', '/api/admins']) {
      expect((await get((await portOf(nudge!)), p, cookie)).status, p).toBe(404);
    }
    expect((await get((await portOf(nudge!)), '/')).status).toBe(200);
    expect((await get((await portOf(nudge!)), '/secret.js')).status).toBe(404); // static whitelist
  });

  it('the tasks role health is 503 when WAHA is not WORKING', async () => {
    const m = mocks();
    m.whatsapp.getSessionStatus = async () => { throw new Error('down'); };
    const db = openDb(join(dir, 'c.db'));
    const h = await startTasksService(baseEnv, { db, whatsapp: m.whatsapp, mailer: m.alerts, schedule: m.schedule });
    handles.push(h);
    const hr = await get((await portOf(h.servers[0]!)), '/health');
    expect(hr.status).toBe(503);
    expect(hr.json.waha.status).toBe('UNREACHABLE');
  });

  it('both roles can start against one database file, and the nudge job works while the reminders role runs', async () => {
    const path = join(dir, 'shared.db');
    const dbA = openDb(path);
    const dbB = openDb(path); // second process opening the same file
    const ma = mocks();
    const mb = mocks();
    handles.push(await startRemindersService(baseEnv, { db: dbA, whatsapp: ma.whatsapp, alerts: ma.alerts, calendar: {} as any, clientEmail: 'sa@x.iam', schedule: ma.schedule }));
    handles.push(await startTasksService(baseEnv, { db: dbB, whatsapp: mb.whatsapp, mailer: mb.alerts, schedule: mb.schedule }));
    // a person created by the Nudge side is visible to the reminders side (shared people directory)
    createPerson(dbB, { email: 'adm@example.com', name: 'Adm', role: 'admin' });
    const roles = dbA.prepare(`SELECT role FROM people WHERE email = 'adm@example.com'`).get();
    expect(roles).toEqual({ role: 'admin' });
    expect(ma.scheduled).toHaveLength(3);
    expect(mb.scheduled).toHaveLength(1);
  });
});

describe('role-aware env validation', () => {
  const base = {
    WAHA_URL: 'http://127.0.0.1:3000', WAHA_SESSION: 'default', WAHA_API_KEY: 'k', ALERT_EMAIL_TO: 'ops@example.com',
    SMTP_HOST: 'h', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: 'p', SUPERADMIN_EMAIL: 'boss@example.com', ADMIN_PASSWORD: 'a-long-password-12',
  };

  it('reminders (default) still requires the Google key; tasks does not', () => {
    expect(envSchema.safeParse(base).success).toBe(false);
    expect(envSchema.safeParse({ ...base, SERVICE_ROLE: 'reminders' }).success).toBe(false);
    const tasks = envSchema.safeParse({ ...base, SERVICE_ROLE: 'tasks' });
    expect(tasks.success).toBe(true);
    if (tasks.success) {
      expect(tasks.data).toMatchObject({ APP_NAME: 'Nudge', TASKS_PORT: 8082, TASKS_HOST: '127.0.0.1', TASKS_HEALTH_PORT: 8083 });
      expect(tasks.data.TASKS_PUBLIC_URL).toBeUndefined();
    }
  });

  it('tasks still needs WAHA, SMTP and a superadmin; TASKS_PUBLIC_URL is validated and normalised', () => {
    const t = { ...base, SERVICE_ROLE: 'tasks' };
    for (const k of ['WAHA_URL', 'WAHA_API_KEY', 'SMTP_HOST', 'SMTP_PASS', 'ALERT_EMAIL_TO', 'SUPERADMIN_EMAIL']) {
      expect(envSchema.safeParse({ ...t, [k]: undefined }).success, k).toBe(false);
    }
    expect(envSchema.safeParse({ ...t, SERVICE_ROLE: 'bogus' }).success).toBe(false);
    expect(envSchema.safeParse({ ...t, TASKS_PUBLIC_URL: 'nudge.example.com' }).success).toBe(false);
    const ok = envSchema.safeParse({ ...t, TASKS_PUBLIC_URL: 'https://nudge.grittaai.com/', APP_NAME: 'Pings' });
    expect(ok.success && ok.data.TASKS_PUBLIC_URL).toBe('https://nudge.grittaai.com');
    expect(ok.success && ok.data.APP_NAME).toBe('Pings');
  });
});
