import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Alerts } from '../src/alerts.js';
import type { Closer } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { computeDueReminders, computeMissedReminders, lookaheadMs, runReminders } from '../src/reminders.js';
import { createClient, createCloser, deleteClient, setOffsets } from '../src/store.js';
import type { EventRow } from '../src/sync.js';

beforeAll(() => {
  process.env.LOG_LEVEL = 'error';
});

const MIN = 60_000;
const START = '2026-11-16T03:00:00.000Z';
const startMs = Date.parse(START);
const before = (min: number) => new Date(startMs - min * MIN);
const iso = (min: number) => before(min).toISOString();
const closers: Closer[] = [{ name: 'Asha', email: 'asha@example.com', whatsapp: '919000000001' }];

const event = (o: Partial<EventRow> = {}): EventRow => ({
  event_id: 'e1', calendar_id: 'cal@gmail.com', client_name: 'Client A', title: 'Call',
  start_utc: START, end_utc: iso(-30), status: 'confirmed', meet_link: null,
  attendees_json: JSON.stringify(['asha@example.com']), first_seen_utc: iso(600), ...o,
});

describe('custom offsets', () => {
  it('fire at their own times and not at the defaults', () => {
    const offsets = [120, 15];
    expect(computeDueReminders(before(120), [event()], closers, new Set(), offsets).map((r) => r.offsetMin)).toEqual([120]);
    expect(computeDueReminders(before(15), [event()], closers, new Set(), offsets).map((r) => r.offsetMin)).toEqual([15]);
    expect(computeDueReminders(before(60), [event()], closers, new Set(), offsets)).toEqual([]);
    expect(computeDueReminders(before(10), [event()], closers, new Set(), offsets)).toEqual([]);
  });

  it('lookahead follows max(offsets) + 1 minute', () => {
    expect(lookaheadMs([60, 30, 10, 5])).toBe(61 * MIN);
    expect(lookaheadMs([120, 15])).toBe(121 * MIN);
    // 121 minutes out: outside the default lookahead, inside the custom one at exactly the 120 mark.
    expect(computeDueReminders(before(120), [event()], closers, new Set(), [120])).toHaveLength(1);
    expect(computeDueReminders(before(120), [event()], closers, new Set())).toEqual([]);
    expect(computeDueReminders(before(122), [event()], closers, new Set(), [120])).toEqual([]);
  });
});

describe('per-offset added-at', () => {
  const now = before(40); // 90 and 60 are long past due
  const offsets = [90, 60, 30, 10, 5];
  const ids = (added: Record<number, string | null>) =>
    computeMissedReminders(now, [event({ first_seen_utc: iso(600) })], closers, new Set(), offsets, added).map((m) => m.offsetMin);

  it('a newly added offset does not create a false missed alert for an already-known event', () => {
    expect(ids({})).toEqual([90, 60]); // without added-at both would be reported
    expect(ids({ 90: iso(41) })).toEqual([60]); // only the new offset is suppressed
  });

  it('re-saving the same list (added-at unchanged / null) does not hide a real missed alert', () => {
    expect(ids({ 90: null, 60: null, 30: null, 10: null, 5: null })).toEqual([90, 60]);
  });

  it('removing an offset does not suppress the others', () => {
    const rest = computeMissedReminders(now, [event()], closers, new Set(), [60, 30], { 60: null, 30: null }).map((m) => m.offsetMin);
    expect(rest).toEqual([60]);
  });

  it('still reports an added offset whose due time is after it was added', () => {
    expect(computeMissedReminders(before(25), [event()], closers, new Set(), [60, 30], { 60: iso(100), 30: iso(100) }).map((m) => m.offsetMin)).toEqual([60, 30]);
  });
});

describe('runReminders reads offsets from the database', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    createCloser(db, { name: 'Asha', email: 'asha@example.com', whatsapp: '919000000001' });
    createClient(db, { name: 'Client A', calendarId: 'cal@gmail.com', whatsappGroupId: '1203@g.us' });
    const e = event();
    db.prepare(`INSERT INTO events (event_id, calendar_id, client_name, title, start_utc, end_utc, status, meet_link, attendees_json, updated_at, first_seen_utc)
      VALUES (@event_id, @calendar_id, @client_name, @title, @start_utc, @end_utc, @status, @meet_link, @attendees_json, @first_seen_utc, @first_seen_utc)`).run(e);
  });

  const deps = (sent: string[]) => ({
    whatsapp: { async sendGroupMessage(_g: string, t: string) { sent.push(t.split('\n')[0]!); }, async getSessionStatus() { return 'WORKING'; }, async listGroups() { return []; } },
    fetchEvent: async () => ({ id: 'e1', status: 'confirmed', start: { dateTime: START }, end: { dateTime: iso(-30) } }),
    alerts: { async send() {} } as Alerts,
  });

  it('sends only the configured offsets', async () => {
    setOffsets(db, [15]);
    const sent: string[] = [];
    // Setting was just saved (updatedAt = real now, far from 2026), so use a call time in the future of it.
    for (let m = 20; m >= 1; m--) await runReminders(db, deps(sent), before(m));
    expect(sent).toEqual(['⏰ Call in 15 min, 8:30 AM']);
  });
});

describe('inactive clients', () => {
  it('a disabled client\'s due reminder is neither sent nor marked missed', async () => {
    const db = openDb(':memory:');
    createCloser(db, { name: 'Asha', email: 'asha@example.com', whatsapp: '919000000001' });
    const client = createClient(db, { name: 'Client A', calendarId: 'cal@gmail.com', whatsappGroupId: '1203@g.us' });
    const e = event({ first_seen_utc: iso(600) });
    db.prepare(`INSERT INTO events (event_id, calendar_id, client_name, title, start_utc, end_utc, status, meet_link, attendees_json, updated_at, first_seen_utc)
      VALUES (@event_id, @calendar_id, @client_name, @title, @start_utc, @end_utc, @status, @meet_link, @attendees_json, @first_seen_utc, @first_seen_utc)`).run(e);
    deleteClient(db, client.id); // soft delete = disabled
    const sent: string[] = [];
    const alerts: string[] = [];
    const deps = {
      whatsapp: { async sendGroupMessage(_g: string, t: string) { sent.push(t); }, async getSessionStatus() { return 'WORKING'; }, async listGroups() { return []; } },
      fetchEvent: async () => ({ id: 'e1', status: 'confirmed', start: { dateTime: START }, end: { dateTime: iso(-30) } }),
      alerts: { async send(s: string) { alerts.push(s); } } as Alerts,
    };
    for (const m of [60, 40, 10, 5]) await runReminders(db, deps, before(m));
    expect(sent).toEqual([]);
    expect(alerts).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sent_reminders`).get()).toEqual({ n: 0 });
  });
});
