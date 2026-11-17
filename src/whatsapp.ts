import type { Env } from './config.js';

const REQUEST_TIMEOUT_MS = 15_000;
const STATUS_TIMEOUT_MS = 5_000;

export interface WhatsAppSession {
  status: string;
  /** Linked account (WAHA "me"); null when no number is linked. */
  me: { phone: string; name: string } | null;
}

/** Session management calls used by the superadmin WhatsApp page (WAHA sessions + auth API). */
export interface WhatsAppAdmin {
  getSession(): Promise<WhatsAppSession>;
  /** QR code as PNG bytes. Only valid while the status is SCAN_QR_CODE. */
  getQrPng(): Promise<Buffer>;
  startSession(): Promise<void>;
  restartSession(): Promise<void>;
  /** Logs the linked number out (WAHA then restarts the session, waiting for a new QR). */
  logoutSession(): Promise<void>;
  /** Pairing code to type into WhatsApp (Linked devices > Link with phone number). Digits only, with country code. */
  requestPairingCode(phoneNumber: string): Promise<string>;
}

export interface WhatsApp extends WhatsAppAdmin {
  /**
   * Posts `text` to a group, mentioning the given numbers (digits only, e.g. "919876543210").
   * WAHA requires each mentioned number to appear in the text as "@<number>" too.
   * Resolves on a 2xx from WAHA; throws otherwise.
   */
  sendGroupMessage(groupId: string, text: string, mentionNumbers: string[]): Promise<void>;
  /**
   * Sends a direct message to one chat id (e.g. "919876543210@c.us"), no mentions. Used by Nudge.
   * Same timeout and error shape as sendGroupMessage; the API key never appears in errors.
   */
  sendDirectMessage(chatId: string, text: string): Promise<void>;
  /** Live WAHA session status, e.g. "WORKING", "SCAN_QR_CODE", "STARTING", "FAILED", "STOPPED". Throws on error. */
  getSessionStatus(): Promise<string>;
  /** WhatsApp groups the session is in, sorted by name. Throws on error. */
  listGroups(): Promise<WhatsAppGroup[]>;
}

export interface WhatsAppGroup {
  id: string;
  name: string;
}

/** Normalises WAHA's groups response: id may be a string or { _serialized }; only @g.us ids are kept. */
export function normalizeGroups(data: unknown): WhatsAppGroup[] {
  const items: unknown[] = Array.isArray(data) ? data : data && typeof data === 'object' ? Object.values(data) : [];
  const groups: WhatsAppGroup[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const g = raw as Record<string, unknown>;
    const idRaw = g.id ?? g.JID;
    const id =
      typeof idRaw === 'string' ? idRaw
      : idRaw && typeof idRaw === 'object' && typeof (idRaw as Record<string, unknown>)._serialized === 'string'
        ? ((idRaw as Record<string, unknown>)._serialized as string)
        : '';
    if (!id.endsWith('@g.us')) continue;
    const nameRaw = g.name ?? g.subject ?? g.Name;
    groups.push({ id, name: typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim() : id });
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name));
}

export function createWhatsApp(
  env: Pick<Env, 'WAHA_URL' | 'WAHA_SESSION' | 'WAHA_API_KEY'>,
  fetchImpl: typeof fetch = fetch,
): WhatsApp {
  const url = new URL('/api/sendText', env.WAHA_URL).toString();
  const sessionUrl = new URL(`/api/sessions/${encodeURIComponent(env.WAHA_SESSION)}`, env.WAHA_URL).toString();
  const groupsUrl = new URL(`/api/${encodeURIComponent(env.WAHA_SESSION)}/groups?exclude=participants`, env.WAHA_URL).toString();
  const sessionBase = `/api/sessions/${encodeURIComponent(env.WAHA_SESSION)}`;
  const api = (path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS) =>
    fetchImpl(new URL(path, env.WAHA_URL).toString(), {
      ...init,
      headers: { 'X-Api-Key': env.WAHA_API_KEY, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  const post = async (path: string, what: string, body?: unknown) => {
    const res = await api(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) throw new Error(`WAHA ${what} failed: HTTP ${res.status}`);
    return res;
  };
  return {
    async getSession() {
      const res = await api(sessionBase, {}, STATUS_TIMEOUT_MS);
      if (!res.ok) throw new Error(`WAHA session info failed: HTTP ${res.status}`);
      const data = (await res.json()) as { status?: unknown; me?: { id?: unknown; pushName?: unknown } | null };
      if (typeof data.status !== 'string' || !data.status) throw new Error('WAHA session status missing in response');
      const id = typeof data.me?.id === 'string' ? data.me.id : '';
      const phone = id.split('@')[0]!.split(':')[0]!;
      const me = phone ? { phone, name: typeof data.me?.pushName === 'string' ? data.me.pushName : '' } : null;
      return { status: data.status, me };
    },
    async getQrPng() {
      const res = await api(`/api/${encodeURIComponent(env.WAHA_SESSION)}/auth/qr`, { headers: { Accept: 'image/png' } }, STATUS_TIMEOUT_MS);
      if (!res.ok) throw new Error(`WAHA QR failed: HTTP ${res.status}`);
      if ((res.headers.get('content-type') ?? '').includes('json')) {
        const j = (await res.json()) as { data?: unknown };
        if (typeof j.data !== 'string') throw new Error('WAHA QR response missing data');
        return Buffer.from(j.data, 'base64');
      }
      return Buffer.from(await res.arrayBuffer());
    },
    async startSession() { await post(`${sessionBase}/start`, 'start'); },
    async restartSession() { await post(`${sessionBase}/restart`, 'restart'); },
    async logoutSession() { await post(`${sessionBase}/logout`, 'logout'); },
    async requestPairingCode(phoneNumber) {
      const res = await post(`/api/${encodeURIComponent(env.WAHA_SESSION)}/auth/request-code`, 'pairing code', { phoneNumber });
      const data = (await res.json()) as { code?: unknown };
      if (typeof data.code !== 'string' || !data.code) throw new Error('WAHA pairing code missing in response');
      return data.code;
    },
    async listGroups() {
      const res = await fetchImpl(groupsUrl, {
        headers: { 'X-Api-Key': env.WAHA_API_KEY },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`WAHA groups failed: HTTP ${res.status}`);
      return normalizeGroups(await res.json());
    },
    async getSessionStatus() {
      const res = await fetchImpl(sessionUrl, {
        headers: { 'X-Api-Key': env.WAHA_API_KEY },
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`WAHA session status failed: HTTP ${res.status}`);
      const data = (await res.json()) as { status?: unknown };
      if (typeof data.status !== 'string' || !data.status) throw new Error('WAHA session status missing in response');
      return data.status;
    },
    async sendDirectMessage(chatId, text) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': env.WAHA_API_KEY },
        body: JSON.stringify({ session: env.WAHA_SESSION, chatId, text }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 500);
        throw new Error(`WAHA sendText failed: HTTP ${res.status} ${body}`);
      }
    },
    async sendGroupMessage(groupId, text, mentionNumbers) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': env.WAHA_API_KEY },
        body: JSON.stringify({
          session: env.WAHA_SESSION,
          chatId: groupId,
          text,
          mentions: mentionNumbers.map((n) => `${n}@c.us`),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 500);
        throw new Error(`WAHA sendText failed: HTTP ${res.status} ${body}`);
      }
    },
  };
}
