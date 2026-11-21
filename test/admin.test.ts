import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RATE_LIMIT_FAILURES, SESSION_TTL_MS, type VerifyIdToken } from '../src/admin/auth.js';
import { createAdminServer } from '../src/admin/server.js';
import { openDb } from '../src/db.js';
import { addAdmin } from '../src/store.js';

beforeAll(() => {
  process.env.LOG_LEVEL = 'error';
});

const SUPER = 'admin@example.com';
const PASSWORD = 'correct-horse-battery';
const env = {
  SUPERADMIN_EMAIL: SUPER, ADMIN_PASSWORD: PASSWORD, GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  ADMIN_TRUST_PROXY: false, ADMIN_COOKIE_SECURE: false,
};

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string; json: any }

const servers: http.Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) { s.close(); s.closeAllConnections(); } });

async function setup(opts: { verifyIdToken?: VerifyIdToken; env?: Partial<typeof env>; whatsapp?: Record<string, unknown> } = {}) {
  const db = openDb(':memory:');
  let nowMs = Date.parse('2026-11-16T03:00:00.000Z');
  const sent: { groupId: string; text: string; mentions: string[] }[] = [];
  const server = createAdminServer({
    db, env: { ...env, ...opts.env },
    whatsapp: {
      async getSessionStatus() { return 'WORKING'; },
      async sendGroupMessage(groupId, text, mentions) { sent.push({ groupId, text, mentions }); },
      async listGroups() { return [{ id: '1@g.us', name: 'G' }]; },
      ...(opts.whatsapp as object),
    },
    getLastSyncResult: () => undefined,
    serviceAccountEmail: 'sa@proj.iam.gserviceaccount.com',
    verifyIdToken: opts.verifyIdToken,
    now: () => new Date(nowMs),
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  const request = (method: string, path: string, o: { body?: unknown; cookie?: string; headers?: Record<string, string>; json?: boolean } = {}) =>
    new Promise<Res>((resolve, reject) => {
      const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
      const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...(o.headers ?? {}) };
      if (o.json !== false && method !== 'GET') headers['Content-Type'] = 'application/json';
      if (payload !== undefined) headers['Content-Length'] = String(Buffer.byteLength(payload));
      if (o.cookie) headers.Cookie = o.cookie;
      const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let json: any;
          try { json = JSON.parse(body); } catch { /* not json */ }
          resolve({ status: res.statusCode!, headers: res.headers, body, json });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });

  const cookieOf = (r: Res) => (r.headers['set-cookie']?.[0] ?? '').split(';')[0]!;
  const login = async () => {
    const r = await request('POST', '/api/auth/password', { body: { email: SUPER, password: PASSWORD } });
    expect(r.status).toBe(200);
    return cookieOf(r);
  };
  return { db, port, request, login, cookieOf, sent, advance: (ms: number) => { nowMs += ms; } };
}

describe('password login', () => {
  it('succeeds for the superadmin (case-insensitive) and sets a hardened cookie', async () => {
    const t = await setup();
    const r = await t.request('POST', '/api/auth/password', { body: { email: 'ADMIN@Example.com', password: PASSWORD } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ email: SUPER, role: 'superadmin' });
    const cookie = r.headers['set-cookie']![0]!;
    expect(cookie).toMatch(/^admin_session=[\w-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=10800$/);
    // Only the hash is stored.
    const token = cookie.split(';')[0]!.split('=')[1]!;
    const rows = t.db.prepare(`SELECT token_hash FROM admin_sessions`).all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(token);
    const me = await t.request('GET', '/api/me', { cookie: t.cookieOf(r) });
    expect(me.json).toEqual({ email: SUPER, role: 'superadmin' });
  });

  it('rejects a wrong password and a non-superadmin email', async () => {
    const t = await setup();
    expect((await t.request('POST', '/api/auth/password', { body: { email: SUPER, password: 'wrong-password-123' } })).status).toBe(401);
    expect((await t.request('POST', '/api/auth/password', { body: { email: 'other@example.com', password: PASSWORD } })).status).toBe(401);
  });

  it('returns 429 after 5 failures, even for the correct password', async () => {
    const t = await setup();
    for (let i = 0; i < RATE_LIMIT_FAILURES; i++) {
      expect((await t.request('POST', '/api/auth/password', { body: { email: SUPER, password: 'nope-nope-nope' } })).status).toBe(401);
    }
    expect((await t.request('POST', '/api/auth/password', { body: { email: SUPER, password: PASSWORD } })).status).toBe(429);
    t.advance(16 * 60_000);
    expect((await t.request('POST', '/api/auth/password', { body: { email: SUPER, password: PASSWORD } })).status).toBe(200);
  });
});

describe('google login', () => {
  const verifier = (payload: { email?: string; email_verified?: boolean } | Error): VerifyIdToken => async (_t, aud) => {
    expect(aud).toBe('client-id');
    if (payload instanceof Error) throw payload;
    return payload;
  };

  it('allows the superadmin and a stored admin', async () => {
    const t = await setup({ verifyIdToken: verifier({ email: 'Boss@Example.com', email_verified: true }) });
    addAdmin(t.db, { email: 'boss@example.com' }, SUPER, SUPER);
    const r = await t.request('POST', '/api/auth/google', { body: { credential: 'tok' } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ email: 'boss@example.com', role: 'admin' });
  });

  it('refuses unknown emails and unverified emails with 403', async () => {
    const unknown = await setup({ verifyIdToken: verifier({ email: 'stranger@example.com', email_verified: true }) });
    const r1 = await unknown.request('POST', '/api/auth/google', { body: { credential: 'tok' } });
    expect(r1.status).toBe(403);
    expect(r1.json.error).toBe('not authorised');
    const unverified = await setup({ verifyIdToken: verifier({ email: SUPER, email_verified: false }) });
    expect((await unverified.request('POST', '/api/auth/google', { body: { credential: 'tok' } })).status).toBe(403);
    const bad = await setup({ verifyIdToken: verifier(new Error('bad signature')) });
    expect((await bad.request('POST', '/api/auth/google', { body: { credential: 'tok' } })).status).toBe(401);
  });
});

describe('sessions', () => {
  it('requires a session, expires after 3 h (superadmin), and logout deletes it', async () => {
    const t = await setup();
    expect((await t.request('GET', '/api/closers')).status).toBe(401);
    const cookie = await t.login();
    expect((await t.request('GET', '/api/closers', { cookie })).status).toBe(200);
    t.advance(SESSION_TTL_MS + 1000);
    expect((await t.request('GET', '/api/closers', { cookie })).status).toBe(401);

    const cookie2 = await t.login();
    const out = await t.request('POST', '/api/auth/logout', { cookie: cookie2, body: {} });
    expect(out.status).toBe(200);
    expect(out.headers['set-cookie']![0]).toContain('Max-Age=0');
    expect((await t.request('GET', '/api/closers', { cookie: cookie2 })).status).toBe(401);
    expect(t.db.prepare(`SELECT COUNT(*) AS n FROM admin_sessions`).get()).toEqual({ n: 0 });
  });

  it('a removed admin loses access immediately', async () => {
    const t = await setup({ verifyIdToken: async () => ({ email: 'boss@example.com', email_verified: true }) });
    const superCookie = await t.login();
    expect((await t.request('POST', '/api/admins', { cookie: superCookie, body: { email: 'boss@example.com' } })).status).toBe(201);
    const adminCookie = t.cookieOf(await t.request('POST', '/api/auth/google', { body: { credential: 'x' } }));
    expect((await t.request('GET', '/api/closers', { cookie: adminCookie })).status).toBe(200);
    expect((await t.request('DELETE', '/api/admins/boss%40example.com', { cookie: superCookie, body: {} })).status).toBe(200);
    expect((await t.request('GET', '/api/closers', { cookie: adminCookie })).status).toBe(401);
  });
});

describe('csrf', () => {
  it('rejects a wrong Origin and a non-JSON POST', async () => {
    const t = await setup();
    const wrongOrigin = await t.request('POST', '/api/auth/password', {
      body: { email: SUPER, password: PASSWORD }, headers: { Origin: 'https://evil.example' },
    });
    expect(wrongOrigin.status).toBe(403);
    const nonJson = await t.request('POST', '/api/auth/password', {
      body: { email: SUPER, password: PASSWORD }, headers: { 'Content-Type': 'text/plain' }, json: false,
    });
    expect(nonJson.status).toBe(403);
    const cookie = await t.login();
    expect((await t.request('POST', '/api/closers', { cookie, body: {}, headers: { Origin: 'http://evil.test' } })).status).toBe(403);
  });

  it('accepts a matching Origin', async () => {
    const t = await setup();
    const host = '127.0.0.1:1';
    const r = await t.request('POST', '/api/auth/password', {
      body: { email: SUPER, password: PASSWORD }, headers: { Host: host, Origin: `http://${host}` },
    });
    expect(r.status).toBe(200);
  });
});

describe('roles', () => {
  it('an admin gets 403 on /api/admins but can manage closers', async () => {
    const t = await setup({ verifyIdToken: async () => ({ email: 'boss@example.com', email_verified: true }) });
    addAdmin(t.db, { email: 'boss@example.com' }, SUPER, SUPER);
    const cookie = t.cookieOf(await t.request('POST', '/api/auth/google', { body: { credential: 'x' } }));
    expect((await t.request('GET', '/api/admins', { cookie })).status).toBe(403);
    expect((await t.request('POST', '/api/admins', { cookie, body: { email: 'x@example.com' } })).status).toBe(403);
    expect((await t.request('DELETE', '/api/admins/x%40example.com', { cookie, body: {} })).status).toBe(403);
    expect((await t.request('GET', '/api/me', { cookie })).json.role).toBe('admin');
    expect((await t.request('GET', '/api/closers', { cookie })).status).toBe(200);
  });

  it('the superadmin cannot be added or removed', async () => {
    const t = await setup();
    const cookie = await t.login();
    expect((await t.request('POST', '/api/admins', { cookie, body: { email: SUPER } })).status).toBe(400);
    expect((await t.request('DELETE', '/api/admins/' + encodeURIComponent(SUPER), { cookie, body: {} })).status).toBe(400);
  });
});

describe('http level', () => {
  it('serves config for the login screen without a session', async () => {
    const t = await setup();
    expect((await t.request('GET', '/api/auth/config')).json).toEqual({ googleClientId: 'client-id', passwordLogin: true });
  });

  it('cruds a closer and a client, writes audit rows, tests a message, settings and status', async () => {
    const t = await setup();
    const cookie = await t.login();

    const created = await t.request('POST', '/api/closers', { cookie, body: { name: 'Asha', email: 'ASHA@example.com', whatsapp: '+91 90000 00001' } });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ email: 'asha@example.com', whatsapp: '919000000001', active: true });
    const id = created.json.id;
    const dup = await t.request('POST', '/api/closers', { cookie, body: { name: 'B', email: 'asha@example.com', whatsapp: '919000000002' } });
    expect(dup.status).toBe(409);
    expect(dup.json.fields).toHaveProperty('email');
    const bad = await t.request('POST', '/api/closers', { cookie, body: { name: '', email: 'x', whatsapp: '1' } });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.json.fields).sort()).toEqual(['email', 'name', 'whatsapp']);
    expect((await t.request('PUT', `/api/closers/${id}`, { cookie, body: { name: 'Asha K', email: 'asha@example.com', whatsapp: '919000000001' } })).json.name).toBe('Asha K');

    const client = await t.request('POST', '/api/clients', { cookie, body: { name: 'Client A', calendarId: 'a@gmail.com', whatsappGroupId: '1@g.us' } });
    expect(client.status).toBe(201);
    expect((await t.request('POST', '/api/clients', { cookie, body: { name: 'Dup', calendarId: 'a@gmail.com', whatsappGroupId: '1@g.us' } })).status).toBe(409);

    // Test message goes to the client's group with no mentions.
    expect((await t.request('POST', `/api/clients/${client.json.id}/test-message`, { cookie, body: {} })).status).toBe(200);
    expect(t.sent).toEqual([{ groupId: '1@g.us', text: expect.stringContaining('Test message from Pushup reminders'), mentions: [] }]);
    expect((await t.request('POST', '/api/clients/999/test-message', { cookie, body: {} })).status).toBe(404);

    const settings = await t.request('PUT', '/api/settings', { cookie, body: { reminderOffsets: [5, 90] } });
    expect(settings.json.reminderOffsets).toEqual([90, 5]);
    expect((await t.request('PUT', '/api/settings', { cookie, body: { reminderOffsets: [0] } })).status).toBe(400);
    expect((await t.request('GET', '/api/settings', { cookie })).json.updatedAt).toBe(settings.json.updatedAt);

    const groups = await t.request('GET', '/api/whatsapp/groups', { cookie });
    expect(groups.json).toEqual([{ id: '1@g.us', name: 'G' }]);

    const status = await t.request('GET', '/api/status', { cookie });
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ serviceAccountEmail: 'sa@proj.iam.gserviceaccount.com', sync: null, upcoming: [], recentReminders: [] });
    expect(status.json.health.waha.status).toBe('WORKING');

    // Soft delete, then hard delete.
    expect((await t.request('DELETE', `/api/closers/${id}`, { cookie, body: {} })).status).toBe(200);
    expect((await t.request('GET', '/api/closers', { cookie })).json[0].active).toBe(false);
    expect((await t.request('DELETE', `/api/closers/${id}?hard=1`, { cookie, body: {} })).status).toBe(200);
    expect((await t.request('GET', '/api/closers', { cookie })).json).toEqual([]);

    const audit = (await t.request('GET', '/api/audit', { cookie })).json as { actor: string; action: string }[];
    const actions = audit.map((a) => a.action).reverse();
    expect(actions).toEqual([
      'login', 'closer_create', 'closer_update', 'client_create', 'send_test_message', 'settings_update',
      'closer_disable', 'closer_hard_delete',
    ]);
    expect(audit.every((a) => a.actor === SUPER)).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(PASSWORD);
  });

  it('serves static files and 404s everything else including path traversal', async () => {
    const t = await setup();
    const index = await t.request('GET', '/');
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toContain('text/html');
    expect(index.headers['cache-control']).toBe('no-store');
    const js = await t.request('GET', '/app.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toContain('text/javascript');
    expect((await t.request('GET', '/styles.css')).headers['content-type']).toContain('text/css');
    const icons = await t.request('GET', '/icons.svg');
    expect(icons.status).toBe(200);
    expect(icons.headers['content-type']).toContain('image/svg+xml');
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/../../etc/passwd', '/nothing.js', '/other.svg', '/icons.svg/x', '/public/admin/app.js']) {
      expect((await t.request('GET', path)).status, path).toBe(404);
    }
  });

  it('sets security headers on every response', async () => {
    const t = await setup();
    for (const path of ['/', '/app.js', '/nope', '/api/me', '/api/auth/config']) {
      const r = await t.request('GET', path);
      expect(r.headers['x-content-type-options'], path).toBe('nosniff');
      expect(r.headers['referrer-policy'], path).toBe('same-origin');
      expect(r.headers['x-frame-options'], path).toBe('DENY');
      expect(r.headers['content-security-policy'], path).toContain('https://accounts.google.com');
    }
  });
});

describe('robustness', () => {
  const raw = (port: number, data: string) =>
    new Promise<string>((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => sock.write(data));
      let out = '';
      sock.on('data', (c) => (out += c));
      sock.on('close', () => resolve(out));
      sock.on('error', () => resolve(out));
      setTimeout(() => sock.destroy(), 1500);
    });

  it('answers 400 to a malformed request URL and keeps serving', async () => {
    const t = await setup();
    const out = await raw(t.port, 'GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n');
    expect(out).toMatch(/^HTTP\/1\.1 400 /);
    expect((await t.request('GET', '/api/auth/config')).status).toBe(200);
  });

  it('returns 413 for a 200 KB body, authenticated and unauthenticated', async () => {
    const t = await setup();
    const big = { name: 'x'.repeat(200 * 1024) };
    const unauth = await t.request('POST', '/api/auth/password', { body: big });
    expect(unauth.status).toBe(413);
    const cookie = await t.login();
    const authed = await t.request('POST', '/api/closers', { cookie, body: big });
    expect(authed.status).toBe(413);
    expect(authed.json.error).toMatch(/too large/);
    expect((await t.request('GET', '/api/auth/config')).status).toBe(200);
  });

  it('413 also when streaming without a Content-Length (chunked)', async () => {
    const t = await setup();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: t.port, method: 'POST', path: '/api/auth/password', headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${t.port}` } },
        (res) => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject);
      req.write('"' + 'x'.repeat(150 * 1024));
      req.end('"');
    });
    expect(status).toBe(413);
  });

  it('never logs the library message of a failed Google verification', async () => {
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'debug';
    const lines: string[] = [];
    const spies = [vi.spyOn(console, 'error'), vi.spyOn(console, 'log')].map((s) => s.mockImplementation((l: unknown) => { lines.push(String(l)); }));
    try {
      const secret = 'eyJFAKE.TOKEN.payload alice@example.com';
      const t = await setup({ verifyIdToken: async () => { throw new Error(`Wrong recipient, payload audience != requiredAudience ${secret}`); } });
      expect((await t.request('POST', '/api/auth/google', { body: { credential: 'tok' } })).status).toBe(401);
      const out = lines.join('\n');
      expect(out).toContain('google id token rejected');
      expect(out).toContain('wrong_audience');
      expect(out).not.toContain('eyJFAKE');
      expect(out).not.toContain('alice@example.com');
    } finally {
      spies.forEach((s) => s.mockRestore());
      if (prev === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = prev;
    }
  });
});

describe('proxy and HSTS', () => {
  it('with ADMIN_TRUST_PROXY the rate limit keys on the last X-Forwarded-For entry', async () => {
    const t = await setup({ env: { ADMIN_TRUST_PROXY: true } });
    for (let i = 0; i < RATE_LIMIT_FAILURES; i++) {
      const r = await t.request('POST', '/api/auth/password', {
        body: { email: SUPER, password: 'nope-nope-nope' }, headers: { 'X-Forwarded-For': `10.0.0.${i}, 203.0.113.9` },
      });
      expect(r.status).toBe(401);
    }
    const blocked = await t.request('POST', '/api/auth/password', {
      body: { email: SUPER, password: PASSWORD }, headers: { 'X-Forwarded-For': '10.9.9.9, 203.0.113.9' },
    });
    expect(blocked.status).toBe(429);
    // A different proxy-seen address is unaffected.
    const other = await t.request('POST', '/api/auth/password', {
      body: { email: SUPER, password: PASSWORD }, headers: { 'X-Forwarded-For': '10.9.9.9, 198.51.100.1' },
    });
    expect(other.status).toBe(200);
  });

  it('sends HSTS only when ADMIN_COOKIE_SECURE=true', async () => {
    const plain = await setup();
    expect((await plain.request('GET', '/api/auth/config')).headers['strict-transport-security']).toBeUndefined();
    const secure = await setup({ env: { ADMIN_COOKIE_SECURE: true } });
    expect((await secure.request('GET', '/api/auth/config')).headers['strict-transport-security']).toBe('max-age=31536000');
  });
});

describe('WhatsApp session management (superadmin only)', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const KEY = 'secret-waha-key';
  function mock(status = 'WORKING') {
    const calls: string[] = [];
    const wa = {
      async getSession() { calls.push('session'); return { status, me: { phone: '919000000001', name: 'Co' } }; },
      async getQrPng() { calls.push('qr'); return PNG; },
      async startSession() { calls.push('start'); },
      async restartSession() { calls.push('restart'); },
      async logoutSession() { calls.push('logout'); },
      async requestPairingCode(n: string) { calls.push('pair:' + n); return 'ABCD-EFGH'; },
    };
    return { calls, wa };
  }
  it('returns 403 to a non-superadmin on every management route', async () => {
    const { wa } = mock();
    const verifyIdToken: VerifyIdToken = async () => ({ email: 'adm@example.com', email_verified: true });
    const t = await setup({ whatsapp: wa, verifyIdToken });
    addAdmin(t.db, { email: 'adm@example.com' }, SUPER, SUPER);
    const login = await t.request('POST', '/api/auth/google', { body: { credential: 'tok' } });
    expect(login.status).toBe(200);
    const cookie = t.cookieOf(login);
    for (const [m, path] of [['GET', 'session'], ['GET', 'qr'], ['POST', 'start'], ['POST', 'restart'], ['POST', 'logout'], ['POST', 'switch-number'], ['POST', 'pairing-code']] as const) {
      expect((await t.request(m, '/api/whatsapp/' + path, { cookie, body: m === 'POST' ? { confirm: true, phoneNumber: '919876543210' } : undefined })).status, path).toBe(403);
    }
    expect((await t.request('GET', '/api/whatsapp/groups', { cookie })).status).toBe(200);
  });

  it('GET session returns status, label and linked number', async () => {
    const t = await setup({ whatsapp: mock().wa });
    const r = await t.request('GET', '/api/whatsapp/session', { cookie: await t.login() });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'WORKING', label: 'Connected', me: { phone: '919000000001', name: 'Co' } });
  });

  it('switch-number needs confirm:true, then logs out, starts and audits', async () => {
    const m = mock();
    const t = await setup({ whatsapp: m.wa });
    const cookie = await t.login();
    expect((await t.request('POST', '/api/whatsapp/switch-number', { cookie, body: {} })).status).toBe(400);
    expect((await t.request('POST', '/api/whatsapp/switch-number', { cookie, body: { confirm: 'yes' } })).status).toBe(400);
    expect((await t.request('POST', '/api/whatsapp/logout', { cookie, body: {} })).status).toBe(400);
    expect(m.calls).toEqual([]);
    expect((await t.request('POST', '/api/whatsapp/switch-number', { cookie, body: { confirm: true } })).status).toBe(200);
    expect(m.calls).toEqual(['logout', 'start']);
    const audit = (await t.request('GET', '/api/audit', { cookie })).json as { action: string; actor: string }[];
    expect(audit.find((a) => a.action === 'whatsapp_switch_number')?.actor).toBe(SUPER);
  });

  it('invalidates the groups cache after switch-number', async () => {
    let listed = 0;
    const t = await setup({ whatsapp: { ...mock().wa, async listGroups() { listed++; return [{ id: '1@g.us', name: 'G' }]; } } });
    const cookie = await t.login();
    await t.request('GET', '/api/whatsapp/groups', { cookie });
    await t.request('GET', '/api/whatsapp/groups', { cookie });
    expect(listed).toBe(1);
    await t.request('POST', '/api/whatsapp/switch-number', { cookie, body: { confirm: true } });
    await t.request('GET', '/api/whatsapp/groups', { cookie });
    expect(listed).toBe(2);
  });

  it('qr is 409 unless SCAN_QR_CODE, then image/png with no-store', async () => {
    const t1 = await setup({ whatsapp: mock('WORKING').wa });
    const r1 = await t1.request('GET', '/api/whatsapp/qr', { cookie: await t1.login() });
    expect(r1.status).toBe(409);
    expect(r1.json).toEqual({ error: 'not waiting for QR' });
    const t2 = await setup({ whatsapp: mock('SCAN_QR_CODE').wa });
    const r2 = await t2.request('GET', '/api/whatsapp/qr', { cookie: await t2.login() });
    expect(r2.status).toBe(200);
    expect(r2.headers['content-type']).toBe('image/png');
    expect(r2.headers['cache-control']).toBe('no-store');
  });

  it('start and restart pass through and are audited', async () => {
    const m = mock('STOPPED');
    const t = await setup({ whatsapp: m.wa });
    const cookie = await t.login();
    expect((await t.request('POST', '/api/whatsapp/start', { cookie, body: {} })).status).toBe(200);
    expect((await t.request('POST', '/api/whatsapp/restart', { cookie, body: {} })).status).toBe(200);
    expect(m.calls).toEqual(['start', 'restart']);
    const actions = ((await t.request('GET', '/api/audit', { cookie })).json as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['whatsapp_start', 'whatsapp_restart']));
  });

  it('turns WAHA errors into 502 without leaking the API key', async () => {
    const m = mock();
    const t = await setup({ whatsapp: { ...m.wa, async getSession() { throw new Error('WAHA session info failed: HTTP 500'); }, async startSession() { throw new Error('boom'); } } });
    const cookie = await t.login();
    const r = await t.request('GET', '/api/whatsapp/session', { cookie });
    expect(r.status).toBe(502);
    expect((await t.request('POST', '/api/whatsapp/start', { cookie, body: {} })).status).toBe(502);
    expect(r.body).not.toContain(KEY);
  });

  it('validates the pairing-code phone number', async () => {
    const m = mock();
    const t = await setup({ whatsapp: m.wa });
    const cookie = await t.login();
    for (const bad of ['', 'abc', '12345', '0919876543210', '9198765432101234']) {
      const r = await t.request('POST', '/api/whatsapp/pairing-code', { cookie, body: { phoneNumber: bad } });
      expect(r.status, bad).toBe(400);
      expect(r.json.fields.phoneNumber).toBeTruthy();
    }
    const ok = await t.request('POST', '/api/whatsapp/pairing-code', { cookie, body: { phoneNumber: '+91 98765-43210' } });
    expect(ok.json).toEqual({ code: 'ABCD-EFGH' });
    expect(m.calls).toEqual(['pair:919876543210']);
  });

  it('switch-number: logout ok but start fails gives 502 and an audit row with startOk:false; confirm:1 is rejected', async () => {
    const m = mock();
    const t = await setup({ whatsapp: { ...m.wa, async startSession() { throw new Error('boom'); } } });
    const cookie = await t.login();
    expect((await t.request('POST', '/api/whatsapp/switch-number', { cookie, body: { confirm: 1 } })).status).toBe(400);
    expect((await t.request('POST', '/api/whatsapp/switch-number', { cookie, body: { confirm: true } })).status).toBe(502);
    const rows = (await t.request('GET', '/api/audit', { cookie })).json as { action: string; details: unknown }[];
    expect(rows.find((a) => a.action === 'whatsapp_switch_number')?.details).toEqual({ logoutOk: true, startOk: false });
  });

  it('does not cache an empty groups list', async () => {
    let listed = 0;
    const t = await setup({ whatsapp: { ...mock().wa, async listGroups() { listed++; return []; } } });
    const cookie = await t.login();
    await t.request('GET', '/api/whatsapp/groups', { cookie });
    await t.request('GET', '/api/whatsapp/groups', { cookie });
    expect(listed).toBe(2);
  });
});
