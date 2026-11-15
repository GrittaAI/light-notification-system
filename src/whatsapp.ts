import type { Env } from './config.js';

const REQUEST_TIMEOUT_MS = 15_000;
const STATUS_TIMEOUT_MS = 5_000;

export interface WhatsApp {
  /**
   * Posts `text` to a group, mentioning the given numbers (digits only, e.g. "919876543210").
   * WAHA requires each mentioned number to appear in the text as "@<number>" too.
   * Resolves on a 2xx from WAHA; throws otherwise.
   */
  sendGroupMessage(groupId: string, text: string, mentionNumbers: string[]): Promise<void>;
  /** Live WAHA session status, e.g. "WORKING", "SCAN_QR_CODE", "STARTING", "FAILED", "STOPPED". Throws on error. */
  getSessionStatus(): Promise<string>;
}

export function createWhatsApp(env: Pick<Env, 'WAHA_URL' | 'WAHA_SESSION' | 'WAHA_API_KEY'>): WhatsApp {
  const url = new URL('/api/sendText', env.WAHA_URL).toString();
  const sessionUrl = new URL(`/api/sessions/${encodeURIComponent(env.WAHA_SESSION)}`, env.WAHA_URL).toString();
  return {
    async getSessionStatus() {
      const res = await fetch(sessionUrl, {
        headers: { 'X-Api-Key': env.WAHA_API_KEY },
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`WAHA session status failed: HTTP ${res.status}`);
      const data = (await res.json()) as { status?: unknown };
      if (typeof data.status !== 'string' || !data.status) throw new Error('WAHA session status missing in response');
      return data.status;
    },
    async sendGroupMessage(groupId, text, mentionNumbers) {
      const res = await fetch(url, {
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
