import { logger } from './logger.js';
import type { SyncResult } from './sync.js';
import type { WhatsApp } from './whatsapp.js';

export interface StartupSummary {
  ok: boolean;
  waha: { status: string; ok: boolean };
  calendars: { ok: number; total: number; failing: { client: string; error: string }[] };
}

function errorText(error: Record<string, unknown> | undefined): string {
  if (!error) return 'unknown error';
  const message = typeof error.message === 'string' && error.message ? error.message : 'unknown error';
  const hint = typeof error.hint === 'string' && error.hint ? error.hint : undefined;
  return hint ? `${message} (${hint})` : message;
}

/** Pure: builds the startup check summary from the startup sync result and a WAHA session status. */
export function startupSummary(sync: SyncResult | undefined, wahaStatus: string): StartupSummary {
  const calendars = sync?.calendars ?? [];
  const failing = calendars
    .filter((c) => !c.ok)
    .map((c) => ({ client: c.client, error: errorText(c.error) }));
  const total = calendars.length;
  const wahaOk = wahaStatus === 'WORKING';
  return {
    ok: wahaOk && sync !== undefined && failing.length === 0 && total > 0,
    waha: { status: wahaStatus, ok: wahaOk },
    calendars: { ok: total - failing.length, total, failing },
  };
}

/** Logs one "startup check" line. Never throws. */
export async function logStartupSummary(
  getLastSyncResult: () => SyncResult | undefined,
  whatsapp: Pick<WhatsApp, 'getSessionStatus'>,
): Promise<void> {
  let status: string;
  try {
    status = await whatsapp.getSessionStatus();
  } catch {
    status = 'UNREACHABLE';
  }
  const summary = startupSummary(getLastSyncResult(), status);
  const fields = { ok: summary.ok, waha: summary.waha, calendars: summary.calendars };
  if (summary.ok) logger.info('startup check', fields);
  else logger.warn('startup check', fields);
}
