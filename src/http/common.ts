// HTTP plumbing shared by the reminders admin console and the Nudge server (node:http only):
// security headers, JSON bodies, CSRF, static files, error mapping and server shell.

import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { HttpError } from '../admin/auth.js';
import { logger } from '../logger.js';
import { StoreError } from '../store-errors.js';

export const MAX_BODY_BYTES = 100 * 1024;

export const CSP = [
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

/** Nudge's policy: the shared one plus explicit worker-src and manifest-src for the PWA (both are 'self' only). */
export const NUDGE_CSP = [CSP, "worker-src 'self'", "manifest-src 'self'"].join('; ');

export interface ApiResult {
  status: number;
  body: unknown;
  /** Raw bytes instead of JSON (the QR image). */
  binary?: { type: string; data: Buffer };
}

/** `cache` is an optional Cache-Control value (index.html is always no-store). */
export type StaticFiles = Record<string, { file: string; type: string; cache?: string; /** Served from memory instead of reading `file` (Nudge's sw.js, with its version filled in). */ body?: Buffer }>;

export function setSecurityHeaders(res: http.ServerResponse, hsts: boolean, csp: string = CSP): void {
  if (hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', csp);
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown, extra: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

export function sendResult(res: http.ServerResponse, result: ApiResult, extra: http.OutgoingHttpHeaders = {}): void {
  if (result.binary) {
    res.writeHead(result.status, { 'Content-Type': result.binary.type, 'Content-Length': result.binary.data.length, 'Cache-Control': 'no-store', ...extra });
    return void res.end(result.binary.data);
  }
  sendJson(res, result.status, result.body, extra);
}

export function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
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
export function checkCsrf(req: http.IncomingMessage): void {
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

/** Path segments after "/api", decoded; throws a 400 on a malformed escape. */
export function apiSegments(url: URL): string[] {
  try {
    return url.pathname.split('/').slice(2).filter((s) => s !== '').map(decodeURIComponent);
  } catch {
    throw new HttpError(400, 'bad request path');
  }
}

export async function serveStatic(
  req: http.IncomingMessage, res: http.ServerResponse, files: StaticFiles, publicDir: string, path: string,
): Promise<void> {
  const entry = files[path];
  if ((req.method !== 'GET' && req.method !== 'HEAD') || !entry) return sendJson(res, 404, { error: 'not found' });
  let data: Buffer;
  if (entry.body) data = entry.body;
  else {
    try {
      data = await readFile(join(publicDir, entry.file));
    } catch {
      return sendJson(res, 404, { error: 'not found' });
    }
  }
  const headers: http.OutgoingHttpHeaders = { 'Content-Type': entry.type, 'Content-Length': data.length };
  if (entry.file === 'index.html') headers['Cache-Control'] = 'no-store';
  else if (entry.cache) headers['Cache-Control'] = entry.cache;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : data);
}

export interface ShellOptions {
  /** Logger name for crash reports, e.g. 'admin-server'. */
  name: string;
  hsts: boolean;
  /** Content-Security-Policy value; defaults to CSP. */
  csp?: string;
  files: StaticFiles;
  publicDir: string;
  handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void>;
}

/** Turns any error into a response; never throws. */
export function makeFail(name: string) {
  const log = logger.child({ module: name });
  return (req: http.IncomingMessage, res: http.ServerResponse, err: unknown): void => {
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
      log.error('request crashed', { method: req.method, err });
      sendJson(res, 500, { error: 'internal error' });
    } catch {
      res.destroy();
    }
  };
}

/** The server shell: wraps every request so a malformed one becomes a 4xx/5xx and never throws out of the handler. */
export function createServerShell(opts: ShellOptions): http.Server {
  const fail = makeFail(opts.name);
  const server = http.createServer((req, res) => {
    try {
      setSecurityHeaders(res, opts.hsts, opts.csp);
      const url = new URL(req.url ?? '/', 'http://localhost');
      const run =
        url.pathname === '/api' || url.pathname.startsWith('/api/')
          ? opts.handleApi(req, res, url)
          : serveStatic(req, res, opts.files, opts.publicDir, url.pathname);
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

/** Listens; a listen error is logged and never stops the jobs. */
export function listenServer(
  server: http.Server, name: string, port: number, host: string, errorMsg: string, listenMsg = `${name} listening`,
): http.Server {
  const log = logger.child({ module: name });
  server.on('error', (err) => log.error(errorMsg, { port, err }));
  server.listen(port, host, () => {
    const addr = server.address();
    log.info(listenMsg, { host, port: typeof addr === 'object' && addr ? addr.port : port });
  });
  return server;
}
