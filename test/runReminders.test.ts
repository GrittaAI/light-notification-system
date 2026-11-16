import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { calendar_v3 } from 'googleapis';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Alerts } from '../src/alerts.js';
import { type DB, openDb } from '../src/db.js';
import type { FetchEvent } from '../src/google.js';
import { computeMissedReminders, type ReminderDeps, runReminders } from '../src/reminders.js';
import { seedFromConfigFile } from '../src/store.js';
import type { EventRow } from '../src/sync.js';
import type { WhatsApp } from '../src/whatsapp.js';

const MIN = 60_000;
const START = '2026-11-16T03:00:00.000Z'; // 8:30 AM IST
const startMs = Date.parse(START);
const before = (min: number) => new Date(startMs - min * MIN);
const iso = (min: number) => before(min).toISOString();

const CAL = 'client.a@gmail.com';
const GROUP = '120363000000000001@g.us';

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'reminders-test-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({
    closers: [
      { name: 'Asha', email: 'asha@example.com', whatsapp: '919000000001' },
      { name: 'Ravi', email: 'ravi@example.com', whatsapp: '919000000002' },
    ],
    clients: [{ name: 'Client A', calendarId: CAL, whatsappGroupId: GROUP }],
  }));
  process.env.CONFIG_PATH = path;
  process.env.LOG_LEVEL = 'error';
});

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  seedFromConfigFile(db, process.env.CONFIG_PATH!);
});

function insertEventRow(overrides: Partial<EventRow> = {}): EventRow {
  const row: EventRow & { updated_at: string } = {
    event_id: 'evt1',
    calendar_id: CAL,
    client_name: 'Client A',
    title: 'Discovery call',
    start_utc: START,
    end_utc: new Date(startMs + 30 * MIN).toISOString(),
    status: 'confirmed',
    meet_link: 'https://meet.google.com/abc',
    attendees_json: JSON.stringify(['asha@example.com', 'ravi@example.com']),
    first_seen_utc: iso(120),
    updated_at: iso(120),
    ...overrides,
  };
  db.prepare(`INSERT INTO events (event_id, calendar_id, client_name, title, start_utc, end_utc, status, meet_link, attendees_json, updated_at, first_seen_utc)
    VALUES (@event_id, @calendar_id, @client_name, @title, @start_utc, @end_utc, @status, @meet_link, @attendees_json, @updated_at, @first_seen_utc)`).run(row);
  return row;
}

/** Google's view of the event, matching the stored row unless overridden. */
function googleEvent(overrides: Partial<calendar_v3.Schema$Event> = {}): calendar_v3.Schema$Event {
  return {
    id: 'evt1',
    status: 'confirmed',
    summary: 'Discovery call',
    start: { dateTime: START },
    end: { dateTime: new Date(startMs + 30 * MIN).toISOString() },
    hangoutLink: 'https://meet.google.com/abc',
    attendees: [{ email: 'asha@example.com' }, { email: 'ravi@example.com' }],
    ...overrides,
  };
}

function fakes(opts: { live?: () => calendar_v3.Schema$Event } = {}) {
  const sent: { groupId: string; text: string; mentions: string[] }[] = [];
  const alerts: { subject: string; text: string }[] = [];
  const fetches: string[] = [];
  const whatsapp: WhatsApp = {
    async sendGroupMessage(groupId, text, mentions) { sent.push({ groupId, text, mentions }); },
    async getSessionStatus() { return 'WORKING'; },
  };
  const fetchEvent: FetchEvent = async (calendarId, eventId) => {
    fetches.push(`${calendarId}/${eventId}`);
    return (opts.live ?? (() => googleEvent()))();
  };
  const alertSink: Alerts = { async send(subject, text) { alerts.push({ subject, text }); } };
  const deps: ReminderDeps = { whatsapp, fetchEvent, alerts: alertSink };
  return { deps, sent, alerts, fetches };
}

const rows = () =>
  db.prepare(`SELECT offset_min, status FROM sent_reminders ORDER BY offset_min DESC`).all() as { offset_min: number; status: string }[];
const storedEvent = () => db.prepare(`SELECT * FROM events WHERE event_id = 'evt1'`).get() as EventRow;

describe('live re-check before sending', () => {
  // Booked 15 min before start, so earlier offsets are not "missed" and only the 10-min one is in play.
  const insertEvent = (o: Partial<EventRow> = {}) => insertEventRow({ first_seen_utc: iso(15), updated_at: iso(15), ...o });

  it('sends when the live event matches the stored one', async () => {
    insertEvent();
    const f = fakes();
    const res = await runReminders(db, f.deps, before(10));
    expect(res).toMatchObject({ due: 1, sent: 1, skippedChanged: 0 });
    expect(f.fetches).toEqual([`${CAL}/evt1`]);
    expect(f.sent[0]).toMatchObject({ groupId: GROUP, mentions: ['919000000001', '919000000002'] });
    expect(rows()).toEqual([{ offset_min: 10, status: 'sent' }]);
  });

  it('skips sending and stores the cancellation when the event was cancelled after sync', async () => {
    insertEvent();
    const f = fakes({ live: () => googleEvent({ status: 'cancelled' }) });
    const res = await runReminders(db, f.deps, before(10));
    expect(res).toMatchObject({ due: 1, sent: 0, skippedChanged: 1 });
    expect(f.sent).toEqual([]);
    expect(rows()).toEqual([]);
    expect(storedEvent().status).toBe('cancelled');
    // Next minute: event is no longer active, nothing is attempted.
    expect(await runReminders(db, f.deps, before(9))).toMatchObject({ due: 0, sent: 0 });
  });

  it('skips sending and stores the new time when the event was rescheduled after sync', async () => {
    insertEvent();
    const NEW_START = new Date(startMs + 60 * MIN).toISOString();
    const f = fakes({
      live: () => googleEvent({ start: { dateTime: NEW_START }, end: { dateTime: new Date(startMs + 90 * MIN).toISOString() } }),
    });
    const res = await runReminders(db, f.deps, before(10));
    expect(res).toMatchObject({ due: 1, sent: 0, skippedChanged: 1 });
    expect(f.sent).toEqual([]);
    expect(storedEvent().start_utc).toBe(NEW_START);
    expect(storedEvent().first_seen_utc).toBe(iso(10)); // new start time first seen by this run
  });

  it('falls back to stored data and still sends when events.get fails', async () => {
    insertEvent();
    const f = fakes({ live: () => { throw Object.assign(new Error('backend error'), { response: { status: 503 } }); } });
    const res = await runReminders(db, f.deps, before(10));
    expect(res).toMatchObject({ due: 1, sent: 1, skippedChanged: 0 });
    expect(f.sent).toHaveLength(1);
    expect(rows()).toEqual([{ offset_min: 10, status: 'sent' }]);
  });
});

describe('missed reminders', () => {
  const insertEvent = insertEventRow;

  it('records a missed reminder once and alerts once', async () => {
    insertEvent(); // known since 120 min before start
    const f = fakes();

    // Service was down; first run is 25 min before start: 60 and 30 are past the grace window.
    const first = await runReminders(db, f.deps, before(25));
    expect(first).toMatchObject({ missed: 2, sent: 0 });
    expect(rows()).toEqual([{ offset_min: 60, status: 'missed' }, { offset_min: 30, status: 'missed' }]);
    expect(f.alerts).toHaveLength(1);
    expect(f.alerts[0]!.subject).toContain('2 call reminder(s) missed');
    expect(f.alerts[0]!.text).toContain('Client A');
    expect(f.alerts[0]!.text).toContain('"Discovery call"');
    expect(f.alerts[0]!.text).toContain('60-min reminder');
    expect(f.alerts[0]!.text).toContain('30-min reminder');

    // Later runs: no new missed rows, no more alerts, and missed offsets are never sent.
    for (let m = 24; m >= 1; m--) await runReminders(db, f.deps, before(m));
    expect(f.alerts).toHaveLength(1);
    expect(f.sent.map((s) => s.text.split('\n')[0])).toEqual([
      '⏰ Call in 10 min, 8:30 AM',
      '⏰ Call in 5 min, 8:30 AM',
    ]);
    expect(rows()).toEqual([
      { offset_min: 60, status: 'missed' },
      { offset_min: 30, status: 'missed' },
      { offset_min: 10, status: 'sent' },
      { offset_min: 5, status: 'sent' },
    ]);
  });

  it('does not mark offsets missed for a call booked after they were due', async () => {
    insertEvent({ first_seen_utc: iso(20), updated_at: iso(20) }); // booked 20 min before start
    const f = fakes();
    for (let m = 19; m >= 1; m--) await runReminders(db, f.deps, before(m));
    expect(f.alerts).toEqual([]);
    expect(rows()).toEqual([{ offset_min: 10, status: 'sent' }, { offset_min: 5, status: 'sent' }]);
  });

  it('is pure and excludes keys already recorded', () => {
    const ev = { ...insertEvent(), first_seen_utc: iso(120) };
    const closers = [{ name: 'Asha', email: 'asha@example.com', whatsapp: '919000000001' }];
    const missed = computeMissedReminders(before(25), [ev], closers, new Set());
    expect(missed.map((m) => m.offsetMin)).toEqual([60, 30]);
    const again = computeMissedReminders(before(25), [ev], closers, new Set(missed.map((m) => m.key)));
    expect(again).toEqual([]);
    // Inside the grace window it is not missed (it is due instead).
    expect(computeMissedReminders(before(28), [ev], closers, new Set()).map((m) => m.offsetMin)).toEqual([60]);
  });
});
