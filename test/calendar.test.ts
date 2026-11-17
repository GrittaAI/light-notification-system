import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module shared with the PWA
import { calendarMonth, dayKey, fmtDayKey, shiftMonth, tasksOnDay } from '../public/nudge/sync-core.js';

const NOW = Date.parse('2026-11-17T06:30:00.000Z'); // Tue 17 Nov 2026, 12:00 IST
const t = (id: string, dueAt: string | null, o: Record<string, unknown> = {}) => ({ id, dueAt, status: 'todo', deleted: false, createdAt: 't', ...o });

describe('calendar helpers (IST)', () => {
  it('dayKey uses IST, so 20:00 UTC is already the next day', () => {
    expect(dayKey(Date.parse('2026-11-17T18:29:00Z'))).toBe('2026-11-17'); // 23:59 IST
    expect(dayKey(Date.parse('2026-11-17T18:31:00Z'))).toBe('2026-11-18'); // 00:01 IST
    expect(fmtDayKey('2026-11-17')).toBe('Tue, 17 Nov');
  });

  it('builds a Sunday-first month grid with counts for dots', () => {
    const tasks = [
      t('a', '2026-11-17T10:00:00Z'), // today, later: open
      t('b', '2026-11-17T03:00:00Z'), // today, earlier: overdue
      t('c', '2026-11-20T04:00:00Z', { status: 'done' }),
      t('d', '2026-11-21T04:00:00Z', { deleted: true }),
      t('e', null),
    ];
    const m = calendarMonth(2026, 11, tasks, NOW);
    expect(m.label).toBe('November 2026');
    expect(m.weeks[0]!.map((c: { day: number }) => c.day)).toEqual([1, 2, 3, 4, 5, 6, 7]); // 1 Nov 2026 is a Sunday
    const cells = m.weeks.flat();
    const at = (k: string) => cells.find((c: { key: string }) => c.key === k);
    expect(at('2026-11-17')).toMatchObject({ today: true, open: 1, overdue: 1, done: 0, inMonth: true });
    expect(at('2026-11-20')).toMatchObject({ open: 0, overdue: 0, done: 1 });
    expect(at('2026-11-21')).toMatchObject({ open: 0, overdue: 0, done: 0 });
    expect(at('2026-11-16')!.past).toBe(true);
    expect(cells.length % 7).toBe(0);
    const dec = calendarMonth(2026, 12, [], NOW).weeks.flat();
    expect(dec[0]).toMatchObject({ key: '2026-11-29', inMonth: false });
  });

  it('lists a day\'s tasks open first by time, then done; and shifts months across years', () => {
    const tasks = [t('done', '2026-11-17T02:00:00Z', { status: 'done' }), t('late', '2026-11-17T12:00:00Z'), t('early', '2026-11-17T04:00:00Z'), t('other', '2026-11-18T04:00:00Z')];
    expect(tasksOnDay(tasks, '2026-11-17').map((x: { id: string }) => x.id)).toEqual(['early', 'late', 'done']);
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
  });
});
