// Admin HTTP server (node:http only): static UI from public/admin plus the JSON API under /api.

import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';
import { addAudit, StoreError } from '../store.js';
import { type Auth, type AuthDeps, createAuth, HttpError } from './auth.js';
import { type ApiDeps, createApiHandler } from './routes.js';

const log = logger.child({ module: 'admin-server' });

const MAX_BODY_BYTES = 100 * 1024;

/** public/admin relative to the project root (works from src/admin and from dist/admin). */
export const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL('../../public/admin/', import.meta.url));

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/icons.svg': { file: 'icons.svg', type: 'image/svg+xml' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com",
  'frame-src https://accounts.google.com',
  "connect-src 'self' https://accounts.google.com",
  "style-src 'self' https://accounts.google.com",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export interface AdminServerDeps extends ApiDeps, Pick<AuthDeps, 'verifyIdToken'> {
  env: ApiDeps['env'] & AuthDeps['env'];
  publicDir?: string;
}

function setSecurityHeaders(res: http.ServerResponse, hsts: boolean): void {
  if (hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', CSP);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extra: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tooLarge = () => {
      req.removeAllListeners('data');
      req.resume(); // drain instead of destroying, so the client still receives the 413
      reject(new HttpError(413, 'request body too large'));
    };
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge();
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    req.on('data', (c: Buffer) => {
      if (overflow) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        overflow = true;
        chunks.length = 0;
        return tooLarge();
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (overflow) return;
      if (size === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', (err) => { if (!overflow) reject(err); });
  });
}

/** CSRF: non-GET requests must be JSON, and a present Origin must match the Host. */
function checkCsrf(req: http.IncomingMessage): void {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(403, 'Content-Type must be application/json');
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      // invalid Origin: host stays empty and fails below
    }
    if (!host || host !== req.headers.host) throw new HttpError(403, 'cross-origin request refused');
  }
}

export function createAdminServer(deps: AdminServerDeps): http.Server {
  const auth: Auth = createAuth(deps);
  const api = createApiHandler(deps);
  const publicDir = deps.publicDir ?? DEFAULT_PUBLIC_DIR;

  async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<void> {
    const entry = STATIC_FILES[path];
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !entry) return sendJson(res, 404, { error: 'not found' });
    let data: Buffer;
    try {
      data = await readFile(join(publicDir, entry.file));
    } catch {
      return sendJson(res, 404, { error: 'not found' });
    }
    const headers: http.OutgoingHttpHeaders = { 'Content-Type': entry.type, 'Content-Length': data.length };
    if (entry.file === 'index.html') headers['Cache-Control'] = 'no-store';
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    checkCsrf(req);
    let segments: string[];
    try {
      segments = url.pathname.split('/').slice(2).filter((s) => s !== '').map(decodeURIComponent);
    } catch {
      throw new HttpError(400, 'bad request path');
    }
    const method = req.method ?? 'GET';
    const cookie = req.headers.cookie;
    const key = segments.join('/');

    // ----- auth endpoints (no session required) -----
    if (key === 'auth/config' && method === 'GET') {
      return sendJson(res, 200, {
        googleClientId: deps.env.GOOGLE_OAUTH_CLIENT_ID ?? null,
        passwordLogin: !!deps.env.ADMIN_PASSWORD,
      });
    }
    if (key === 'auth/password' && method === 'POST') {
      const body = (await readJsonBody(req)) as { email?: unknown; password?: unknown } | undefined;
      const ip = auth.clientIp(req.socket.remoteAddress, req.headers['x-forwarded-for']);
      const { token, user } = auth.passwordLogin(body ?? {}, ip);
      addAudit(deps.db, user.email, 'login', { method: 'password' });
      return sendJson(res, 200, user, { 'Set-Cookie': auth.cookieFor(token) });
    }
    if (key === 'auth/google' && method === 'POST') {
      const body = (await readJsonBody(req)) as { credential?: unknown } | undefined;
      const { token, user } = await auth.googleLogin(body ?? {});
      addAudit(deps.db, user.email, 'login', { method: 'google' });
      return sendJson(res, 200, user, { 'Set-Cookie': auth.cookieFor(token) });
    }
    if (key === 'auth/logout' && method === 'POST') {
      auth.logout(cookie);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
    }

    // ----- everything else needs a session -----
    const user = auth.authenticate(cookie);
    if (!user) throw new HttpError(401, 'not signed in');
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readJsonBody(req);
    const result = await api(user, method, segments, url.searchParams, body);
    if (result.binary) {
      res.writeHead(result.status, { 'Content-Type': result.binary.type, 'Content-Length': result.binary.data.length, 'Cache-Control': 'no-store' });
      return void res.end(result.binary.data);
    }
    sendJson(res, result.status, result.body);
  }

  const hsts = !!deps.env.ADMIN_COOKIE_SECURE;

  /** Turns any error into a response; never throws. */
  function fail(req: http.IncomingMessage, res: http.ServerResponse, err: unknown): void {
    try {
      if (res.headersSent) return void res.destroy();
      if (err instanceof HttpError) {
        const extra: http.OutgoingHttpHeaders = err.status === 413 ? { Connection: 'close' } : {};
        return sendJson(res, err.status, { error: err.message, ...(err.fields && { fields: err.fields }) }, extra);
      }
      if (err instanceof StoreError) {
        const status = err.kind === 'validation' ? 400 : err.kind === 'conflict' ? 409 : 404;
        return sendJson(res, status, { error: err.message, ...(err.fields && { fields: err.fields }) });
      }
      if ((err as { code?: string })?.code === 'ERR_INVALID_URL') return sendJson(res, 400, { error: 'bad request' });
      log.error('admin request crashed', { method: req.method, err });
      sendJson(res, 500, { error: 'internal error' });
    } catch {
      res.destroy();
    }
  }

  const server = http.createServer((req, res) => {
    try {
      setSecurityHeaders(res, hsts);
      const url = new URL(req.url ?? '/', 'http://localhost');
      const run =
        url.pathname === '/api' || url.pathname.startsWith('/api/') ? handleApi(req, res, url) : serveStatic(req, res, url.pathname);
      run.catch((err: unknown) => fail(req, res, err));
    } catch (err) {
      fail(req, res, err);
    }
  });
  // Malformed HTTP (bad request line, etc.): answer 400 instead of dropping the socket silently.
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  return server;
}

/** Starts the admin server. A listen error is logged and never stops the jobs. */
export function startAdminServer(deps: AdminServerDeps, port: number, host: string): http.Server {
  const server = createAdminServer(deps);
  server.on('error', (err) => {
    log.error('admin server error; reminders and sync keep running, admin UI unavailable', { port, err });
  });
  server.listen(port, host, () => {
    const addr = server.address();
    log.info('admin server listening', { host, port: typeof addr === 'object' && addr ? addr.port : port });
  });
  return server;
}
