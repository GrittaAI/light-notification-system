// The /api/auth/* endpoints (no session needed), shared by the reminders console and Nudge.
// The email-code endpoints exist only when the Auth was created for the tasks product with a mailer.

import type http from 'node:http';
import { type Auth, HttpError, type SessionUser } from '../admin/auth.js';
import type { Env } from '../config.js';
import type { DB } from '../db.js';
import { addAudit } from '../store.js';
import { readJsonBody, sendJson } from './common.js';

export interface AuthRouteDeps {
  db: DB;
  env: Pick<Env, 'GOOGLE_OAUTH_CLIENT_ID' | 'ADMIN_PASSWORD'>;
  /** Advertise (and enable) email-code sign-in. */
  emailCode?: boolean;
}

/** The body of a login response (kept minimal; /api/me has the details). */
const loginBody = (u: SessionUser) => ({ email: u.email, role: u.role });

/**
 * Handles an /api/auth/* request. Returns false when `key` is not an auth route of this product,
 * so the caller can answer 404 (unknown auth paths must never fall through to the session check).
 */
export async function handleAuthRoute(
  deps: AuthRouteDeps, auth: Auth, key: string, method: string, req: http.IncomingMessage, res: http.ServerResponse,
): Promise<boolean> {
  const { db } = deps;
  const ip = () => auth.clientIp(req.socket.remoteAddress, req.headers['x-forwarded-for']);
  const body = async <T>() => ((await readJsonBody(req)) ?? {}) as T;

  if (key === 'auth/config' && method === 'GET') {
    sendJson(res, 200, {
      googleClientId: deps.env.GOOGLE_OAUTH_CLIENT_ID ?? null,
      passwordLogin: !!deps.env.ADMIN_PASSWORD,
      ...(deps.emailCode ? { emailCode: true } : {}),
    });
    return true;
  }
  if (key === 'auth/password' && method === 'POST') {
    const { token, user } = auth.passwordLogin(await body(), ip());
    addAudit(db, user.email, 'login', { method: 'password' });
    sendJson(res, 200, loginBody(user), { 'Set-Cookie': auth.cookieFor(token, user.role) });
    return true;
  }
  if (key === 'auth/google' && method === 'POST') {
    const { token, user } = await auth.googleLogin(await body());
    addAudit(db, user.email, 'login', { method: 'google' });
    sendJson(res, 200, loginBody(user), { 'Set-Cookie': auth.cookieFor(token, user.role) });
    return true;
  }
  if (key === 'auth/logout' && method === 'POST') {
    auth.logout(req.headers.cookie);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
    return true;
  }
  if (deps.emailCode && key === 'auth/email-code' && method === 'POST') {
    const { body: out } = auth.requestEmailCode(await body(), ip());
    sendJson(res, 200, out);
    return true;
  }
  if (deps.emailCode && key === 'auth/email-code/verify' && method === 'POST') {
    const { token, user } = auth.verifyEmailCode(await body(), ip());
    addAudit(db, user.email, 'login', { method: 'email_code' }); // never the code
    sendJson(res, 200, loginBody(user), { 'Set-Cookie': auth.cookieFor(token, user.role) });
    return true;
  }
  if (key.startsWith('auth/')) throw new HttpError(404, 'not found');
  return false;
}
