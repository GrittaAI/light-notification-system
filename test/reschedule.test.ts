import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { calendar_v3 } from 'googleapis';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DB, openDb } from '../src/db.js';
import type { Calendar } from '../src/google.js';
import { type ReminderDeps, runReminders } from '../src/reminders.js';
import { type EventRow, runSync, upsertEvent } from '../src/sync.js';

// Drives the real sync (with a controllable clock) and the real reminder runner
// against an in-memory DB, with Google, WhatsApp and email faked.

const MIN = 60_000;
const BASE = Date.parse('2026-11-16T03:00:00.000Z');
const t = (min: number) => new Date(BASE + min * MIN);
const ts = (min: number) => t(min).toISOString();

const CAL = 'client.a@gmail.com';

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'reschedule-test-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({
    closers: [{ name: 'Asha', email: 'asha@example.com', whatsapp: '919000000001' }],
    clients: [{ name: 'Client A', calendarId: CAL, whatsappGroupId: '120363000000000001@g.us' }],
  }));
  process.env.CONFIG_PATH = path;
  process.env.LOG_LEVEL = 'error';
});

/** Google's current view of the one event; tests change `startMin` to reschedule. */
let google: { startMin: number; title: string };
let db: DB;
let sent: string[];
let alerts: string[];

const googleEvent = (): calendar_v3.Schema$Event => ({
  id: 'evt1',
  status: 'confirmed',
  summary: google.title,
  start: { dateTime: ts(google.startMin) },
  end: { dateTime: ts(google.startMin + 30) },
  attendees: [{ email: 'asha@example.com' }],
});

const calendar = {
  events: { list: async () => ({ data: { items: [googleEvent()] } }) },
} as unknown as Calendar;

const deps: ReminderDeps = {
  whatsapp: {
    async sendGroupMessage(_g, text) { sent.push(text.split('\n')[0]!); },
    async getSessionStatus() { return 'WORKING'; },
  },
  fetchEvent: async () => googleEvent(),
  alerts: { async send(subject) { alerts.push(subject); } },
};

/** Runs sync as if the wall clock were at `min`. */
async function syncAt(min: number) {
  vi.setSystemTime(t(min));
  await runSync(db, calendar);
}

/** Runs the reminder job once per minute for minutes from..to (inclusive). */
async function tick(from: number, to: number) {
  for (let m = from; m <= to; m++) {
    vi.setSystemTime(t(m));
    await runReminders(db, deps, t(m));
  }
}

const stored = () => db.prepare(`SELECT * FROM events WHERE event_id = 'evt1'`).get() as EventRow & { updated_at: string };
const reminderRows = () =>
  db.prepare(`SELECT start_utc, offset_min, status FROM sent_reminders ORDER BY sent_at, offset_min DESC`).all();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  db = openDb(':memory:');
  sent = [];
  alerts = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('rescheduling and first_seen_utc', () => {
  it('call booked days ago moved to start in 20 minutes: 60/30 skipped silently, 10/5 fire, no alert', async () => {
    google = { startMin: 3 * 24 * 60, title: 'Discovery call' }; // originally 3 days out
    await syncAt(-2 * 24 * 60); // first seen 2 days before the move
    expect(stored().first_seen_utc).toBe(ts(-2 * 24 * 60));

    google.startMin = 20; // moved: now starts 20 minutes from t(0)
    await syncAt(0);
    expect(stored().start_utc).toBe(ts(20));
    expect(stored().first_seen_utc).toBe(ts(0));

    await tick(0, 19);
    expect(sent).toEqual(['⏰ Call in 10 min, 8:50 AM', '⏰ Call in 5 min, 8:50 AM']);
    expect(alerts).toEqual([]);
    expect(reminderRows()).toEqual([
      { start_utc: ts(20), offset_min: 10, status: 'sent' },
      { start_utc: ts(20), offset_min: 5, status: 'sent' },
    ]);
  });

  it('call moved later while its 60/30 reminders are still ahead: all fire for the new time; old rows do not block', async () => {
    google = { startMin: 60, title: 'Demo' };
    await syncAt(-24 * 60);
    await tick(-1, 1); // 60-min reminder for the original time (due t(0)) goes out
    expect(sent).toEqual(['⏰ Call in 60 min, 9:30 AM']);

    google.startMin = 90; // moved 30 min later; its 60-min reminder is due t(30), still ahead
    await syncAt(15);
    expect(stored().first_seen_utc).toBe(ts(15));

    await tick(16, 89);
    expect(sent).toEqual([
      '⏰ Call in 60 min, 9:30 AM',
      '⏰ Call in 60 min, 10:00 AM',
      '⏰ Call in 30 min, 10:00 AM',
      '⏰ Call in 10 min, 10:00 AM',
      '⏰ Call in 5 min, 10:00 AM',
    ]);
    expect(alerts).toEqual([]);
    // The reminder sent for the old start time stays recorded under the old start_utc.
    expect(reminderRows()).toEqual([
      { start_utc: ts(60), offset_min: 60, status: 'sent' },
      { start_utc: ts(90), offset_min: 60, status: 'sent' },
      { start_utc: ts(90), offset_min: 30, status: 'sent' },
      { start_utc: ts(90), offset_min: 10, status: 'sent' },
      { start_utc: ts(90), offset_min: 5, status: 'sent' },
    ]);
  });

  it('call moved twice (once seen by sync, once by the live re-check)', async () => {
    google = { startMin: 300, title: 'Follow-up' };
    await syncAt(-3 * 24 * 60);

    // Move 1, picked up by sync at t(0): starts t(50). Its 60-min reminder was due t(-10),
    // before we knew the new time, so it is skipped silently.
    google.startMin = 50;
    await syncAt(0);
    expect(stored().first_seen_utc).toBe(ts(0));
    await tick(0, 9);

    // Move 2 at t(10), not synced: starts t(25). At t(20) the 30-min reminder for t(50) is
    // due; the live re-check sees the new time, stores it (first_seen = t(20)) and skips.
    google.startMin = 25;
    await tick(10, 24);
    expect(stored().start_utc).toBe(ts(25));
    expect(stored().first_seen_utc).toBe(ts(20));

    // For t(25): the 10-min reminder was due t(15), before first_seen -> skipped silently.
    // The 5-min reminder was due t(20) and fires at t(21), inside the grace window.
    expect(sent).toEqual(['⏰ Call in 5 min, 8:55 AM']);
    expect(alerts).toEqual([]);
    expect(reminderRows()).toEqual([{ start_utc: ts(25), offset_min: 5, status: 'sent' }]);
  });

  it('unchanged start time keeps its original first_seen_utc', async () => {
    google = { startMin: 120, title: 'Intro' };
    await syncAt(0);
    google.title = 'Intro (renamed)';
    await syncAt(30);
    expect(stored()).toMatchObject({ title: 'Intro (renamed)', first_seen_utc: ts(0), updated_at: ts(30) });

    // The shared upsert used by the live re-check behaves the same way.
    const { first_seen_utc: _f, updated_at: _u, ...data } = stored();
    upsertEvent(db, { ...data, title: 'Intro v3' }, ts(45));
    expect(stored()).toMatchObject({ title: 'Intro v3', first_seen_utc: ts(0), updated_at: ts(45) });
    upsertEvent(db, { ...data, start_utc: ts(150) }, ts(50));
    expect(stored()).toMatchObject({ start_utc: ts(150), first_seen_utc: ts(50) });
  });
});
