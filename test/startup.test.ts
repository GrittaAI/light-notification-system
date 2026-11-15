import { beforeAll, describe, expect, it } from 'vitest';
import { logStartupSummary, startupSummary } from '../src/startup.js';
import type { CalendarResult, SyncResult } from '../src/sync.js';

beforeAll(() => {
  process.env.LOG_LEVEL = 'error';
});

const cal = (client: string, ok = true, error?: Record<string, unknown>): CalendarResult => ({
  client, ok, upserted: 0, cancelled: 0, removed: 0, skippedAllDay: 0, error,
});
const syncOf = (calendars: CalendarResult[]): SyncResult => ({
  ok: calendars.every((c) => c.ok), startedAt: '2026-11-16T03:00:00.000Z', calendars,
});
const five = () => ['A', 'B', 'C', 'D', 'E'].map((n) => cal(n));

describe('startupSummary', () => {
  it('is ok when WAHA works and every calendar synced', () => {
    expect(startupSummary(syncOf(five()), 'WORKING')).toEqual({
      ok: true,
      waha: { status: 'WORKING', ok: true },
      calendars: { ok: 5, total: 5, failing: [] },
    });
  });

  it('is not ok when WAHA needs a QR scan', () => {
    const s = startupSummary(syncOf(five()), 'SCAN_QR_CODE');
    expect(s.ok).toBe(false);
    expect(s.waha).toEqual({ status: 'SCAN_QR_CODE', ok: false });
  });

  it('lists a failing calendar with its hint', () => {
    const cals = five();
    cals[2] = cal('C', false, { message: 'Not Found', hint: 'share the calendar with the ops account' });
    const s = startupSummary(syncOf(cals), 'WORKING');
    expect(s.ok).toBe(false);
    expect(s.calendars).toEqual({
      ok: 4, total: 5,
      failing: [{ client: 'C', error: 'Not Found (share the calendar with the ops account)' }],
    });
  });

  it('is not ok when there is no sync result', () => {
    const s = startupSummary(undefined, 'WORKING');
    expect(s.ok).toBe(false);
    expect(s.calendars).toEqual({ ok: 0, total: 0, failing: [] });
  });
});

describe('logStartupSummary', () => {
  it('does not throw when WAHA is unreachable', async () => {
    await expect(logStartupSummary(() => undefined, {
      getSessionStatus: async () => { throw new Error('boom'); },
    })).resolves.toBeUndefined();
  });
});
