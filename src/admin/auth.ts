// Admin authentication: password (superadmin only) or Google ID token, then a cookie session.
// Never log passwords, tokens, cookies or ID tokens.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { google } from 'googleapis';
import type { Env } from '../config.js';
import type { DB } from '../db.js';
import { logger } from '../logger.js';
import { roleOf } from '../store.js';

const log = logger.child({ module: 'admin-auth' });

export const COOKIE_NAME = 'admin_session';
export const SESSION_TTL_MS = 12 * 3600_000;
export const RATE_LIMIT_FAILURES = 5;
export const RATE_LIMIT_WINDOW_MS = 15 * 60_000;

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly fields?: Record<string, string>) {
    super(message);
    this.name = 'HttpError';
  }
}

export type AuthEnv = Pick<
  Env,
  'SUPERADMIN_EMAIL' | 'ADMIN_PASSWORD' | 'GOOGLE_OAUTH_CLIENT_ID' | 'ADMIN_TRUST_PROXY' | 'ADMIN_COOKIE_SECURE'
>;

export interface IdTokenPayload {
  email?: string;
  email_verified?: boolean;
}

export type VerifyIdToken = (idToken: string, audience: string) => Promise<IdTokenPayload | undefined>;

/** Verifies a Google Identity Services ID token with the existing googleapis client (no new dependency). */
export const verifyGoogleIdToken: VerifyIdToken = async (idToken, audience) => {
  const ticket = await new google.auth.OAuth2().verifyIdToken({ idToken, audience });
  return ticket.getPayload() ?? undefined;
};

export interface SessionUser {
  email: string;
  role: 'superadmin' | 'admin';
}

export interface AuthDeps {
  db: DB;
  env: AuthEnv;
  verifyIdToken?: VerifyIdToken;
  now?: () => Date;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function createAuth(deps: AuthDeps) {
  const { db, env } = deps;
  const now = deps.now ?? (() => new Date());
  const verifyIdToken = deps.verifyIdToken ?? verifyGoogleIdToken;
  const failures = new Map<string, { count: number; resetAt: number }>();
  let lastCleanup = 0;

  function cleanup(): void {
    const t = now().getTime();
    if (t - lastCleanup < 60_000) return;
    lastCleanup = t;
    db.prepare(`DELETE FROM admin_sessions WHERE expires_at <= ?`).run(now().toISOString());
    for (const [ip, f] of failures) if (f.resetAt <= t) failures.delete(ip);
  }

  function createSession(email: string): string {
    cleanup();
    const token = randomBytes(32).toString('base64url');
    const t = now();
    db.prepare(`INSERT INTO admin_sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)`)
      .run(sha256Hex(token), email, t.toISOString(), new Date(t.getTime() + SESSION_TTL_MS).toISOString());
    return token;
  }

  function cookieFor(token: string): string {
    return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${env.ADMIN_COOKIE_SECURE ? '; Secure' : ''}`;
  }

  function clearCookie(): string {
    return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${env.ADMIN_COOKIE_SECURE ? '; Secure' : ''}`;
  }

  /** Remote address used for rate limiting; X-Forwarded-For last hop only when ADMIN_TRUST_PROXY=true. */
  function clientIp(socketAddress: string | undefined, forwardedFor: string | string[] | undefined): string {
    if (env.ADMIN_TRUST_PROXY) {
      const raw = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
      // The LAST entry is the one our trusted proxy appended; earlier entries are client-controlled.
      const last = raw?.split(',').at(-1)?.trim();
      if (last) return last;
    }
    return socketAddress ?? 'unknown';
  }

  function passwordLogin(input: { email?: unknown; password?: unknown }, ip: string): { token: string; user: SessionUser } {
    cleanup();
    const f = failures.get(ip);
    if (f && f.resetAt > now().getTime() && f.count >= RATE_LIMIT_FAILURES) {
      throw new HttpError(429, 'too many failed attempts; try again later');
    }
    if (!env.ADMIN_PASSWORD) throw new HttpError(404, 'password login is not enabled');

    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    const password = typeof input.password === 'string' ? input.password : '';
    // Always compare both (constant time) so timing reveals nothing about which part was wrong.
    const passwordOk = timingSafeEqual(sha256(password), sha256(env.ADMIN_PASSWORD));
    const emailOk = timingSafeEqual(sha256(email), sha256(env.SUPERADMIN_EMAIL.toLowerCase()));
    if (!(passwordOk && emailOk)) {
      const t = now().getTime();
      const cur = f && f.resetAt > t ? f : { count: 0, resetAt: t + RATE_LIMIT_WINDOW_MS };
      cur.count++;
      failures.set(ip, cur);
      log.warn('password login failed', { ip });
      throw new HttpError(401, 'invalid email or password');
    }
    failures.delete(ip);
    const user: SessionUser = { email, role: 'superadmin' };
    return { token: createSession(email), user };
  }

  async function googleLogin(input: { credential?: unknown }): Promise<{ token: string; user: SessionUser }> {
    const audience = env.GOOGLE_OAUTH_CLIENT_ID;
    if (!audience) throw new HttpError(404, 'Google login is not enabled');
    if (typeof input.credential !== 'string' || !input.credential) throw new HttpError(400, 'credential is required');
    let payload: IdTokenPayload | undefined;
    try {
      payload = await verifyIdToken(input.credential, audience);
    } catch (err) {
      // Fixed reason code only: the library message can contain the token and its claims.
      const msg = err instanceof Error ? err.message : '';
      const reason = /audience|recipient/i.test(msg) ? 'wrong_audience' : /too late|expir/i.test(msg) ? 'expired' : 'invalid';
      log.warn('google id token rejected', { reason });
      throw new HttpError(401, 'invalid Google credential');
    }
    if (!payload?.email) throw new HttpError(401, 'invalid Google credential');
    if (!payload.email_verified) throw new HttpError(403, 'Google email is not verified');
    const email = payload.email.trim().toLowerCase();
    const role = roleOf(db, email, env.SUPERADMIN_EMAIL);
    if (!role) {
      log.warn('google login refused: not an admin', { email });
      throw new HttpError(403, 'not authorised');
    }
    return { token: createSession(email), user: { email, role } };
  }

  /** Resolves the session cookie to a user, re-checking that the email is still allowed. */
  function authenticate(cookieHeader: string | undefined): SessionUser | null {
    const token = parseCookies(cookieHeader)[COOKIE_NAME];
    if (!token) return null;
    cleanup();
    const hash = sha256Hex(token);
    const row = db.prepare(`SELECT email, expires_at FROM admin_sessions WHERE token_hash = ?`).get(hash) as
      | { email: string; expires_at: string }
      | undefined;
    if (!row) return null;
    if (row.expires_at <= now().toISOString()) {
      db.prepare(`DELETE FROM admin_sessions WHERE token_hash = ?`).run(hash);
      return null;
    }
    const role = roleOf(db, row.email, env.SUPERADMIN_EMAIL);
    if (!role) {
      db.prepare(`DELETE FROM admin_sessions WHERE token_hash = ?`).run(hash);
      return null;
    }
    return { email: row.email, role };
  }

  function logout(cookieHeader: string | undefined): void {
    const token = parseCookies(cookieHeader)[COOKIE_NAME];
    if (token) db.prepare(`DELETE FROM admin_sessions WHERE token_hash = ?`).run(sha256Hex(token));
  }

  return { passwordLogin, googleLogin, authenticate, logout, cookieFor, clearCookie, clientIp };
}

export type Auth = ReturnType<typeof createAuth>;
