import http from 'node:http';
import { type DB, getKv } from './db.js';
import { logger } from './logger.js';
import { KV_LAST_SUCCESSFUL_SYNC } from './sync.js';
import type { WhatsApp } from './whatsapp.js';

export const SYNC_STALE_MS = 10 * 60_000;

export interface HealthBody {
  ok: boolean;
  lastSuccessfulSync: string | null;
  syncAgeSeconds: number | null;
  syncOk: boolean;
  waha: { status: string; ok: boolean };
}

export async function checkHealth(
  db: DB,
  whatsapp: Pick<WhatsApp, 'getSessionStatus'>,
  now = new Date(),
): Promise<{ httpStatus: 200 | 503; body: HealthBody }> {
  const last = getKv(db, KV_LAST_SUCCESSFUL_SYNC) ?? null;
  const lastMs = last ? Date.parse(last) : NaN;
  const ageMs = Number.isNaN(lastMs) ? null : now.getTime() - lastMs;
  const syncOk = ageMs !== null && ageMs <= SYNC_STALE_MS;

  let status: string;
  try {
    status = await whatsapp.getSessionStatus();
  } catch (err) {
    status = 'UNREACHABLE';
    logger.warn('health: WAHA session status check failed', { error: err instanceof Error ? err.message : String(err) });
  }
  const wahaOk = status === 'WORKING';
  const ok = syncOk && wahaOk;

  return {
    httpStatus: ok ? 200 : 503,
    body: {
      ok,
      lastSuccessfulSync: last,
      syncAgeSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
      syncOk,
      waha: { status, ok: wahaOk },
    },
  };
}

function send(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function startHealthServer(db: DB, whatsapp: Pick<WhatsApp, 'getSessionStatus'>, port: number): http.Server {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'GET' || path !== '/health') {
      send(res, 404, { ok: false, error: 'not found' });
      return;
    }
    checkHealth(db, whatsapp)
      .then(({ httpStatus, body }) => send(res, httpStatus, body))
      .catch((err) => {
        logger.error('health check crashed', { err });
        try {
          if (!res.headersSent) send(res, 500, { ok: false });
          else res.destroy();
        } catch {
          // never let error handling itself become an unhandled rejection
        }
      });
  });
  server.on('error', (err) => {
    logger.error('health server error; reminders and sync keep running, /health unavailable', { port, err });
  });
  server.listen(port, '0.0.0.0', () => {
    const addr = server.address();
    logger.info('health server listening', { port: typeof addr === 'object' && addr ? addr.port : port });
  });
  return server;
}
