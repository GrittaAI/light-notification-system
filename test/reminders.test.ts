import { describe, expect, it } from 'vitest';
import type { Closer } from '../src/config.js';
import { buildMessage, computeDueReminders, type DueReminder, formatIstTime } from '../src/reminders.js';
import type { EventRow } from '../src/sync.js';

const MIN = 60_000;
// 03:00 UTC = 8:30 AM IST
const START = '2026-11-16T03:00:00.000Z';
const startMs = Date.parse(START);
const at = (minutesBeforeStart: number, extraSeconds = 0) =>
  new Date(startMs - minutesBeforeStart * MIN + extraSeconds * 1000);

const asha: Closer = { name: 'Asha', email: 'asha@example.com', whatsapp: '919000000001' };
const ravi: Closer = { name: 'Ravi', email: 'ravi@example.com', whatsapp: '919000000002' };
const neha: Closer = { name: 'Neha', email: 'neha@example.com', whatsapp: '919000000003' };
const closers = [asha, ravi, neha];

function event(overrides: Partial<EventRow> = {}): EventRow {
  return {
    event_id: 'evt1',
    calendar_id: 'client.a@gmail.com',
    client_name: 'Client A',
    title: 'Discovery call',
    start_utc: START,
    end_utc: '2026-11-16T03:30:00.000Z',
    status: 'confirmed',
    meet_link: 'https://meet.google.com/abc-defg-hij',
    attendees_json: JSON.stringify(['asha@example.com', 'lead@prospect.com']),
    first_seen_utc: '2026-11-15T00:00:00.000Z',
    ...overrides,
  };
}

const offsets = (due: DueReminder[]) => due.map((d) => d.offsetMin);

/**
 * Simulates the scheduler: one tick per minute from `fromMin` to `toMin` before start,
 * recording sends like the real runner does. `eventsAt` lets a test change the events mid-run.
 */
function simulate(fromMin: number, toMin: number, eventsAt: (minBefore: number) => EventRow[], sent = new Set<string>()) {
  const fired: DueReminder[] = [];
  for (let m = fromMin; m >= toMin; m--) {
    for (const r of computeDueReminders(at(m), eventsAt(m), closers, sent)) {
      sent.add(r.key);
      fired.push(r);
    }
  }
  return { fired, sent };
}

describe('computeDueReminders', () => {
  it('fires each offset exactly when it becomes due', () => {
    expect(offsets(computeDueReminders(at(60), [event()], closers, new Set()))).toEqual([60]);
    expect(offsets(computeDueReminders(at(30), [event()], closers, new Set()))).toEqual([30]);
    expect(offsets(computeDueReminders(at(10), [event()], closers, new Set()))).toEqual([10]);
    expect(offsets(computeDueReminders(at(5), [event()], closers, new Set()))).toEqual([5]);
    expect(computeDueReminders(at(45), [event()], closers, new Set())).toEqual([]);
  });

  it('fires every offset once over a full run of minute ticks', () => {
    const { fired } = simulate(75, 1, () => [event()]);
    expect(offsets(fired)).toEqual([60, 30, 10, 5]);
  });

  it('respects the 3-minute grace window', () => {
    // 1 second before due: not yet.
    expect(computeDueReminders(at(60, -1), [event()], closers, new Set())).toEqual([]);
    // 2 min 59 s late: still sent.
    expect(offsets(computeDueReminders(at(30, 179), [event()], closers, new Set()))).toEqual([30]);
    // Exactly 3 min late: skipped.
    expect(computeDueReminders(at(30, 180), [event()], closers, new Set())).toEqual([]);
    expect(computeDueReminders(at(27), [event()], closers, new Set())).toEqual([]);
  });

  it('does not resend a reminder whose key is already recorded', () => {
    const first = computeDueReminders(at(10), [event()], closers, new Set());
    expect(first).toHaveLength(1);
    const sent = new Set(first.map((r) => r.key));
    // Next two ticks are still inside the grace window.
    expect(computeDueReminders(at(9), [event()], closers, sent)).toEqual([]);
    expect(computeDueReminders(at(8), [event()], closers, sent)).toEqual([]);
  });

  it('retries a failed send on the next tick while inside the grace window', () => {
    // Nothing recorded after the first attempt (send failed).
    expect(offsets(computeDueReminders(at(5), [event()], closers, new Set()))).toEqual([5]);
    expect(offsets(computeDueReminders(at(4), [event()], closers, new Set()))).toEqual([5]);
    expect(offsets(computeDueReminders(at(3), [event()], closers, new Set()))).toEqual([5]);
    expect(computeDueReminders(at(2), [event()], closers, new Set())).toEqual([]);
  });

  it('tags all matching closers in one reminder, matching emails case-insensitively', () => {
    const ev = event({ attendees_json: JSON.stringify(['ASHA@Example.com', 'ravi@example.com', 'lead@prospect.com']) });
    const due = computeDueReminders(at(10), [ev], closers, new Set());
    expect(due).toHaveLength(1);
    expect(due[0]!.closers.map((c) => c.name)).toEqual(['Asha', 'Ravi']);
  });

  it('skips events with no matching closer', () => {
    const ev = event({ attendees_json: JSON.stringify(['lead@prospect.com']) });
    expect(computeDueReminders(at(10), [ev], closers, new Set())).toEqual([]);
  });

  it('gives a rescheduled event fresh reminders for its new start time', () => {
    const NEW_START = new Date(startMs + 60 * MIN).toISOString(); // moved 1 hour later
    // 60-min reminder for the original time already went out; reschedule happens 45 min before the old start.
    const { fired } = simulate(75, -59, (m) => [m > 45 ? event() : event({ start_utc: NEW_START })]);
    expect(fired.map((r) => [r.event.start_utc, r.offsetMin])).toEqual([
      [START, 60],
      [NEW_START, 60],
      [NEW_START, 30],
      [NEW_START, 10],
      [NEW_START, 5],
    ]);
  });

  it('skips offsets already past by more than the grace window when rescheduled earlier', () => {
    // At 50 min before the old start, the call is moved to start in 20 minutes.
    const NEW_START = new Date(at(50).getTime() + 20 * MIN).toISOString();
    const { fired } = simulate(50, 30, (m) => [m > 50 ? event() : event({ start_utc: NEW_START })]);
    expect(fired.map((r) => [r.event.start_utc, r.offsetMin])).toEqual([
      [NEW_START, 10],
      [NEW_START, 5],
    ]);
  });

  it('sends nothing for cancelled or removed events', () => {
    for (const status of ['cancelled', 'removed']) {
      const { fired } = simulate(75, 1, () => [event({ status })]);
      expect(fired, status).toEqual([]);
    }
  });

  it('stops sending once an event is cancelled', () => {
    const { fired } = simulate(75, 1, (m) => [event({ status: m > 20 ? 'confirmed' : 'cancelled' })]);
    expect(offsets(fired)).toEqual([60, 30]);
  });

  it('for an event created 20 minutes before start, fires only 10 and 5', () => {
    const { fired } = simulate(20, 1, () => [event()]);
    expect(offsets(fired)).toEqual([10, 5]);
  });

  it('keeps reminders separate per calendar for the same event id', () => {
    const a = event();
    const b = event({ calendar_id: 'client.b@gmail.com', client_name: 'Client B' });
    const due = computeDueReminders(at(10), [a, b], closers, new Set());
    expect(due.map((d) => d.event.calendar_id)).toEqual(['client.a@gmail.com', 'client.b@gmail.com']);
    expect(new Set(due.map((d) => d.key)).size).toBe(2);
  });

  it('ignores events that already started or are beyond the look-ahead', () => {
    expect(computeDueReminders(at(0), [event()], closers, new Set())).toEqual([]);
    expect(computeDueReminders(at(62), [event()], closers, new Set())).toEqual([]);
  });
});

describe('buildMessage', () => {
  it('formats the message with IST time, title, mentions and meet link', () => {
    const ev = event({ attendees_json: JSON.stringify(['asha@example.com', 'ravi@example.com']) });
    const [r] = computeDueReminders(at(30), [ev], closers, new Set());
    expect(buildMessage(r!)).toBe(
      '⏰ Call in 30 min, 8:30 AM\nDiscovery call\n@919000000001 @919000000002\nMeet: https://meet.google.com/abc-defg-hij',
    );
  });

  it('says "no link" when there is no meet link', () => {
    const [r] = computeDueReminders(at(5), [event({ meet_link: null })], closers, new Set());
    expect(buildMessage(r!).split('\n').at(-1)).toBe('Meet: no link');
  });

  it('formats IST times in 12-hour clock', () => {
    expect(formatIstTime('2026-11-16T09:15:00.000Z')).toBe('2:45 PM');
    expect(formatIstTime('2026-11-15T18:30:00.000Z')).toBe('12:00 AM');
  });
});
