import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module shared with the PWA
import { hasDevanagari, parseVoiceTask } from '../public/nudge/voice-parse.js';

const NOW = Date.parse('2026-11-18T08:30:00.000Z'); // Wed 18 Nov 2026, 2:00 PM IST
const ist = (m: number, d: number, h: number, mi = 0, y = 2026) => new Date(Date.UTC(y, m - 1, d, h, mi) - 330 * 60_000).toISOString();
const p = (text: string) => parseVoiceTask(text, NOW);

describe('voice parser: the examples from the brief', () => {
  it('"Get a demo for margin sales at 9:30 pm tomorrow"', () => {
    expect(p('Get a demo for margin sales at 9:30 pm tomorrow')).toEqual({ title: 'Get a demo for margin sales', dueIso: ist(11, 19, 21, 30), priority: null, understood: true, past: false });
  });
  it('"... on 13th" is the next 13th (December, since 13 Nov has passed), 9 AM', () => {
    expect(p('Get a demo for margin sales on 13th')).toMatchObject({ title: 'Get a demo for margin sales', dueIso: ist(12, 13, 9) });
    expect(p('Get a demo for margin sales on 13th at 9:30 pm')).toMatchObject({ title: 'Get a demo for margin sales', dueIso: ist(12, 13, 21, 30) });
  });
});

describe('voice parser: English', () => {
  const cases: [string, string, string | null][] = [
    ['Call Ravi tomorrow at 10 am', 'Call Ravi', ist(11, 19, 10)],
    ['Remind me to call Ravi at 5 pm', 'Call Ravi', ist(11, 18, 17)],
    ['remind me to pay rent at 11am', 'Pay rent', ist(11, 19, 11)], // 11 am today has passed -> tomorrow
    ['Create a task to send the invoice tonight', 'Send the invoice', ist(11, 18, 21)],
    ['Send proposal today', 'Send proposal', ist(11, 18, 18)],
    ['Book flights day after tomorrow at 7 pm', 'Book flights', ist(11, 20, 19)],
    ['Team review on Friday at 4 pm', 'Team review', ist(11, 20, 16)],
    ['Team review next Monday', 'Team review', ist(11, 23, 9)],
    ['Board meeting on 25 December at 3pm', 'Board meeting', ist(12, 25, 15)],
    ['Board meeting December 25th', 'Board meeting', ist(12, 25, 9)],
    ['Renewal call on 2 Jan', 'Renewal call', ist(1, 2, 9, 0, 2027)],
    ['Pay GST on 20/11', 'Pay GST', ist(11, 20, 9)],
    ['Follow up with Acme in 2 hours', 'Follow up with Acme', new Date(NOW + 2 * 3_600_000).toISOString()],
    ['Check email in 30 minutes', 'Check email', new Date(NOW + 30 * 60_000).toISOString()],
    ['Stretch in half an hour', 'Stretch', new Date(NOW + 30 * 60_000).toISOString()],
    ['Ship the release in 3 days', 'Ship the release', ist(11, 21, 9)],
    ['Lunch with Priya at noon tomorrow', 'Lunch with Priya', ist(11, 19, 12)],
    ['Call the bank tomorrow morning', 'Call the bank', ist(11, 19, 9)],
    ['Prepare slides tomorrow evening', 'Prepare slides', ist(11, 19, 18)],
    ['Gym at 6:30', 'Gym', ist(11, 18, 18, 30)], // 6:30 am passed -> 6:30 pm today
    ['Standup tomorrow at 9', 'Standup', ist(11, 19, 9)], // another day: 7-11 -> am
    ['Client call tomorrow at 3', 'Client call', ist(11, 19, 15)], // another day: 1-6 -> pm
    ['Water the plants at 21:00', 'Water the plants', ist(11, 18, 21)],
    ['Buy milk', 'Buy milk', null],
  ];
  for (const [text, title, due] of cases) {
    it(text, () => {
      const r = p(text);
      expect(r.title).toBe(title);
      expect(r.dueIso).toBe(due);
      expect(r.understood).toBe(due !== null);
    });
  }
});

describe('voice parser: Hinglish', () => {
  const cases: [string, string, string][] = [
    ['kal shaam 9:30 baje margin sales ka demo', 'Margin sales ka demo', ist(11, 19, 21, 30)],
    ['Margin sales demo kal subah 10 baje', 'Margin sales demo', ist(11, 19, 10)],
    ['aaj raat 9 baje mummy ko call', 'Mummy ko call', ist(11, 18, 21)],
    ['parso dopahar 2 baje bank jana hai', 'Bank jana', ist(11, 20, 14)],
    ['saade 4 baje meeting', 'Meeting', ist(11, 18, 16, 30)],
    ['kal sava 10 baje standup', 'Standup', ist(11, 19, 10, 15)],
    ['Report bhejna 2 ghante baad', 'Report bhejna', new Date(NOW + 2 * 3_600_000).toISOString()],
    ['Invoice 13 tarikh ko bhejna', 'Invoice bhejna', ist(12, 13, 9)],
    ['shukravar ko review', 'Review', ist(11, 20, 9)],
    ['mujhe yaad dilana ki kal dawai leni hai', 'Dawai leni', ist(11, 19, 9)],
  ];
  for (const [text, title, due] of cases) {
    it(text, () => {
      const r = p(text);
      expect(r.title).toBe(title);
      expect(r.dueIso).toBe(due);
    });
  }
});

describe('voice parser: priority, past times and edge cases', () => {
  it('reads priority words and removes them from the title', () => {
    expect(p('Urgent: call Ravi tomorrow at 10 am')).toMatchObject({ title: 'Call Ravi', priority: 'urgent' });
    expect(p('Send the deck tomorrow, it is important')).toMatchObject({ priority: 'high' });
    expect(p('Clean the desk tomorrow, low priority')).toMatchObject({ title: 'Clean the desk', priority: 'low' });
    expect(p('kal bahut zaruri client call 11 baje')).toMatchObject({ title: 'Client call', priority: 'urgent', dueIso: ist(11, 19, 11) });
  });
  it('flags an explicit time that has already passed instead of moving it', () => {
    expect(p('Call Ravi today at 10 am')).toMatchObject({ dueIso: ist(11, 18, 10), past: true });
    expect(p('Call Ravi at 10 am')).toMatchObject({ dueIso: ist(11, 19, 10), past: false }); // no day: next 10 am
  });
  it('a weekday name means the coming one, never today', () => {
    expect(p('Review on Wednesday')).toMatchObject({ dueIso: ist(11, 25, 9) });
  });
  it('"on 31st" skips months without a 31st', () => {
    expect(parseVoiceTask('Close books on 31st', Date.parse('2027-02-02T06:00:00Z')).dueIso).toBe(ist(3, 31, 9, 0, 2027));
  });
  it('numbers that are part of the title are kept', () => {
    expect(p('Call 3 clients tomorrow at 11 am')).toMatchObject({ title: 'Call 3 clients', dueIso: ist(11, 19, 11) });
  });
  it('detects Devanagari text', () => {
    expect(hasDevanagari('कल शाम demo')).toBe(true);
    expect(hasDevanagari('kal shaam demo')).toBe(false);
  });
});
