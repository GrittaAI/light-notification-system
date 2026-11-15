import type { calendar_v3 } from 'googleapis';
import { type AppConfig, type Client, loadConfigOrLastGood } from './config.js';
import { type DB, setKv } from './db.js';
import { type Calendar, describeGoogleError } from './google.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'sync' });

export const SYNC_WINDOW_HOURS = 26;
export const KV_LAST_SUCCESSFUL_SYNC = 'last_successful_sync';

/** Status we set on a stored future event that Google no longer returns in the window. */
export const STATUS_REMOVED = 'removed';

export interface EventRow {
  event_id: string;
  calendar_id: string;
  client_name: string;
  title: string;
  start_utc: string;
  end_utc: string;
  status: string;
  meet_link: string | null;
  attendees_json: string;
  /** When sync first stored this event; never changed afterwards. */
  first_seen_utc: string;
}

/** Event fields that come from Google (everything except bookkeeping columns). */
export type EventData = Omit<EventRow, 'first_seen_utc'>;

export interface CalendarResult {
  client: string;
  ok: boolean;
  upserted: number;
  cancelled: number;
  removed: number;
  skippedAllDay: number;
  error?: Record<string, unknown>;
}

export interface SyncResult {
  ok: boolean;
  startedAt: string;
  calendars: CalendarResult[];
}

function currentConfig(): { config: AppConfig; fresh: boolean } {
  const { config, fresh, error } = loadConfigOrLastGood();
  if (error) log.error('config reload failed; using last valid config', { err: error });
  return { config, fresh };
}

async function listEvents(calendar: Calendar, calendarId: string, timeMin: string, timeMax: string) {
  const items: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;
  do {
    const res = await calendar.events.list({
      calendarId,
      singleEvents: true,
      orderBy: 'startTime',
      timeMin,
      timeMax,
      showDeleted: true,
      maxResults: 250,
      pageToken,
    });
    items.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return items;
}

export function toUtcIso(dateTime: string): string {
  return new Date(dateTime).toISOString();
}

function attendeeEmails(ev: calendar_v3.Schema$Event): string[] {
  const emails = (ev.attendees ?? [])
    .map((a) => a.email?.trim().toLowerCase())
    .filter((e): e is string => !!e);
  return [...new Set(emails)];
}

/** Maps a Google event to our row fields. Returns null for all-day events (no dateTime). */
export function eventDataFromGoogle(ev: calendar_v3.Schema$Event, calendarId: string, clientName: string): EventData | null {
  if (!ev.id || !ev.start?.dateTime || !ev.end?.dateTime) return null;
  return {
    event_id: ev.id,
    calendar_id: calendarId,
    client_name: clientName,
    title: ev.summary ?? '',
    start_utc: toUtcIso(ev.start.dateTime),
    end_utc: toUtcIso(ev.end.dateTime),
    status: ev.status ?? 'confirmed',
    meet_link: ev.hangoutLink ?? null,
    attendees_json: JSON.stringify(attendeeEmails(ev)),
  };
}

/**
 * The single way event data is written to `events` (used by sync and by the live
 * re-check before sending). first_seen_utc means "when the current start_utc was
 * first seen": set to `nowIso` on insert or when start_utc changes, kept otherwise.
 * (In the UPDATE branch, `events.start_utc` still refers to the stored, old value.)
 */
export function upsertEvent(db: DB, data: EventData, nowIso: string): void {
  db.prepare(`
    INSERT INTO events (event_id, calendar_id, client_name, title, start_utc, end_utc, status, meet_link, attendees_json, updated_at, first_seen_utc)
    VALUES (@event_id, @calendar_id, @client_name, @title, @start_utc, @end_utc, @status, @meet_link, @attendees_json, @now, @now)
    ON CONFLICT(event_id, calendar_id) DO UPDATE SET
      first_seen_utc = CASE WHEN events.start_utc = excluded.start_utc THEN events.first_seen_utc ELSE excluded.first_seen_utc END,
      client_name = excluded.client_name, title = excluded.title,
      start_utc = excluded.start_utc, end_utc = excluded.end_utc, status = excluded.status,
      meet_link = excluded.meet_link, attendees_json = excluded.attendees_json, updated_at = excluded.updated_at`,
  ).run({ ...data, now: nowIso });
}

/** Fetches one client calendar and writes it to the DB in a single transaction. */
async function syncCalendar(db: DB, calendar: Calendar, client: Client, now: Date): Promise<CalendarResult> {
  const result: CalendarResult = {
    client: client.name, ok: false, upserted: 0, cancelled: 0, removed: 0, skippedAllDay: 0,
  };
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + SYNC_WINDOW_HOURS * 3600_000).toISOString();

  let items: calendar_v3.Schema$Event[];
  try {
    items = await listEvents(calendar, client.calendarId, timeMin, timeMax);
  } catch (err) {
    result.error = describeGoogleError(err);
    log.error('calendar fetch failed', { client: client.name, calendarId: client.calendarId, ...result.error });
    return result;
  }

  const syncedAt = new Date().toISOString();
  // Deleted events can come back with only id + status, no start/end.
  const markCancelled = db.prepare(`
    UPDATE events SET status = 'cancelled', updated_at = ? WHERE event_id = ? AND calendar_id = ? AND status != 'cancelled'`);
  const futureRows = db.prepare(`
    SELECT event_id FROM events
    WHERE calendar_id = ? AND start_utc > ? AND start_utc < ? AND status NOT IN ('cancelled', ?)`);
  const markRemoved = db.prepare(`
    UPDATE events SET status = ?, updated_at = ? WHERE event_id = ? AND calendar_id = ?`);

  db.transaction(() => {
    const seen = new Set<string>();
    for (const ev of items) {
      if (!ev.id) continue;
      seen.add(ev.id);

      if (ev.status === 'cancelled' && !ev.start?.dateTime) {
        if (markCancelled.run(syncedAt, ev.id, client.calendarId).changes > 0) {
          result.cancelled++;
          log.info('event cancelled', { client: client.name, eventId: ev.id });
        }
        continue;
      }
      const data = eventDataFromGoogle(ev, client.calendarId, client.name);
      if (!data) {
        result.skippedAllDay++;
        continue;
      }

      upsertEvent(db, data, syncedAt);
      if (data.status === 'cancelled') result.cancelled++;
      else result.upserted++;
    }

    // A stored future event inside the window that Google didn't return any more was
    // moved out of the window (rescheduled far ahead), moved to another calendar, or
    // hard-deleted. Mark it so no reminders fire for the old time. If it reappears
    // later (e.g. the new time enters the window), the upsert above restores it.
    const stale = futureRows.all(client.calendarId, timeMin, timeMax, STATUS_REMOVED) as { event_id: string }[];
    for (const { event_id } of stale) {
      if (seen.has(event_id)) continue;
      markRemoved.run(STATUS_REMOVED, syncedAt, event_id, client.calendarId);
      result.removed++;
      log.info('event no longer in calendar window; marked removed', { client: client.name, eventId: event_id });
    }
  })();

  result.ok = true;
  return result;
}

/** One sync pass over every client calendar. Never throws for a single calendar's failure. */
export async function runSync(db: DB, calendar: Calendar): Promise<SyncResult> {
  const now = new Date();
  const startedAt = now.toISOString();
  const { config, fresh } = currentConfig();

  const calendars: CalendarResult[] = [];
  for (const client of config.clients) {
    try {
      calendars.push(await syncCalendar(db, calendar, client, now));
    } catch (err) {
      // e.g. a DB error — still continue with the other calendars.
      log.error('calendar sync failed', { client: client.name, err });
      calendars.push({ client: client.name, ok: false, upserted: 0, cancelled: 0, removed: 0, skippedAllDay: 0,
        error: { message: (err as Error).message } });
    }
  }

  const ok = fresh && calendars.every((c) => c.ok);
  if (ok) setKv(db, KV_LAST_SUCCESSFUL_SYNC, startedAt);

  log.info('sync finished', {
    ok,
    configFresh: fresh,
    durationMs: Date.now() - now.getTime(),
    calendars: calendars.map(({ error, ...c }) => (error ? { ...c, error: error.message } : c)),
  });
  return { ok, startedAt, calendars };
}
