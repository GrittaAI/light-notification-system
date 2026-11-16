import type { Alerts } from './alerts.js';
import type { Closer } from './config.js';
import type { DB } from './db.js';
import { describeGoogleError, type FetchEvent } from './google.js';
import { logger } from './logger.js';
import { loadRuntimeConfig } from './store.js';
import { type EventRow, eventDataFromGoogle, STATUS_REMOVED, upsertEvent } from './sync.js';
import type { WhatsApp } from './whatsapp.js';

const log = logger.child({ module: 'reminders' });

/** Default offsets (minutes before start); the real ones come from the settings table. */
export const OFFSETS_MIN: readonly number[] = [60, 30, 10, 5];
export const GRACE_MS = 3 * 60_000;
/** Look-ahead for candidate events: the largest offset plus a minute. */
export function lookaheadMs(offsets: readonly number[]): number {
  return (Math.max(...offsets) + 1) * 60_000;
}
export const LOOKAHEAD_MS = lookaheadMs(OFFSETS_MIN);
/** Only these statuses get reminders ("cancelled" and "removed" never do). */
export const ACTIVE_STATUSES = ['confirmed', 'tentative'] as const;

export interface DueReminder {
  event: EventRow;
  offsetMin: number;
  closers: Closer[];
  key: string;
}

/** Identity of one sent reminder; mirrors sent_reminders' unique key. */
export function reminderKey(eventId: string, calendarId: string, startUtc: string, offsetMin: number): string {
  return `${eventId}|${calendarId}|${startUtc}|${offsetMin}`;
}

/** Closers whose email is in the event's attendee list (both lowercased upstream). */
export function matchClosers(event: EventRow, closers: Closer[]): Closer[] {
  const attendees = new Set((JSON.parse(event.attendees_json) as string[]).map((e) => e.toLowerCase()));
  return closers.filter((c) => attendees.has(c.email.toLowerCase()));
}

/**
 * Pure: which reminders should be sent at `now`. No I/O, no clock reads.
 * A reminder for offset X is due when now >= start - X and now - (start - X) < GRACE_MS,
 * and its key is not in `sentKeys`.
 */
export function computeDueReminders(
  now: Date,
  events: EventRow[],
  closers: Closer[],
  sentKeys: ReadonlySet<string>,
  offsets: readonly number[] = OFFSETS_MIN,
): DueReminder[] {
  const nowMs = now.getTime();
  const lookahead = lookaheadMs(offsets);
  const due: DueReminder[] = [];

  for (const event of events) {
    if (!(ACTIVE_STATUSES as readonly string[]).includes(event.status)) continue;
    const startMs = Date.parse(event.start_utc);
    if (!(startMs > nowMs && startMs - nowMs <= lookahead)) continue;

    const matched = matchClosers(event, closers);
    if (matched.length === 0) continue;

    for (const offsetMin of offsets) {
      const dueMs = startMs - offsetMin * 60_000;
      if (nowMs < dueMs || nowMs - dueMs >= GRACE_MS) continue;
      const key = reminderKey(event.event_id, event.calendar_id, event.start_utc, offsetMin);
      if (sentKeys.has(key)) continue;
      due.push({ event, offsetMin, closers: matched, key });
    }
  }
  return due;
}

/**
 * Pure: reminders that were missed and should be recorded once as 'missed'.
 * Missed means: more than GRACE_MS past due, the call hasn't started, nothing recorded
 * for it yet, and we already knew about the event before it was due (first_seen_utc < due).
 * Calls booked after an offset was due are not "missed" for that offset, and neither are
 * an offset that was added after the event was first seen is judged from its own added-at time
 * (effective first seen = max(first_seen_utc, offsetAddedAt[offset]); null/absent means it always existed).
 */
export function computeMissedReminders(
  now: Date,
  events: EventRow[],
  closers: Closer[],
  sentKeys: ReadonlySet<string>,
  offsets: readonly number[] = OFFSETS_MIN,
  offsetAddedAt: Readonly<Record<number, string | null>> = {},
): DueReminder[] {
  const nowMs = now.getTime();
  const lookahead = lookaheadMs(offsets);
  const missed: DueReminder[] = [];

  for (const event of events) {
    if (!(ACTIVE_STATUSES as readonly string[]).includes(event.status)) continue;
    const startMs = Date.parse(event.start_utc);
    if (!(startMs > nowMs && startMs - nowMs <= lookahead)) continue;

    const matched = matchClosers(event, closers);
    if (matched.length === 0) continue;
    const eventFirstSeenMs = Date.parse(event.first_seen_utc);

    for (const offsetMin of offsets) {
      const dueMs = startMs - offsetMin * 60_000;
      if (!(nowMs - dueMs > GRACE_MS)) continue;
      // An offset added later must not raise "missed" alerts for calls already known.
      const addedAt = offsetAddedAt[offsetMin];
      const firstSeenMs = addedAt ? Math.max(eventFirstSeenMs, Date.parse(addedAt)) : eventFirstSeenMs;
      if (!(firstSeenMs < dueMs)) continue;
      const key = reminderKey(event.event_id, event.calendar_id, event.start_utc, offsetMin);
      if (sentKeys.has(key)) continue;
      missed.push({ event, offsetMin, closers: matched, key });
    }
  }
  return missed;
}

const istTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true,
});

/** "8:30 AM" in IST (some ICU versions put a narrow no-break space before AM/PM). */
export function formatIstTime(iso: string): string {
  return istTime.format(new Date(iso)).replace(/[  ]/g, ' ');
}

export function buildMessage(r: DueReminder): string {
  return [
    `⏰ Call in ${r.offsetMin} min, ${formatIstTime(r.event.start_utc)}`,
    r.event.title || '(no title)',
    r.closers.map((c) => `@${c.whatsapp}`).join(' '),
    `Meet: ${r.event.meet_link ?? 'no link'}`,
  ].join('\n');
}

// ---------------- side-effecting runner ----------------

export interface ReminderDeps {
  whatsapp: WhatsApp;
  fetchEvent: FetchEvent;
  alerts: Alerts;
}

export interface ReminderRunResult {
  due: number;
  sent: number;
  failed: number;
  /** Not sent because the live check showed the event cancelled or moved. */
  skippedChanged: number;
  /** Newly recorded as missed in this run. */
  missed: number;
}

type LiveCheck = 'send' | 'skip';

/**
 * Re-reads the event from Google just before sending. If it is cancelled or its start
 * moved, updates our row from the live data and returns 'skip'. If the lookup fails,
 * returns 'send' so a Google hiccup never blocks reminders.
 */
async function liveCheck(db: DB, fetchEvent: FetchEvent, event: EventRow, nowIso: string): Promise<LiveCheck> {
  const ctx = { client: event.client_name, eventId: event.event_id, title: event.title, startUtc: event.start_utc };
  let live;
  try {
    live = await fetchEvent(event.calendar_id, event.event_id);
  } catch (err) {
    log.warn('live event check failed; sending from stored data', { ...ctx, ...describeGoogleError(err) });
    return 'send';
  }

  const now = nowIso;
  if (live.status === 'cancelled') {
    db.prepare(`UPDATE events SET status = 'cancelled', updated_at = ? WHERE event_id = ? AND calendar_id = ?`)
      .run(now, event.event_id, event.calendar_id);
    log.info('event cancelled since last sync; reminder not sent', ctx);
    return 'skip';
  }

  const data = eventDataFromGoogle(live, event.calendar_id, event.client_name);
  if (!data) {
    // Turned into an all-day event: no start time to remind for.
    db.prepare(`UPDATE events SET status = ?, updated_at = ? WHERE event_id = ? AND calendar_id = ?`)
      .run(STATUS_REMOVED, now, event.event_id, event.calendar_id);
    log.info('event no longer has a start time; reminder not sent', ctx);
    return 'skip';
  }
  if (data.start_utc !== event.start_utc) {
    upsertEvent(db, data, now); // new start => first_seen_utc = now
    log.info('event rescheduled since last sync; reminder not sent', { ...ctx, newStartUtc: data.start_utc });
    return 'skip';
  }
  return 'send';
}

function missedAlertText(missed: DueReminder[]): string {
  return [
    'These call reminders were not sent in time and will not be retried:',
    '',
    ...missed.map((m) =>
      `- ${m.event.client_name}: "${m.event.title || '(no title)'}" at ${formatIstTime(m.event.start_utc)} IST, ` +
      `${m.offsetMin}-min reminder (closers: ${m.closers.map((c) => c.name).join(', ')})`),
    '',
    'Check that the service, WAHA and the WhatsApp session are running.',
  ].join('\n');
}

/** One reminder pass: record missed reminders, then send due ones and record successes. */
export async function runReminders(db: DB, deps: ReminderDeps, now = new Date()): Promise<ReminderRunResult> {
  const config = loadRuntimeConfig(db);

  const nowIso = now.toISOString();
  const untilIso = new Date(now.getTime() + lookaheadMs(config.offsets)).toISOString();

  let events = db
    .prepare(`SELECT * FROM events WHERE status IN ('confirmed', 'tentative') AND start_utc > ? AND start_utc <= ?`)
    .all(nowIso, untilIso) as EventRow[];
  // Only active clients' calendars: a disabled/deleted/re-pointed client gets no sends and no missed alerts.
  const activeCalendars = new Set(config.clients.map((c) => c.calendarId));
  events = events.filter((e) => activeCalendars.has(e.calendar_id));

  // Both 'sent' and 'missed' rows count: neither is ever retried.
  const sentRows = db
    .prepare(`SELECT event_id, calendar_id, start_utc, offset_min FROM sent_reminders WHERE start_utc > ? AND start_utc <= ?`)
    .all(nowIso, untilIso) as { event_id: string; calendar_id: string; start_utc: string; offset_min: number }[];
  const sentKeys = new Set(sentRows.map((r) => reminderKey(r.event_id, r.calendar_id, r.start_utc, r.offset_min)));

  const result: ReminderRunResult = { due: 0, sent: 0, failed: 0, skippedChanged: 0, missed: 0 };
  const insertRow = db.prepare(`
    INSERT INTO sent_reminders (event_id, calendar_id, start_utc, offset_min, sent_at, status)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (event_id, calendar_id, start_utc, offset_min) DO NOTHING`);
  const ctxOf = (r: DueReminder) => ({
    client: r.event.client_name,
    eventId: r.event.event_id,
    title: r.event.title,
    startUtc: r.event.start_utc,
    offsetMin: r.offsetMin,
    closers: r.closers.map((c) => c.name),
  });

  // 1. Missed reminders: record once, log, alert once.
  const newlyMissed: DueReminder[] = [];
  for (const m of computeMissedReminders(now, events, config.closers, sentKeys, config.offsets, config.offsetAddedAt)) {
    const info = insertRow.run(m.event.event_id, m.event.calendar_id, m.event.start_utc, m.offsetMin, nowIso, 'missed');
    sentKeys.add(m.key);
    if (info.changes === 0) continue;
    newlyMissed.push(m);
    log.warn('reminder missed', ctxOf(m));
  }
  result.missed = newlyMissed.length;
  if (newlyMissed.length > 0) {
    try {
      await deps.alerts.send(`${newlyMissed.length} call reminder(s) missed`, missedAlertText(newlyMissed));
    } catch (err) {
      log.error('missed-reminder alert email failed', { err, missed: newlyMissed.map(ctxOf) });
    }
  }

  // 2. Due reminders.
  const due = computeDueReminders(now, events, config.closers, sentKeys, config.offsets);
  result.due = due.length;
  if (due.length === 0 && newlyMissed.length === 0) return result;

  const groupByCalendar = new Map(config.clients.map((c) => [c.calendarId, c.whatsappGroupId]));
  const liveChecks = new Map<string, Promise<LiveCheck>>(); // one events.get per event per run

  for (const r of due) {
    const ctx = ctxOf(r);
    const groupId = groupByCalendar.get(r.event.calendar_id);
    if (!groupId) {
      log.warn('no active client for event calendar; not sending', { ...ctx, calendarId: r.event.calendar_id });
      result.failed++;
      continue;
    }

    const eventKey = `${r.event.event_id}|${r.event.calendar_id}`;
    if (!liveChecks.has(eventKey)) liveChecks.set(eventKey, liveCheck(db, deps.fetchEvent, r.event, nowIso));
    if ((await liveChecks.get(eventKey)!) === 'skip') {
      result.skippedChanged++;
      continue;
    }

    try {
      await deps.whatsapp.sendGroupMessage(groupId, buildMessage(r), r.closers.map((c) => c.whatsapp));
    } catch (err) {
      // Not recorded, so the next minute retries while still inside the grace window.
      result.failed++;
      log.error('reminder send failed; will retry within grace window', { ...ctx, err });
      continue;
    }

    const info = insertRow.run(r.event.event_id, r.event.calendar_id, r.event.start_utc, r.offsetMin, new Date().toISOString(), 'sent');
    if (info.changes === 0) log.warn('reminder was already recorded as sent', ctx);
    result.sent++;
    log.info('reminder sent', ctx);
  }

  log.info('reminder run finished', { ...result });
  return result;
}
