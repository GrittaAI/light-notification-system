// Nudge's own small health check: GET /health on TASKS_HEALTH_PORT. WAHA session status and the last nudge-job run.
// Healthy = WAHA session WORKING and the nudge job ran within the last 5 minutes.

import http from 'node:http';
import { logger } from '../logger.js';
import type { WhatsApp } from '../whatsapp.js';

export const NUDGE_STALE_MS = 5 * 60_000;

export interface NudgeTracker {
  /** When the nudge job last finished a run (any outcome), or undefined if it has not run yet. */
  lastRunAt?: Date;
  lastRunOk?: boolean;
}

export interface NudgeHealthBody {
  ok: boolean;
  waha: { status: string; ok: boolean };
  lastNudgeRun: string | null;
  nudgeAgeSeconds: number | null;
  nudgeOk: boolean;
}

export async function checkNudgeHealth(
  whatsapp: Pick<WhatsApp, 'getSessionStatus'>, tracker: NudgeTracker, now = new Date(),
): Promise<{ httpStatus: 200 | 503; body: NudgeHealthBody }> {
  let status: string;
  try {
    status = await whatsapp.getSessionStatus();
  } catch (err) {
    status = 'UNREACHABLE';
    logger.warn('nudge health: WAHA session status check failed', { error: err instanceof Error ? err.message : String(err) });
  }
  const wahaOk = status === 'WORKING';
  const age = tracker.lastRunAt ? now.getTime() - tracker.lastRunAt.getTime() : null;
  const nudgeOk = age !== null && age <= NUDGE_STALE_MS;
  const ok = wahaOk && nudgeOk;
  return {
    httpStatus: ok ? 200 : 503,
    body: {
      ok,
      waha: { status, ok: wahaOk },
      lastNudgeRun: tracker.lastRunAt?.toISOString() ?? null,
      nudgeAgeSeconds: age === null ? null : Math.round(age / 1000),
      nudgeOk,
    },
  };
}

function send(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function startNudgeHealthServer(whatsapp: Pick<WhatsApp, 'getSessionStatus'>, tracker: NudgeTracker, port: number): http.Server {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'GET' || path !== '/health') return send(res, 404, { ok: false, error: 'not found' });
    checkNudgeHealth(whatsapp, tracker)
      .then(({ httpStatus, body }) => send(res, httpStatus, body))
      .catch((err) => {
        logger.error('nudge health check crashed', { err });
        try {
          if (!res.headersSent) send(res, 500, { ok: false });
          else res.destroy();
        } catch {
          // never let error handling itself become an unhandled rejection
        }
      });
  });
  server.on('error', (err) => logger.error('nudge health server error; Nudge keeps running, /health unavailable', { port, err }));
  server.listen(port, '0.0.0.0', () => {
    const addr = server.address();
    logger.info('nudge health server listening', { port: typeof addr === 'object' && addr ? addr.port : port });
  });
  return server;
}
