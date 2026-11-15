import { type DB, getKv, setKv } from './db.js';
import type { Alerts } from './alerts.js';
import { logger } from './logger.js';
import { KV_LAST_SUCCESSFUL_SYNC, type SyncResult } from './sync.js';
import type { WhatsApp } from './whatsapp.js';

const log = logger.child({ module: 'monitor' });

export const SYNC_STALE_MS = 10 * 60_000;
export const WAHA_DEBOUNCE_MS = 3 * 60_000;
export const REALERT_MS = 60 * 60_000;

export interface AlertState {
  failing: boolean;
  /** First time the raw condition was seen failing (used for debounce). */
  failingSince: string | null;
  /** Last alert email sent in this episode. */
  alertedAt: string | null;
}

export type Action = 'alert' | 'recover' | 'none';

const CLEAR: AlertState = { failing: false, failingSince: null, alertedAt: null };

export function decide(
  state: AlertState,
  rawFailing: boolean,
  now: Date,
  debounceMs: number,
): { action: Action; next: AlertState } {
  if (!rawFailing) {
    return { action: state.alertedAt ? 'recover' : 'none', next: { ...CLEAR } };
  }
  const failingSince = state.failingSince ?? now.toISOString();
  const base: AlertState = { failing: true, failingSince, alertedAt: state.alertedAt };
  if (now.getTime() - Date.parse(failingSince) < debounceMs) return { action: 'none', next: base };
  const due = !state.alertedAt || now.getTime() - Date.parse(state.alertedAt) >= REALERT_MS;
  if (!due) return { action: 'none', next: base };
  return { action: 'alert', next: { ...base, alertedAt: now.toISOString() } };
}

export interface MonitorDeps {
  db: DB;
  whatsapp: Pick<WhatsApp, 'getSessionStatus'>;
  alerts: Alerts;
  getLastSyncResult: () => SyncResult | undefined;
  startedAt: Date;
}

interface CheckResult {
  key: string;
  failing: boolean;
  debounceMs: number;
  alertSubject: string;
  alertText: string;
  recoverSubject: string;
  recoverText: string;
}

export interface MonitorSummary {
  checks: Record<string, { failing: boolean; action: Action; emailed: boolean }>;
}

function readState(db: DB, key: string): AlertState {
  const raw = getKv(db, `alert:${key}`);
  if (!raw) return { ...CLEAR };
  try {
    const p = JSON.parse(raw) as Partial<AlertState>;
    return {
      failing: p.failing === true,
      failingSince: typeof p.failingSince === 'string' ? p.failingSince : null,
      alertedAt: typeof p.alertedAt === 'string' ? p.alertedAt : null,
    };
  } catch {
    return { ...CLEAR };
  }
}

function ist(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST';
}

function failedCalendars(result: SyncResult | undefined): string {
  const failed = (result?.calendars ?? []).filter((c) => !c.ok);
  if (failed.length === 0) {
    return (
      'No calendar failed in the last sync run (or no sync result yet). ' +
      'config.json may have failed to reload; check the app logs.'
    );
  }
  return (
    'Calendars that failed in the last sync:\n' +
    failed
      .map((c) => {
        const msg = c.error?.message ?? 'unknown error';
        const hint = c.error?.hint ? ` (${String(c.error.hint)})` : '';
        return `- ${c.client}: ${String(msg)}${hint}`;
      })
      .join('\n')
  );
}

function checkSyncStale(deps: MonitorDeps, now: Date): CheckResult {
  const last = getKv(deps.db, KV_LAST_SUCCESSFUL_SYNC);
  const lastMs = last ? Date.parse(last) : NaN;
  const uptime = now.getTime() - deps.startedAt.getTime();
  const stale = !Number.isNaN(lastMs) && now.getTime() - lastMs > SYNC_STALE_MS;
  const notSinceStart = (Number.isNaN(lastMs) || lastMs < deps.startedAt.getTime()) && uptime >= SYNC_STALE_MS;
  const when = Number.isNaN(lastMs)
    ? 'never'
    : `${new Date(lastMs).toISOString()} (${ist(new Date(lastMs).toISOString())})`;
  return {
    key: 'sync_stale',
    failing: stale || notSinceStart,
    debounceMs: 0,
    alertSubject: 'ALERT: calendar sync is stale',
    alertText:
      `No successful calendar sync for more than 10 minutes. Reminders may be missed.\n` +
      `Last successful sync: ${when}\n\n${failedCalendars(deps.getLastSyncResult())}\n\n` +
      `Check the app logs (docker compose logs app).`,
    recoverSubject: 'RECOVERED: calendar sync working again',
    recoverText: 'Calendar sync is succeeding again.',
  };
}

function checkGoogleAuth(deps: MonitorDeps): CheckResult | null {
  const result = deps.getLastSyncResult();
  if (!result) return null; // no sync yet in this process: nothing to judge
  const bad = result.calendars.filter((c) => c.error?.reason === 'invalid_grant');
  return {
    key: 'google_auth',
    failing: bad.length > 0,
    debounceMs: 0,
    alertSubject: 'ALERT: Google authorization expired or revoked (invalid_grant)',
    alertText:
      `Google rejected the refresh token (invalid_grant). No calendar can sync until it is replaced.\n` +
      `Affected calendars: ${bad.map((c) => c.client).join(', ')}\n\n` +
      `Fix: run \`npm run auth\`, put the new GOOGLE_REFRESH_TOKEN in .env, and restart the app.\n` +
      `Make sure the Google OAuth consent screen is set to "In production"; in "Testing" mode refresh tokens expire after 7 days.`,
    recoverSubject: 'RECOVERED: Google authorization working again',
    recoverText: 'Google calendar authorization is working again.',
  };
}

async function checkWaha(deps: MonitorDeps): Promise<CheckResult> {
  let status: string;
  try {
    status = await deps.whatsapp.getSessionStatus();
  } catch (err) {
    status = 'UNREACHABLE';
    log.warn('waha status check failed', { err: (err as Error).message });
  }
  const todo =
    status === 'SCAN_QR_CODE'
      ? 'Open the WAHA dashboard and scan the QR code with the WhatsApp phone.'
      : status === 'UNREACHABLE'
        ? 'WAHA could not be reached. Check the waha container (docker compose ps / logs waha).'
        : 'Check the WAHA logs (docker compose logs waha).';
  return {
    key: 'waha_session',
    failing: status !== 'WORKING',
    debounceMs: WAHA_DEBOUNCE_MS,
    alertSubject: `ALERT: WhatsApp session not working (${status})`,
    alertText:
      `The WhatsApp session has not been WORKING for at least 3 minutes. Reminders cannot be delivered.\n` +
      `Current status: ${status}\n\n${todo}`,
    recoverSubject: 'RECOVERED: WhatsApp session working again',
    recoverText: 'The WhatsApp session is WORKING again.',
  };
}

/** Evaluates all checks, sends alert/recover emails, and persists state only after a successful send. */
export async function runMonitor(deps: MonitorDeps, now: Date = new Date()): Promise<MonitorSummary> {
  const summary: MonitorSummary = { checks: {} };
  const builders: Array<() => CheckResult | null | Promise<CheckResult | null>> = [
    () => checkSyncStale(deps, now),
    () => checkGoogleAuth(deps),
    () => checkWaha(deps),
  ];
  const keys = ['sync_stale', 'google_auth', 'waha_session'];

  for (let i = 0; i < builders.length; i++) {
    const key = keys[i]!;
    try {
      const check = await builders[i]!();
      if (!check) continue;
      const state = readState(deps.db, key);
      // A failingSince from a previous process must not defeat the debounce after a restart.
      if (state.failingSince && Date.parse(state.failingSince) < deps.startedAt.getTime()) {
        state.failingSince = deps.startedAt.toISOString();
      }
      const { action, next } = decide(state, check.failing, now, check.debounceMs);
      let emailed = false;
      if (action !== 'none') {
        const subject = action === 'alert' ? check.alertSubject : check.recoverSubject;
        const text = action === 'alert' ? check.alertText : check.recoverText;
        try {
          await deps.alerts.send(subject, text);
          emailed = true;
        } catch (err) {
          log.error('monitor email failed; will retry next run', { key, action, err: (err as Error).message });
          summary.checks[key] = { failing: check.failing, action, emailed };
          continue; // state unchanged so the next run retries
        }
        if (action === 'alert') log.warn('monitor alert sent', { key });
        else log.info('monitor recovery sent', { key });
      }
      setKv(deps.db, `alert:${key}`, JSON.stringify(next));
      summary.checks[key] = { failing: check.failing, action, emailed };
    } catch (err) {
      log.error('monitor check crashed', { key, err: (err as Error).message });
    }
  }
  return summary;
}
