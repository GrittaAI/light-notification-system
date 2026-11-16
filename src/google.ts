import { readFileSync, statSync } from 'node:fs';
import { google, type calendar_v3 } from 'googleapis';
import { ConfigError, type Env } from './config.js';

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

export type Calendar = calendar_v3.Calendar;

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/**
 * Loads the service account key from GOOGLE_SERVICE_ACCOUNT_KEY_FILE or
 * GOOGLE_SERVICE_ACCOUNT_JSON. Errors never include the key material or raw JSON.
 */
export function loadServiceAccountKey(
  env: Pick<Env, 'GOOGLE_SERVICE_ACCOUNT_KEY_FILE' | 'GOOGLE_SERVICE_ACCOUNT_JSON'>,
): ServiceAccountKey {
  const file = env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  const inline = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (file && inline) {
    throw new ConfigError('set only one of GOOGLE_SERVICE_ACCOUNT_KEY_FILE and GOOGLE_SERVICE_ACCOUNT_JSON, not both');
  }
  if (!file && !inline) {
    throw new ConfigError('set one of GOOGLE_SERVICE_ACCOUNT_KEY_FILE or GOOGLE_SERVICE_ACCOUNT_JSON');
  }

  let text: string;
  let source: string;
  if (file) {
    source = file;
    try {
      if (statSync(file).isDirectory()) {
        throw new ConfigError(
          `GOOGLE_SERVICE_ACCOUNT_KEY_FILE (${file}) is a directory, not a file. ` +
            'Docker creates a directory when the mounted key file does not exist on the host; ' +
            'remove the directory and put the real JSON key file there.',
        );
      }
      text = readFileSync(file, 'utf8');
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      throw new ConfigError(`cannot read service account key file ${file}${code ? ` (${code})` : ''}`);
    }
  } else {
    source = 'GOOGLE_SERVICE_ACCOUNT_JSON';
    text = inline!;
  }

  // Do not include the parser's message: it can quote part of the input.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError(`${source} is not valid JSON; expected the service account JSON key downloaded from Google Cloud`);
  }
  const key = (parsed ?? {}) as Record<string, unknown>;
  if (typeof parsed !== 'object' || parsed === null || key.type !== 'service_account') {
    throw new ConfigError(`${source} is not a service account key (its "type" must be "service_account")`);
  }
  const clientEmail = key.client_email;
  const privateKey = key.private_key;
  if (typeof clientEmail !== 'string' || !clientEmail.trim()) {
    throw new ConfigError(`${source} is missing "client_email"`);
  }
  if (typeof privateKey !== 'string' || !privateKey.trim()) {
    throw new ConfigError(`${source} is missing "private_key"`);
  }
  return { client_email: clientEmail.trim(), private_key: privateKey };
}

/** Calendar client authenticated as the service account (calendar.readonly). */
export function createCalendarClient(env: Env): { calendar: Calendar; clientEmail: string } {
  const key = loadServiceAccountKey(env);
  const auth = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: [CALENDAR_SCOPE] });
  const calendar = google.calendar({
    version: 'v3',
    auth,
    // Never hang a sync on a stuck request; retry transient 429/5xx/network errors.
    timeout: 30_000,
    retry: true,
  });
  return { calendar, clientEmail: key.client_email };
}

export type FetchEvent = (calendarId: string, eventId: string) => Promise<calendar_v3.Schema$Event>;

/**
 * Fetches one event live. Short timeout and no retries: this runs just before a
 * reminder is sent, and a slow answer must not push the send past its grace window.
 */
export function createEventFetcher(calendar: Calendar): FetchEvent {
  return async (calendarId, eventId) => {
    const res = await calendar.events.get({ calendarId, eventId }, { timeout: 10_000, retry: false });
    return res.data;
  };
}

interface GoogleErrorShape {
  message?: string;
  code?: string | number;
  status?: number;
  response?: {
    status?: number;
    data?: {
      error?: string | { errors?: { reason?: string }[]; status?: string; message?: string };
      error_description?: string;
    };
  };
}

const NOT_SHARED_EXCLUDED_REASONS = new Set([
  'accessNotConfigured',
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
]);

function httpStatus(err: unknown): number | undefined {
  const e = err as GoogleErrorShape;
  return e.response?.status ?? e.status;
}

/** Google's error reason (e.g. accessNotConfigured, notFound), if the response carries one. */
function googleReason(err: unknown): string | undefined {
  const error = (err as GoogleErrorShape).response?.data?.error;
  if (!error || typeof error === 'string') return undefined;
  const reason = error.errors?.[0]?.reason;
  if (reason) return reason;
  const text = `${error.status ?? ''} ${error.message ?? ''}`;
  if (/accessNotConfigured|has not been used in project|API has not been used|is disabled/i.test(text)) {
    return 'accessNotConfigured';
  }
  return undefined;
}

/**
 * True when a calendar fetch error most likely means the calendar is not shared with
 * the service account: 404, or 403 unless it is an API-disabled or quota/rate-limit error.
 */
export function isNotShared(err: unknown): boolean {
  const status = httpStatus(err);
  if (status === 404) return true;
  if (status === 403) {
    const reason = googleReason(err);
    return !(reason && NOT_SHARED_EXCLUDED_REASONS.has(reason));
  }
  return false;
}

/** Short, log-friendly description of a googleapis/gaxios error. */
export function describeGoogleError(err: unknown): Record<string, unknown> {
  const e = err as GoogleErrorShape;
  const status = httpStatus(err);
  const data = e.response?.data;
  const out: Record<string, unknown> = { message: e.message ?? String(err), status, code: e.code };
  if (data?.error === 'invalid_grant') {
    out.reason = 'invalid_grant';
    out.hint = 'service account key deleted or revoked, or the server clock is wrong — create a new JSON key';
  } else if (data?.error === 'invalid_client') {
    out.hint = 'service account key invalid';
  } else if (status === 403 && googleReason(err) === 'accessNotConfigured') {
    out.hint = "enable the Google Calendar API in the service account's project";
  }
  return out;
}
