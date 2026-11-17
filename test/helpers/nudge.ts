import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect } from 'vitest';
import { createNudgeServer } from '../../src/nudge/server.js';
import { type DB, openDb } from '../../src/db.js';
import { createPerson } from '../../src/people.js';

export const SUPER = 'boss@example.com';
export const PASSWORD = 'correct-horse-battery';
export const T0 = Date.parse('2026-11-16T03:00:00.000Z');

export interface Res { status: number; headers: http.IncomingHttpHeaders; body: string; json: any }

const servers: http.Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) { s.close(); s.closeAllConnections(); } });

export interface Mail { to: string; subject: string; text: string }

export async function setupNudge(opts: { db?: DB; env?: Record<string, unknown>; mailer?: boolean; publicDir?: string; whatsapp?: any } = {}) {
  const db = opts.db ?? openDb(':memory:');
  let nowMs = T0;
  const mails: Mail[] = [];
  const env = {
    SUPERADMIN_EMAIL: SUPER, ADMIN_PASSWORD: PASSWORD, GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    ADMIN_TRUST_PROXY: false, ADMIN_COOKIE_SECURE: false, ...opts.env,
  } as any;
  const server = createNudgeServer({
    db, env, now: () => new Date(nowMs),
    mailer: opts.mailer === false ? undefined : { async sendTo(to, subject, text) { mails.push({ to, subject, text }); } },
    appName: 'Nudge',
    ...(opts.publicDir && { publicDir: opts.publicDir }),
    ...(opts.whatsapp && { whatsapp: opts.whatsapp }),
    verifyIdToken: async (_t) => ({ email: 'google@example.com', email_verified: true }),
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  const request = (method: string, path: string, o: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) =>
    new Promise<Res>((resolve, reject) => {
      const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
      const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...(o.headers ?? {}) };
      if (method !== 'GET') headers['Content-Type'] = 'application/json';
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
  const loginSuper = async () => {
    const r = await request('POST', '/api/auth/password', { body: { email: SUPER, password: PASSWORD } });
    expect(r.status).toBe(200);
    return cookieOf(r);
  };
  /** Signs a person in through the email-code flow and returns the session cookie. */
  const loginWithCode = async (email: string) => {
    const before = mails.length;
    const r = await request('POST', '/api/auth/email-code', { body: { email } });
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 5));
    expect(mails.length).toBe(before + 1);
    const v = await request('POST', '/api/auth/email-code/verify', { body: { email, code: mails.at(-1)!.text } });
    expect(v.status).toBe(200);
    return cookieOf(v);
  };
  const person = (email: string, role: 'admin' | 'member' = 'member', extra: Record<string, unknown> = {}) =>
    createPerson(db, { email, name: email.split('@')[0], role, ...extra });
  return {
    db, port, request, cookieOf, loginSuper, loginWithCode, person, mails, env,
    advance: (ms: number) => { nowMs += ms; },
    now: () => new Date(nowMs),
  };
}

let n = 0;
/** A valid UUID v4 (deterministic per call). */
export const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
