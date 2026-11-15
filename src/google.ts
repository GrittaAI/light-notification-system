import { google, type calendar_v3 } from 'googleapis';
import type { Env } from './config.js';

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

export type Calendar = calendar_v3.Calendar;

export function createOAuthClient(clientId: string, clientSecret: string, redirectUri?: string) {
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/** Calendar client authenticated as the ops Gmail via its refresh token. */
export function createCalendarClient(env: Env): Calendar {
  const auth = createOAuthClient(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });
  return google.calendar({
    version: 'v3',
    auth,
    // Never hang a sync on a stuck request; retry transient 429/5xx/network errors.
    timeout: 30_000,
    retry: true,
  });
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

/** Short, log-friendly description of a googleapis/gaxios error. */
export function describeGoogleError(err: unknown): Record<string, unknown> {
  const e = err as {
    message?: string;
    code?: string | number;
    status?: number;
    response?: { status?: number; data?: { error?: unknown; error_description?: string } };
  };
  const status = e.response?.status ?? e.status;
  const data = e.response?.data;
  const out: Record<string, unknown> = { message: e.message ?? String(err), status, code: e.code };
  if (data?.error === 'invalid_grant') {
    out.reason = 'invalid_grant';
    out.hint = 'refresh token expired or revoked — run `npm run auth` and update GOOGLE_REFRESH_TOKEN';
  } else if (data?.error === 'invalid_client') {
    out.hint = 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are wrong';
  } else if (status === 404) {
    out.hint = 'calendar not found or not shared with the ops Gmail';
  }
  return out;
}
