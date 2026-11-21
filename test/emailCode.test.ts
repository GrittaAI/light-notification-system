import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ADMIN_SESSION_TTL_MS, CODE_MAX_ATTEMPTS, CODE_TTL_MS, CODE_VERIFY_IP_LIMIT, MEMBER_SESSION_TTL_MS, SESSION_TTL_MS } from '../src/admin/auth.js';
import { setupNudge, SUPER } from './helpers/nudge.js';

beforeAll(() => { process.env.LOG_LEVEL = 'error'; });

const tick = () => new Promise((r) => setTimeout(r, 5));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function ask(t: Awaited<ReturnType<typeof setupNudge>>, email: string, headers: Record<string, string> = {}) {
  const r = await t.request('POST', '/api/auth/email-code', { body: { email }, headers });
  await tick();
  return r;
}

describe('email code login', () => {
  it('emails a 6-digit code (subject, plain text, code only) and signs in', async () => {
    const t = await setupNudge();
    t.person('mem@example.com');
    const r = await ask(t, 'Mem@Example.com');
    expect(r.status).toBe(200);
    expect(t.mails).toHaveLength(1);
    const mail = t.mails[0]!;
    expect(mail.to).toBe('mem@example.com');
    expect(mail.subject).toBe('Your Nudge sign-in code');
    expect(mail.text).toMatch(/^\d{6}$/);
    // only the hash is stored
    const row = t.db.prepare(`SELECT code_hash FROM login_codes`).get() as { code_hash: string };
    expect(row.code_hash).toBe(sha(mail.text));
    const v = await t.request('POST', '/api/auth/email-code/verify', { body: { email: 'mem@example.com', code: mail.text } });
    expect(v.status).toBe(200);
    expect(v.json).toEqual({ email: 'mem@example.com', role: 'member' });
    // single use
    expect((await t.request('POST', '/api/auth/email-code/verify', { body: { email: 'mem@example.com', code: mail.text } })).status).toBe(401);
  });

  it('works for the superadmin (3 h session)', async () => {
    const t = await setupNudge();
    await ask(t, SUPER);
    const v = await t.request('POST', '/api/auth/email-code/verify', { body: { email: SUPER, code: t.mails[0]!.text } });
    expect(v.status).toBe(200);
    expect(v.json.role).toBe('superadmin');
    expect(v.headers['set-cookie']![0]).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
  });

  it('a wrong code is rejected; the code is invalidated after 5 wrong attempts', async () => {
    const t = await setupNudge();
    t.person('mem@example.com');
    await ask(t, 'mem@example.com');
    const good = t.mails[0]!.text;
    const wrong = good === '000000' ? '111111' : '000000';
    expect((await t.request('POST', '/api/auth/email-code/verify', { body: { email: 'mem@example.com', code: wrong } })).status).toBe(401);
    for (let i = 1; i < CODE_MAX_ATTEMPTS; i++) {
      await t.request('POST', '/api/auth/email-code/verify', { body: { email: 'mem@example.com', code: wrong } });
    }
    // exhausted: even the right code no longer works
    expect((await t.request('POST', '/api/auth/email-code/verify', { body: { email: 'mem@example.com', code: good } })).status).toBe(401);
    expect(t.db.prepare(`SELECT COUNT(*) n FROM login_codes`).get()).toEqual({ n: 0 });
  });

  it('a code expires after 10 minutes', async () => {
    const t = await setupNudge();
    t.person('mem@example.com');
    await ask(t, 'mem@example.com');
    t.advance(CODE_TTL_MS + 1000);
    expect((await t.request('POST', '/api/auth/email-code/verify', { body: { email: 'mem@example.com', code: t.mails[0]!.text } })).status).toBe(401);
  });

  it('a new code replaces the old one', async () => {
    const t = await setupNudge();
    t.person('mem@example.com');
    await ask(t, 'mem@example.com');
    await ask(t, 'mem@example.com');
    const [first, second] = t.mails.map((m) => m.text);
    if (first !== second) {
      expect((await t.request('POST', '/api/auth/email-code/verify', { body: { email: 'mem@example.com', code: first } })).status).toBe(401);
    }
    expect((await t.request('POST', '/api/auth/email-code/verify', { body: { email: 'mem@example.com', code: second } })).status).toBe(200);
  });

  it('returns the identical response for unknown and inactive emails and sends nothing', async () => {
    const t = await setupNudge();
    t.person('known@example.com');
    const p = t.person('gone@example.com');
    t.db.prepare(`UPDATE people SET active = 0 WHERE id = ?`).run(p.id);
    const a = await ask(t, 'known@example.com');
    const b = await ask(t, 'nobody@example.com');
    const c = await ask(t, 'gone@example.com');
    expect([b.status, c.status]).toEqual([200, 200]);
    expect(b.body).toBe(a.body);
    expect(c.body).toBe(a.body);
    expect(t.mails.map((m) => m.to)).toEqual(['known@example.com']);
    expect((await t.request('POST', '/api/auth/email-code/verify', { body: { email: 'nobody@example.com', code: '123456' } })).status).toBe(401);
  });

  it('limits 3 codes per email per 15 minutes, counting unknown emails too', async () => {
    const t = await setupNudge();
    t.person('mem@example.com');
    for (let i = 0; i < 3; i++) expect((await ask(t, 'mem@example.com')).status).toBe(200);
    expect((await ask(t, 'mem@example.com')).status).toBe(429);
    for (let i = 0; i < 3; i++) expect((await ask(t, 'ghost@example.com')).status).toBe(200);
    expect((await ask(t, 'ghost@example.com')).status).toBe(429); // same behaviour: no enumeration
    t.advance(16 * 60_000);
    expect((await ask(t, 'mem@example.com')).status).toBe(200);
  });

  it('limits 10 requests per IP per 15 minutes; the last X-Forwarded-For hop is used behind a trusted proxy', async () => {
    const t = await setupNudge();
    for (let i = 0; i < 10; i++) expect((await ask(t, `u${i}@example.com`)).status).toBe(200);
    expect((await ask(t, 'u11@example.com')).status).toBe(429);

    const p = await setupNudge({ env: { ADMIN_TRUST_PROXY: true } });
    for (let i = 0; i < 10; i++) {
      // the first entry is client-controlled and varies; the last hop is the same address
      expect((await ask(p, `u${i}@example.com`, { 'X-Forwarded-For': `1.1.1.${i}, 9.9.9.9` })).status).toBe(200);
    }
    expect((await ask(p, 'x@example.com', { 'X-Forwarded-For': '2.2.2.2, 9.9.9.9' })).status).toBe(429);
    expect((await ask(p, 'y@example.com', { 'X-Forwarded-For': '2.2.2.2, 8.8.8.8' })).status).toBe(200);
  });

  it('limits verify attempts per IP (20 per 15 minutes), using the last X-Forwarded-For hop behind a proxy', async () => {
    const t = await setupNudge();
    for (let i = 0; i < CODE_VERIFY_IP_LIMIT; i++) {
      expect((await t.request('POST', '/api/auth/email-code/verify', { body: { email: `u${i}@example.com`, code: '123456' } })).status).toBe(401);
    }
    expect((await t.request('POST', '/api/auth/email-code/verify', { body: { email: 'x@example.com', code: '123456' } })).status).toBe(429);
    t.advance(16 * 60_000);
    expect((await t.request('POST', '/api/auth/email-code/verify', { body: { email: 'x@example.com', code: '123456' } })).status).toBe(401);

    const p = await setupNudge({ env: { ADMIN_TRUST_PROXY: true } });
    const v = (xff: string) => p.request('POST', '/api/auth/email-code/verify', { body: { email: 'a@example.com', code: '123456' }, headers: { 'X-Forwarded-For': xff } });
    for (let i = 0; i < CODE_VERIFY_IP_LIMIT; i++) expect((await v(`1.1.1.${i}, 9.9.9.9`)).status).toBe(401);
    expect((await v('2.2.2.2, 9.9.9.9')).status).toBe(429);
    expect((await v('2.2.2.2, 8.8.8.8')).status).toBe(401);
  });

  it('never writes the code to the logs or the audit log', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'debug';
    try {
      const t = await setupNudge();
      t.person('mem@example.com');
      await ask(t, 'mem@example.com');
      const code = t.mails[0]!.text;
      await t.request('POST', '/api/auth/email-code/verify', { body: { email: 'mem@example.com', code: '999999' } });
      await t.request('POST', '/api/auth/email-code/verify', { body: { email: 'mem@example.com', code } });
      const logged = [...spy.mock.calls, ...err.mock.calls].map((c) => c.join(' ')).join('\n');
      expect(logged).not.toContain(code);
      const audit = JSON.stringify(t.db.prepare(`SELECT * FROM audit_log`).all());
      expect(audit).not.toContain(code);
      expect(audit).toContain('email_code');
    } finally {
      process.env.LOG_LEVEL = prev;
      spy.mockRestore(); err.mockRestore();
    }
  });

  it('is unavailable without a mailer', async () => {
    const t = await setupNudge({ mailer: false });
    expect((await t.request('POST', '/api/auth/email-code', { body: { email: 'a@example.com' } })).status).toBe(404);
    expect((await t.request('GET', '/api/auth/config')).json.emailCode).toBeUndefined();
  });
});

describe('google login', () => {
  it('accepts an active member and refuses an unknown or deactivated person', async () => {
    const t = await setupNudge();
    expect((await t.request('POST', '/api/auth/google', { body: { credential: 'x' } })).status).toBe(403);
    const p = t.person('google@example.com');
    const ok = await t.request('POST', '/api/auth/google', { body: { credential: 'x' } });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ email: 'google@example.com', role: 'member' });
    expect(ok.headers['set-cookie']![0]).toContain(`Max-Age=${MEMBER_SESSION_TTL_MS / 1000}`);
    t.db.prepare(`UPDATE people SET active = 0 WHERE id = ?`).run(p.id);
    expect((await t.request('POST', '/api/auth/google', { body: { credential: 'x' } })).status).toBe(403);
  });
});

describe('sessions', () => {
  const DAY = 24 * 3600_000;

  it('members: 30 days sliding, extended only when used more than a day after the last extension', async () => {
    const t = await setupNudge();
    t.person('mem@example.com');
    const cookie = await t.loginWithCode('mem@example.com');
    const expiry = () => (t.db.prepare(`SELECT expires_at FROM admin_sessions WHERE product = 'tasks'`).get() as { expires_at: string }).expires_at;
    const e0 = expiry();
    expect(Date.parse(e0) - t.now().getTime()).toBe(30 * DAY);

    t.advance(2 * 3600_000); // used within the day: not extended
    const r1 = await t.request('GET', '/api/me', { cookie });
    expect(r1.status).toBe(200);
    expect(expiry()).toBe(e0);
    expect(r1.headers['set-cookie']).toBeUndefined();

    t.advance(DAY); // more than a day since the last extension: extended, cookie re-issued
    const r2 = await t.request('GET', '/api/me', { cookie });
    expect(r2.status).toBe(200);
    expect(Date.parse(expiry()) - t.now().getTime()).toBe(30 * DAY);
    expect(r2.headers['set-cookie']![0]).toContain(`Max-Age=${30 * 86400}`);

    // regular use keeps it alive well beyond 30 days from login
    for (let i = 0; i < 4; i++) {
      t.advance(20 * DAY);
      expect((await t.request('GET', '/api/me', { cookie })).status).toBe(200);
    }
    // unused for 30 days: expired
    t.advance(30 * DAY + 1000);
    expect((await t.request('GET', '/api/me', { cookie })).status).toBe(401);
  });

  it('the superadmin: 3 h from login, even while in use', async () => {
    const t = await setupNudge();
    const sup = await t.loginSuper();
    t.advance(SESSION_TTL_MS - 60_000);
    expect((await t.request('GET', '/api/me', { cookie: sup })).status).toBe(200);
    t.advance(2 * 60_000);
    expect((await t.request('GET', '/api/me', { cookie: sup })).status).toBe(401);
    expect(SESSION_TTL_MS).toBe(3 * 3600_000);
  });

  it('admins: 7 days, extended while used', async () => {
    const t = await setupNudge();
    t.person('adm@example.com', 'admin');
    const adm = await t.loginWithCode('adm@example.com');
    t.advance(6 * DAY);
    const used = await t.request('GET', '/api/me', { cookie: adm });
    expect(used.status).toBe(200);
    expect(used.headers['set-cookie']![0]).toContain(`Max-Age=${ADMIN_SESSION_TTL_MS / 1000}`); // extended
    t.advance(6 * DAY); // 12 days after login, 6 after the extension
    expect((await t.request('GET', '/api/me', { cookie: adm })).status).toBe(200);
    t.advance(7 * DAY + 1000); // unused for 7 days
    expect((await t.request('GET', '/api/me', { cookie: adm })).status).toBe(401);
  });

  it('a member promoted to admin drops to the 7-day admin limit', async () => {
    const t = await setupNudge();
    const p = t.person('mem@example.com');
    const cookie = await t.loginWithCode('mem@example.com');
    t.db.prepare(`UPDATE people SET role = 'admin' WHERE id = ?`).run(p.id);
    t.advance(ADMIN_SESSION_TTL_MS + 1000);
    expect((await t.request('GET', '/api/me', { cookie })).status).toBe(401);
  });

  it('logout deletes the session', async () => {
    const t = await setupNudge();
    t.person('mem@example.com');
    const cookie = await t.loginWithCode('mem@example.com');
    expect((await t.request('POST', '/api/auth/logout', { cookie, body: {} })).status).toBe(200);
    expect((await t.request('GET', '/api/me', { cookie })).status).toBe(401);
  });
});
