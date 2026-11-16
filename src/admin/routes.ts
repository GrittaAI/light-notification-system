// Authenticated JSON API (everything under /api except the auth endpoints).
// Handlers return data or throw HttpError / StoreError; server.ts maps those to responses.

import type { Env } from '../config.js';
import { checkHealth } from '../health.js';
import type { DB } from '../db.js';
import { logger } from '../logger.js';
import { matchClosers } from '../reminders.js';
import {
  addAdmin, addAudit, createClient, createCloser, deleteClient, deleteCloser, getClient, getOffsets, listAdmins,
  listAudit, listClients, listClosers, loadRuntimeConfig, removeAdmin, setOffsets, updateClient, updateCloser,
} from '../store.js';
import type { EventRow, SyncResult } from '../sync.js';
import type { WhatsApp, WhatsAppAdmin, WhatsAppGroup } from '../whatsapp.js';
import { HttpError, type SessionUser } from './auth.js';

const log = logger.child({ module: 'admin-api' });

export const TEST_MESSAGE = '✅ Test message from Pushup reminders — this group is set up correctly.';
export const GROUPS_CACHE_MS = 5 * 60_000;

export interface ApiDeps {
  db: DB;
  env: Pick<Env, 'SUPERADMIN_EMAIL'>;
  whatsapp: Pick<WhatsApp, 'getSessionStatus' | 'sendGroupMessage' | 'listGroups'> & Partial<WhatsAppAdmin>;
  getLastSyncResult: () => SyncResult | undefined;
  serviceAccountEmail?: string;
  now?: () => Date;
}

export interface ApiResult {
  status: number;
  body: unknown;
  /** Raw bytes instead of JSON (the QR image). */
  binary?: { type: string; data: Buffer };
}

const ok = (body: unknown, status = 200): ApiResult => ({ status, body });

const istFormat = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
});
const formatIst = (iso: string) => istFormat.format(new Date(iso)).replace(/[  ]/g, ' ') + ' IST';

function parseId(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new HttpError(404, 'not found');
  return Number(raw);
}

/** Groups list with a 5 minute cache (?refresh=1 bypasses it). */
export function createGroupsCache(list: () => Promise<WhatsAppGroup[]>, now: () => Date = () => new Date()) {
  let cached: { at: number; groups: WhatsAppGroup[] } | undefined;
  const get = async (refresh: boolean): Promise<WhatsAppGroup[]> => {
    const t = now().getTime();
    if (!refresh && cached && t - cached.at < GROUPS_CACHE_MS) return cached.groups;
    const groups = await list();
    cached = groups.length ? { at: t, groups } : undefined; // never cache an empty list: retry next time
    return groups;
  };
  get.invalidate = () => { cached = undefined; };
  return get;
}

const WAHA_LABELS: Record<string, string> = {
  WORKING: 'Connected', SCAN_QR_CODE: 'QR scan needed', STARTING: 'Starting…', FAILED: 'Failed', STOPPED: 'Stopped',
  PASSKEY_REQUIRED: 'Approve on phone', PASSKEY_CONFIRMATION_REQUIRED: 'Approve on phone',
};
const SESSION_ROUTES = new Set(['session', 'qr', 'start', 'restart', 'logout', 'switch-number', 'pairing-code']);

async function status(deps: ApiDeps): Promise<ApiResult> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const health = (await checkHealth(db, deps.whatsapp, now)).body;
  const { closers, clients } = loadRuntimeConfig(db);
  const activeCalendars = new Set(clients.map((c) => c.calendarId));

  const until = new Date(now.getTime() + 24 * 3600_000).toISOString();
  const events = db
    .prepare(`SELECT * FROM events WHERE start_utc > ? AND start_utc <= ? AND status != 'removed' ORDER BY start_utc, client_name`)
    .all(now.toISOString(), until) as EventRow[];
  const upcoming = events.filter((e) => activeCalendars.has(e.calendar_id)).map((e) => ({
    startUtc: e.start_utc,
    startIst: formatIst(e.start_utc),
    client: e.client_name,
    title: e.title,
    status: e.status,
    closers: matchClosers(e, closers).map((c) => c.name),
  }));

  const recent = db
    .prepare(`
      SELECT r.sent_at, r.status, r.offset_min, r.start_utc, r.calendar_id, e.title, e.client_name
      FROM sent_reminders r LEFT JOIN events e ON e.event_id = r.event_id AND e.calendar_id = r.calendar_id
      ORDER BY r.sent_at DESC, r.rowid DESC LIMIT 20`)
    .all() as { sent_at: string; status: string; offset_min: number; start_utc: string; calendar_id: string; title: string | null; client_name: string | null }[];

  const sync = deps.getLastSyncResult();
  return ok({
    health,
    serviceAccountEmail: deps.serviceAccountEmail ?? null,
    sync: sync ? { ok: sync.ok, startedAt: sync.startedAt, calendars: sync.calendars } : null,
    upcoming,
    recentReminders: recent.map((r) => ({
      sentAt: r.sent_at,
      sentAtIst: formatIst(r.sent_at),
      status: r.status,
      offsetMin: r.offset_min,
      callStartIst: formatIst(r.start_utc),
      client: r.client_name,
      title: r.title ?? '',
    })),
  });
}

export function createApiHandler(deps: ApiDeps) {
  const { db } = deps;
  const groups = createGroupsCache(() => deps.whatsapp.listGroups(), deps.now);

  /** Superadmin-only WhatsApp session management. Every WAHA failure becomes a 502 (messages never contain the API key). */
  async function whatsappAdmin(user: SessionUser, method: string, route: string, nSegments: number, body: unknown): Promise<ApiResult> {
    if (user.role !== 'superadmin') throw new HttpError(403, 'superadmin only');
    const wa = deps.whatsapp;
    const audit = (a: string, details: Record<string, unknown> = {}) => addAudit(db, user.email, a, details);
    const waha = async <T>(what: string, fn: ((() => Promise<T>)) | undefined): Promise<T> => {
      if (!fn) throw new HttpError(501, 'not supported');
      try {
        return await fn();
      } catch (err) {
        log.error('whatsapp admin call failed', { what, err });
        throw new HttpError(502, `WhatsApp (WAHA) ${what} failed: ${(err as Error).message}`);
      }
    };
    if (nSegments !== 2) throw new HttpError(404, 'not found');
    const confirmed = (body as { confirm?: unknown } | null | undefined)?.confirm === true;

    if (route === 'session' && method === 'GET') {
      const s = await waha('status', wa.getSession?.bind(wa));
      return ok({ status: s.status, label: WAHA_LABELS[s.status] ?? s.status, me: s.me, checkedAt: (deps.now ?? (() => new Date()))().toISOString() });
    }
    if (route === 'qr' && method === 'GET') {
      const s = await waha('status', wa.getSession?.bind(wa));
      if (s.status !== 'SCAN_QR_CODE') throw new HttpError(409, 'not waiting for QR');
      const png = await waha('QR code', wa.getQrPng?.bind(wa));
      return { status: 200, body: null, binary: { type: 'image/png', data: png } };
    }
    if (route === 'start' && method === 'POST') {
      await waha('start', wa.startSession?.bind(wa));
      groups.invalidate();
      audit('whatsapp_start');
      return ok({ ok: true });
    }
    if (route === 'restart' && method === 'POST') {
      await waha('restart', wa.restartSession?.bind(wa));
      groups.invalidate();
      audit('whatsapp_restart');
      return ok({ ok: true });
    }
    if (route === 'logout' && method === 'POST') {
      if (!confirmed) throw new HttpError(400, 'confirmation required: send { "confirm": true }');
      await waha('logout', wa.logoutSession?.bind(wa));
      groups.invalidate();
      audit('whatsapp_logout');
      return ok({ ok: true });
    }
    if (route === 'switch-number' && method === 'POST') {
      if (!confirmed) throw new HttpError(400, 'confirmation required: send { "confirm": true }');
      await waha('logout', wa.logoutSession?.bind(wa));
      groups.invalidate();
      try {
        await waha('start after logout', wa.startSession?.bind(wa));
      } catch (err) {
        audit('whatsapp_switch_number', { logoutOk: true, startOk: false });
        throw err;
      }
      audit('whatsapp_switch_number', { logoutOk: true, startOk: true });
      return ok({ ok: true });
    }
    if (route === 'pairing-code' && method === 'POST') {
      const raw = (body as { phoneNumber?: unknown } | null | undefined)?.phoneNumber;
      const digits = typeof raw === 'string' ? raw.replace(/[\s+()-]/g, '') : '';
      if (!/^[1-9]\d{7,14}$/.test(digits)) {
        throw new HttpError(400, 'invalid phone number', { phoneNumber: 'Use digits with the country code, e.g. 919876543210.' });
      }
      const code = await waha('pairing code', wa.requestPairingCode ? () => wa.requestPairingCode!(digits) : undefined);
      audit('whatsapp_pairing_code', { phone: digits.slice(-4).padStart(digits.length, '*') });
      return ok({ code });
    }
    throw new HttpError(404, 'not found');
  }

  return async function handle(
    user: SessionUser, method: string, segments: string[], query: URLSearchParams, body: unknown,
  ): Promise<ApiResult> {
    const [resource, idRaw, action] = segments;
    const audit = (a: string, details: Record<string, unknown>) => addAudit(db, user.email, a, details);
    const hard = query.get('hard') === '1';

    switch (resource) {
      case 'me':
        if (method === 'GET' && segments.length === 1) return ok({ email: user.email, role: user.role });
        break;

      case 'closers':
        if (segments.length === 1 && method === 'GET') return ok(listClosers(db));
        if (segments.length === 1 && method === 'POST') {
          const row = createCloser(db, body);
          audit('closer_create', { id: row.id, email: row.email });
          return ok(row, 201);
        }
        if (segments.length === 2 && method === 'PUT') {
          const row = updateCloser(db, parseId(idRaw!), body);
          audit('closer_update', { id: row.id, email: row.email, active: row.active });
          return ok(row);
        }
        if (segments.length === 2 && method === 'DELETE') {
          const row = deleteCloser(db, parseId(idRaw!), hard);
          audit(hard ? 'closer_hard_delete' : 'closer_disable', { id: row.id, email: row.email });
          return ok({ ok: true });
        }
        break;

      case 'clients':
        if (segments.length === 1 && method === 'GET') return ok(listClients(db));
        if (segments.length === 1 && method === 'POST') {
          const row = createClient(db, body);
          audit('client_create', { id: row.id, name: row.name, calendarId: row.calendarId, whatsappGroupId: row.whatsappGroupId });
          return ok(row, 201);
        }
        if (segments.length === 2 && method === 'PUT') {
          const row = updateClient(db, parseId(idRaw!), body);
          audit('client_update', { id: row.id, name: row.name, calendarId: row.calendarId, whatsappGroupId: row.whatsappGroupId, active: row.active });
          return ok(row);
        }
        if (segments.length === 2 && method === 'DELETE') {
          const row = deleteClient(db, parseId(idRaw!), hard);
          audit(hard ? 'client_hard_delete' : 'client_disable', { id: row.id, name: row.name, calendarId: row.calendarId });
          return ok({ ok: true });
        }
        if (segments.length === 3 && action === 'test-message' && method === 'POST') {
          const client = getClient(db, parseId(idRaw!));
          if (!client) throw new HttpError(404, 'client not found');
          try {
            await deps.whatsapp.sendGroupMessage(client.whatsappGroupId, TEST_MESSAGE, []);
          } catch (err) {
            log.error('test message failed', { clientId: client.id, err });
            throw new HttpError(502, `WhatsApp send failed: ${(err as Error).message}`);
          }
          audit('send_test_message', { clientId: client.id, name: client.name, whatsappGroupId: client.whatsappGroupId });
          return ok({ ok: true });
        }
        break;

      case 'settings':
        if (segments.length === 1 && method === 'GET') {
          const { offsets, updatedAt } = getOffsets(db);
          return ok({ reminderOffsets: offsets, updatedAt });
        }
        if (segments.length === 1 && method === 'PUT') {
          const input = (body as { reminderOffsets?: unknown } | null)?.reminderOffsets;
          const { offsets, updatedAt } = setOffsets(db, input);
          audit('settings_update', { reminderOffsets: offsets });
          return ok({ reminderOffsets: offsets, updatedAt });
        }
        break;

      case 'admins':
        if (user.role !== 'superadmin') throw new HttpError(403, 'superadmin only');
        if (segments.length === 1 && method === 'GET') {
          return ok({ superadmin: deps.env.SUPERADMIN_EMAIL, admins: listAdmins(db) });
        }
        if (segments.length === 1 && method === 'POST') {
          const row = addAdmin(db, body, user.email, deps.env.SUPERADMIN_EMAIL);
          audit('admin_add', { email: row.email });
          return ok(row, 201);
        }
        if (segments.length === 2 && method === 'DELETE') {
          const email = removeAdmin(db, idRaw!, deps.env.SUPERADMIN_EMAIL);
          audit('admin_remove', { email });
          return ok({ ok: true });
        }
        break;

      case 'status':
        if (segments.length === 1 && method === 'GET') return status(deps);
        break;

      case 'whatsapp':
        if (idRaw && SESSION_ROUTES.has(idRaw)) return whatsappAdmin(user, method, idRaw, segments.length, body);
        if (idRaw === 'groups' && segments.length === 2 && method === 'GET') {
          try {
            return ok(await groups(query.get('refresh') === '1'));
          } catch (err) {
            throw new HttpError(502, `could not list WhatsApp groups: ${(err as Error).message}`);
          }
        }
        break;

      case 'audit':
        if (segments.length === 1 && method === 'GET') return ok(listAudit(db, 100));
        break;
    }
    throw new HttpError(404, 'not found');
  };
}
