// Nudge HTTP server (node:http only): the PWA from public/nudge at "/" plus the JSON API under /api.
// Same security as the reminders admin server (shared plumbing in src/http/common.ts), its own cookie
// (nudge_session, host-only) and its own sessions.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AuthDeps, createAuth, HttpError } from '../admin/auth.js';
import { handleAuthRoute } from '../http/auth-routes.js';
import {
  apiSegments, checkCsrf, createServerShell, listenServer, NUDGE_CSP, readJsonBody, sendResult, type StaticFiles,
} from '../http/common.js';
import { createNudgeApi, type NudgeApiDeps } from './api.js';

/** public/nudge relative to the project root (works from src/nudge and from dist/nudge). */
export const DEFAULT_NUDGE_PUBLIC_DIR = fileURLToPath(new URL('../../public/nudge/', import.meta.url));

// Static whitelist: the PWA's files only. Everything is revalidated (no-cache) so a new deploy is picked up;
// the service worker (sw.js, served at the root so it controls the whole origin) must never be cached stale.
const NC = 'no-cache';
const STATIC_FILES: StaticFiles = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8', cache: NC },
  '/sync-core.js': { file: 'sync-core.js', type: 'text/javascript; charset=utf-8', cache: NC },
  '/idb.js': { file: 'idb.js', type: 'text/javascript; charset=utf-8', cache: NC },
  '/admin.js': { file: 'admin.js', type: 'text/javascript; charset=utf-8', cache: NC },
  '/voice-parse.js': { file: 'voice-parse.js', type: 'text/javascript; charset=utf-8', cache: NC },
  '/sw.js': { file: 'sw.js', type: 'text/javascript; charset=utf-8', cache: NC },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8', cache: NC },
  '/icons.svg': { file: 'icons.svg', type: 'image/svg+xml', cache: NC },
  '/logo.svg': { file: 'logo.svg', type: 'image/svg+xml', cache: NC },
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json', cache: NC },
  '/icon-192.png': { file: 'icon-192.png', type: 'image/png', cache: NC },
  '/icon-512.png': { file: 'icon-512.png', type: 'image/png', cache: NC },
  '/icon-maskable-512.png': { file: 'icon-maskable-512.png', type: 'image/png', cache: NC },
  '/apple-touch-icon.png': { file: 'apple-touch-icon.png', type: 'image/png', cache: NC },
};

/**
 * The service worker's version: sha256 over the shell files (sorted path + contents), first 12 hex characters.
 * Any change to a shell file therefore changes sw.js, so installed apps see an update. Computed once at startup.
 */
export function shellHash(publicDir: string, files: StaticFiles = STATIC_FILES): string {
  const hash = createHash('sha256');
  for (const path of Object.keys(files).filter((p) => p !== '/sw.js').sort()) {
    hash.update(path).update('\0');
    try { hash.update(readFileSync(join(publicDir, files[path]!.file))); } catch { hash.update('missing'); }
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

/** STATIC_FILES with sw.js served from memory, its __SHELL_HASH__ placeholder replaced. */
function withServiceWorker(publicDir: string): StaticFiles {
  try {
    const src = readFileSync(join(publicDir, 'sw.js'), 'utf8');
    const body = Buffer.from(src.replaceAll('__SHELL_HASH__', shellHash(publicDir)), 'utf8');
    return { ...STATIC_FILES, '/sw.js': { ...STATIC_FILES['/sw.js']!, body } };
  } catch {
    return STATIC_FILES; // no sw.js on disk: the route answers 404
  }
}

export interface NudgeServerDeps extends NudgeApiDeps, Pick<AuthDeps, 'verifyIdToken' | 'mailer' | 'appName'> {
  env: NudgeApiDeps['env'] & AuthDeps['env'];
  publicDir?: string;
}

export function createNudgeServer(deps: NudgeServerDeps): http.Server {
  const auth = createAuth({ ...deps, product: 'tasks' });
  const api = createNudgeApi(deps);
  const authDeps = { db: deps.db, env: deps.env, emailCode: !!deps.mailer };

  return createServerShell({
    name: 'nudge-server',
    hsts: !!deps.env.ADMIN_COOKIE_SECURE,
    csp: NUDGE_CSP,
    files: withServiceWorker(deps.publicDir ?? DEFAULT_NUDGE_PUBLIC_DIR),
    publicDir: deps.publicDir ?? DEFAULT_NUDGE_PUBLIC_DIR,
    async handleApi(req, res, url) {
      checkCsrf(req);
      const segments = apiSegments(url);
      const method = req.method ?? 'GET';
      if (await handleAuthRoute(authDeps, auth, segments.join('/'), method, req, res)) return;

      const user = auth.authenticate(req.headers.cookie);
      if (!user) throw new HttpError(401, 'not signed in');
      const body = method === 'GET' || method === 'HEAD' ? undefined : await readJsonBody(req);
      const result = await api(user, method, segments, url.searchParams, body);
      // A sliding member session that was just extended gets a fresh cookie lifetime.
      sendResult(res, result, user.refreshedCookie ? { 'Set-Cookie': user.refreshedCookie } : {});
    },
  });
}

export function startNudgeServer(deps: NudgeServerDeps, port: number, host: string): http.Server {
  return listenServer(createNudgeServer(deps), 'nudge-server', port, host,
    'nudge server error; Nudge unavailable, call reminders are unaffected');
}
