// Admin HTTP server (node:http only): static UI from public/admin plus the JSON API under /api.
// Shared plumbing (headers, CSRF, bodies, error mapping, static files) lives in src/http/common.ts.

import type http from 'node:http';
import { fileURLToPath } from 'node:url';
import { handleAuthRoute } from '../http/auth-routes.js';
import {
  apiSegments, checkCsrf, createServerShell, listenServer, readJsonBody, sendResult, type StaticFiles,
} from '../http/common.js';
import { type Auth, type AuthDeps, createAuth, HttpError } from './auth.js';
import { type ApiDeps, createApiHandler } from './routes.js';

/** public/admin relative to the project root (works from src/admin and from dist/admin). */
export const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL('../../public/admin/', import.meta.url));

const STATIC_FILES: StaticFiles = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/icons.svg': { file: 'icons.svg', type: 'image/svg+xml' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};

export interface AdminServerDeps extends ApiDeps, Pick<AuthDeps, 'verifyIdToken'> {
  env: ApiDeps['env'] & AuthDeps['env'];
  publicDir?: string;
}

export function createAdminServer(deps: AdminServerDeps): http.Server {
  const auth: Auth = createAuth({ ...deps, product: 'reminders' });
  const api = createApiHandler(deps);

  return createServerShell({
    name: 'admin-server',
    hsts: !!deps.env.ADMIN_COOKIE_SECURE,
    files: STATIC_FILES,
    publicDir: deps.publicDir ?? DEFAULT_PUBLIC_DIR,
    async handleApi(req, res, url) {
      checkCsrf(req);
      const segments = apiSegments(url);
      const method = req.method ?? 'GET';

      // ----- auth endpoints (no session required) -----
      if (await handleAuthRoute(deps, auth, segments.join('/'), method, req, res)) return;

      // ----- everything else needs a session -----
      const user = auth.authenticate(req.headers.cookie);
      if (!user) throw new HttpError(401, 'not signed in');
      const body = method === 'GET' || method === 'HEAD' ? undefined : await readJsonBody(req);
      const result = await api(user, method, segments, url.searchParams, body);
      sendResult(res, result);
    },
  });
}

/** Starts the admin server. A listen error is logged and never stops the jobs. */
export function startAdminServer(deps: AdminServerDeps, port: number, host: string): http.Server {
  return listenServer(createAdminServer(deps), 'admin-server', port, host,
    'admin server error; reminders and sync keep running, admin UI unavailable', 'admin server listening');
}
