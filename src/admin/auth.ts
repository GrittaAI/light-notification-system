// Admin authentication: password (superadmin only) or Google ID token, then a cookie session.
// Never log passwords, tokens, cookies or ID tokens.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { google } from 'googleapis';
import type { Env } from '../config.js';
import type { DB } from '../db.js';
import { logger } from '../logger.js';
import { type Principal, resolvePrincipal, type UserRole } from '../people.js';

const log = logger.child({ module: 'admin-auth' });

export type Product = 'reminders' | 'tasks';
/** Each product has its own host-only cookie and its own sessions: a session of one is never accepted by the other. */
export const COOKIE_NAMES: Record<Product, string> = { reminders: 'admin_session', tasks: 'nudge_session' };
export const COOKIE_NAME = COOKIE_NAMES.reminders;
export const SESSION_TTL_MS = 12 * 3600_000;
export const MEMBER_SESSION_TTL_MS = 30 * 24 * 3600_000;
/** Members' sessions are extended when used and more than this long after the last extension. */
export const SESSION_EXTEND_AFTER_MS = 24 * 3600_000;
export const CODE_TTL_MS = 10 * 60_000;
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_EMAIL_LIMIT = 3;
export const CODE_IP_LIMIT = 10;
export const CODE_VERIFY_IP_LIMIT = 20;
export const CODE_WINDOW_MS = 15 * 60_000;
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

export interface SessionUser extends Principal {
  /** Set when a sliding member session was just extended: the server re-issues the cookie with this value. */
  refreshedCookie?: string;
}
export type { UserRole };

export interface Mailer {
  /** Sends a plain-text email to one address. Throws if the SMTP send fails. */
  sendTo(to: string, subject: string, text: string): Promise<void>;
}

export interface AuthDeps {
  db: DB;
  env: AuthEnv;
  verifyIdToken?: VerifyIdToken;
  now?: () => Date;
  /** Which product this auth serves (default 'reminders'). Only 'tasks' accepts members and email codes. */
  product?: Product;
  mailer?: Mailer;
  /** Product name used in the sign-in email (default "Pushup Nudge"). */
  appName?: string;
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

/** Sliding-window counter: allows `max` hits per key per window. */
function createLimiter(max: number, windowMs: number, now: () => Date) {
  const hits = new Map<string, number[]>();
  return {
    /** Records a hit; returns false when the key is over its limit (the hit is not counted then). */
    hit(key: string): boolean {
      const t = now().getTime();
      const recent = (hits.get(key) ?? []).filter((x) => x > t - windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      return true;
    },
    prune(): void {
      const t = now().getTime();
      for (const [k, v] of hits) if (!v.some((x) => x > t - windowMs)) hits.delete(k);
    },
  };
}

export function createAuth(deps: AuthDeps) {
  const { db, env } = deps;
  const product: Product = deps.product ?? 'reminders';
  const cookieName = COOKIE_NAMES[product];
  const allowMembers = product === 'tasks';
  const appName = deps.appName ?? 'Pushup Nudge';
  const now = deps.now ?? (() => new Date());
  const verifyIdToken = deps.verifyIdToken ?? verifyGoogleIdToken;
  const failures = new Map<string, { count: number; resetAt: number }>();
  const codeByEmail = createLimiter(CODE_EMAIL_LIMIT, CODE_WINDOW_MS, now);
  const codeByIp = createLimiter(CODE_IP_LIMIT, CODE_WINDOW_MS, now);
  const verifyByIp = createLimiter(CODE_VERIFY_IP_LIMIT, CODE_WINDOW_MS, now);
  let lastCleanup = 0;

  function cleanup(): void {
    const t = now().getTime();
    if (t - lastCleanup < 60_000) return;
    lastCleanup = t;
    db.prepare(`DELETE FROM admin_sessions WHERE expires_at <= ?`).run(now().toISOString());
    db.prepare(`DELETE FROM login_codes WHERE expires_at <= ?`).run(now().toISOString());
    for (const [ip, f] of failures) if (f.resetAt <= t) failures.delete(ip);
    codeByEmail.prune();
    codeByIp.prune();
    verifyByIp.prune();
  }

  const isSliding = (role: UserRole) => role === 'member';
  const ttlFor = (role: UserRole) => (isSliding(role) ? MEMBER_SESSION_TTL_MS : SESSION_TTL_MS);

  function createSession(user: Principal): string {
    cleanup();
    const token = randomBytes(32).toString('base64url');
    const t = now();
    db.prepare(
      `INSERT INTO admin_sessions (token_hash, email, created_at, expires_at, sliding, extended_at, product) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(sha256Hex(token), user.email, t.toISOString(), new Date(t.getTime() + ttlFor(user.role)).toISOString(),
      isSliding(user.role) ? 1 : 0, t.toISOString(), product);
    return token;
  }

  function cookieFor(token: string, role: UserRole = 'admin'): string {
    return `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ttlFor(role) / 1000}${env.ADMIN_COOKIE_SECURE ? '; Secure' : ''}`;
  }

  function clearCookie(): string {
    return `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${env.ADMIN_COOKIE_SECURE ? '; Secure' : ''}`;
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

  const principal = (email: string) => resolvePrincipal(db, email, env.SUPERADMIN_EMAIL, allowMembers);

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
    const user = principal(email)!; // the superadmin always resolves
    return { token: createSession(user), user };
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
    const user = principal(email);
    if (!user) {
      log.warn(allowMembers ? 'google login refused: not an active person' : 'google login refused: not an admin', { email });
      throw new HttpError(403, 'not authorised');
    }
    return { token: createSession(user), user };
  }

  // ----- email one-time codes (Nudge only) -----

  const SAME_BODY = { ok: true, message: 'If this email is registered, a sign-in code has been sent.' };

  /**
   * Sends a 6-digit code to an active person (or the superadmin). The response is the same whether or not the
   * email is registered. Per-email and per-IP limits count every request, registered or not.
   * Only sha256(code) is stored; the code is never logged or audited.
   */
  function requestEmailCode(input: { email?: unknown }, ip: string): { body: typeof SAME_BODY; sending?: Promise<void> } {
    if (!allowMembers || !deps.mailer) throw new HttpError(404, 'email sign-in is not enabled');
    cleanup();
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (!email || email.length > 254 || !email.includes('@')) throw new HttpError(400, 'a valid email is required');
    if (!codeByIp.hit(ip)) throw new HttpError(429, 'too many requests; try again later');
    if (!codeByEmail.hit(email)) throw new HttpError(429, 'too many codes requested; try again later');
    const user = principal(email);
    if (!user) return { body: SAME_BODY };
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const t = now();
    db.prepare(
      `INSERT INTO login_codes (email, code_hash, attempts, created_at, expires_at) VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, attempts = 0, created_at = excluded.created_at, expires_at = excluded.expires_at`,
    ).run(email, sha256Hex(code), t.toISOString(), new Date(t.getTime() + CODE_TTL_MS).toISOString());
    // Sent in the background so response time does not reveal whether the email is registered.
    const sending = deps.mailer.sendTo(email, `Your ${appName} sign-in code`, code).then(
      () => log.info('sign-in code sent'),
      (err: unknown) => log.error('sign-in code email failed', { reason: err instanceof Error ? err.name : 'error' }),
    );
    return { body: SAME_BODY, sending };
  }

  function verifyEmailCode(input: { email?: unknown; code?: unknown }, ip: string): { token: string; user: SessionUser } {
    if (!allowMembers || !deps.mailer) throw new HttpError(404, 'email sign-in is not enabled');
    cleanup();
    if (!verifyByIp.hit(ip)) throw new HttpError(429, 'too many attempts; try again later');
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    const code = typeof input.code === 'string' ? input.code.trim() : '';
    const invalid = new HttpError(401, 'invalid or expired code');
    if (!/^\d{6}$/.test(code)) throw invalid;
    const row = db.prepare(`SELECT code_hash, attempts, expires_at FROM login_codes WHERE email = ?`).get(email) as
      | { code_hash: string; attempts: number; expires_at: string }
      | undefined;
    if (!row) throw invalid;
    if (row.expires_at <= now().toISOString()) {
      db.prepare(`DELETE FROM login_codes WHERE email = ?`).run(email);
      throw invalid;
    }
    // Count the attempt first; the 5th wrong guess invalidates the code.
    const attempts = row.attempts + 1;
    const ok = timingSafeEqual(Buffer.from(sha256Hex(code)), Buffer.from(row.code_hash));
    if (!ok) {
      if (attempts >= CODE_MAX_ATTEMPTS) db.prepare(`DELETE FROM login_codes WHERE email = ?`).run(email);
      else db.prepare(`UPDATE login_codes SET attempts = ? WHERE email = ?`).run(attempts, email);
      throw invalid;
    }
    db.prepare(`DELETE FROM login_codes WHERE email = ?`).run(email); // single use
    const user = principal(email);
    if (!user) throw invalid;
    return { token: createSession(user), user };
  }

  /** Resolves the session cookie to a user, re-checking that the email is still allowed. */
  function authenticate(cookieHeader: string | undefined): SessionUser | null {
    const token = parseCookies(cookieHeader)[cookieName];
    if (!token) return null;
    cleanup();
    const hash = sha256Hex(token);
    const row = db.prepare(`SELECT email, created_at, expires_at, sliding, extended_at FROM admin_sessions WHERE token_hash = ? AND product = ?`).get(hash, product) as
      | { email: string; created_at: string; expires_at: string; sliding: number; extended_at: string | null }
      | undefined;
    if (!row) return null;
    const drop = () => { db.prepare(`DELETE FROM admin_sessions WHERE token_hash = ?`).run(hash); return null; };
    const nowIso = now().toISOString();
    if (row.expires_at <= nowIso) return drop();
    const user = principal(row.email);
    if (!user) return drop();
    // A member promoted to admin since login: the 12 h admin limit applies from login time.
    if (row.sliding === 1 && !isSliding(user.role) && new Date(Date.parse(row.created_at) + SESSION_TTL_MS).toISOString() <= nowIso) return drop();
    if (row.sliding === 1 && isSliding(user.role)) {
      const last = Date.parse(row.extended_at ?? row.created_at);
      if (now().getTime() - last > SESSION_EXTEND_AFTER_MS) {
        db.prepare(`UPDATE admin_sessions SET expires_at = ?, extended_at = ? WHERE token_hash = ?`)
          .run(new Date(now().getTime() + MEMBER_SESSION_TTL_MS).toISOString(), nowIso, hash);
        return { ...user, refreshedCookie: cookieFor(token, 'member') };
      }
    }
    return user;
  }

  function logout(cookieHeader: string | undefined): void {
    const token = parseCookies(cookieHeader)[cookieName];
    if (token) db.prepare(`DELETE FROM admin_sessions WHERE token_hash = ? AND product = ?`).run(sha256Hex(token), product);
  }

  return { passwordLogin, googleLogin, requestEmailCode, verifyEmailCode, authenticate, logout, cookieFor, clearCookie, clientIp };
}

export type Auth = ReturnType<typeof createAuth>;
