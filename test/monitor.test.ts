import { beforeAll, describe, expect, it } from 'vitest';
import { getKv, openDb, setKv } from '../src/db.js';
import { type AlertState, decide, runMonitor } from '../src/monitor.js';
import { KV_LAST_SUCCESSFUL_SYNC, type SyncResult } from '../src/sync.js';

beforeAll(() => {
  process.env.LOG_LEVEL = 'error';
});

const MIN = 60_000;
const T0 = new Date('2026-11-16T03:00:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * MIN);
const CLEAR: AlertState = { failing: false, failingSince: null, alertedAt: null };

describe('decide', () => {
  it('debounces, alerts, suppresses for 60 min, repeats, recovers once', () => {
    let s = CLEAR;
    let r = decide(s, true, at(0), 3 * MIN);
    expect(r.action).toBe('none');
    expect(r.next.failingSince).toBe(at(0).toISOString());
    s = r.next;
    r = decide(s, true, at(2), 3 * MIN);
    expect(r.action).toBe('none');
    expect(r.next.failingSince).toBe(at(0).toISOString());
    r = decide(r.next, true, at(3), 3 * MIN);
    expect(r.action).toBe('alert');
    expect(r.next.alertedAt).toBe(at(3).toISOString());
    s = r.next;
    expect(decide(s, true, at(62), 3 * MIN).action).toBe('none');
    r = decide(s, true, at(63), 3 * MIN);
    expect(r.action).toBe('alert');
    expect(r.next.alertedAt).toBe(at(63).toISOString());
    r = decide(r.next, false, at(64), 3 * MIN);
    expect(r.action).toBe('recover');
    expect(r.next).toEqual(CLEAR);
    expect(decide(r.next, false, at(65), 3 * MIN).action).toBe('none');
  });

  it('clears silently when it never alerted', () => {
    const s = decide(CLEAR, true, at(0), 3 * MIN).next;
    const r = decide(s, false, at(1), 3 * MIN);
    expect(r.action).toBe('none');
    expect(r.next).toEqual(CLEAR);
  });

  it('alerts immediately with zero debounce', () => {
    expect(decide(CLEAR, true, at(0), 0).action).toBe('alert');
  });
});

function setup(opts: { waha?: () => string; sync?: SyncResult; startedAt?: Date } = {}) {
  const db = openDb(':memory:');
  const sent: { subject: string; text: string }[] = [];
  const ctl = { failEmail: false, waha: opts.waha ?? (() => 'WORKING'), sync: opts.sync };
  const alerts = {
    async send(subject: string, text: string) {
      if (ctl.failEmail) throw new Error('smtp down');
      sent.push({ subject, text });
    },
  };
  const whatsapp = { async getSessionStatus() { return ctl.waha(); } };
  const deps = () => ({
    db, whatsapp, alerts, getLastSyncResult: () => ctl.sync, startedAt: opts.startedAt ?? T0,
  });
  return { db, sent, ctl, deps };
}

const freshSync = (db: ReturnType<typeof openDb>, now: Date) =>
  setKv(db, KV_LAST_SUCCESSFUL_SYNC, now.toISOString());

describe('runMonitor', () => {
  it('WAHA SCAN_QR_CODE alerts after 3 minutes, once per hour, then recovers once', async () => {
    const t = setup({ waha: () => 'SCAN_QR_CODE' });
    for (const m of [0, 1, 2]) {
      freshSync(t.db, at(m));
      await runMonitor(t.deps(), at(m));
    }
    expect(t.sent).toHaveLength(0);
    freshSync(t.db, at(3));
    await runMonitor(t.deps(), at(3));
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.subject).toBe('ALERT: WhatsApp session not working (SCAN_QR_CODE)');
    expect(t.sent[0]!.text).toContain('scan the QR code');
    for (const m of [4, 30, 62]) {
      freshSync(t.db, at(m));
      await runMonitor(t.deps(), at(m));
    }
    expect(t.sent).toHaveLength(1);
    t.ctl.waha = () => 'WORKING';
    freshSync(t.db, at(63));
    await runMonitor(t.deps(), at(63));
    await runMonitor(t.deps(), at(64));
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]!.subject).toBe('RECOVERED: WhatsApp session working again');
  });

  it('email failure leaves state unchanged so the next run sends', async () => {
    const t = setup({ waha: () => 'FAILED' });
    freshSync(t.db, at(0));
    await runMonitor(t.deps(), at(0));
    t.ctl.failEmail = true;
    freshSync(t.db, at(3));
    await runMonitor(t.deps(), at(3));
    const stored = JSON.parse(getKv(t.db, 'alert:waha_session')!) as AlertState;
    expect(stored.alertedAt).toBeNull();
    expect(t.sent).toHaveLength(0);
    t.ctl.failEmail = false;
    freshSync(t.db, at(4));
    await runMonitor(t.deps(), at(4));
    expect(t.sent).toHaveLength(1);
  });

  it('invalid_grant alerts on the first run with instructions', async () => {
    const sync: SyncResult = {
      ok: false, startedAt: T0.toISOString(),
      calendars: [{ client: 'Acme', ok: false, upserted: 0, cancelled: 0, removed: 0, skippedAllDay: 0,
        error: { message: 'invalid_grant', reason: 'invalid_grant' } }],
    };
    const t = setup({ sync });
    freshSync(t.db, at(0));
    await runMonitor(t.deps(), at(0));
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.text).toContain('new JSON key');
    expect(t.sent[0]!.text).toContain('GOOGLE_SERVICE_ACCOUNT_JSON');
    expect(t.sent[0]!.text).toContain('server clock');
    expect(t.sent[0]!.text).not.toContain('npm run auth');
  });

  it('sync_stale is quiet during the first 10 minutes, then alerts and lists failing calendars', async () => {
    const sync: SyncResult = {
      ok: false, startedAt: T0.toISOString(),
      calendars: [
        { client: 'Acme', ok: false, upserted: 0, cancelled: 0, removed: 0, skippedAllDay: 0, error: { message: 'boom' } },
        { client: 'Globex', ok: true, upserted: 1, cancelled: 0, removed: 0, skippedAllDay: 0 },
      ],
    };
    const t = setup({ sync });
    await runMonitor(t.deps(), at(9));
    expect(t.sent).toHaveLength(0);
    await runMonitor(t.deps(), at(10));
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.subject).toContain('sync is stale');
    expect(t.sent[0]!.text).toContain('Acme');
    expect(t.sent[0]!.text).toContain('boom');
    expect(t.sent[0]!.text).not.toContain('Globex');
  });

  it('sync_stale alerts when the last successful sync is older than 10 minutes', async () => {
    const t = setup();
    freshSync(t.db, at(-5)); // before startedAt, but process is old enough below
    await runMonitor(t.deps(), at(5));
    expect(t.sent).toHaveLength(0);
    await runMonitor(t.deps(), at(6)); // 11 min old
    expect(t.sent).toHaveLength(1);
  });

  it('state persists across a restart: no duplicate alert within 60 minutes', async () => {
    const t = setup({ waha: () => 'STOPPED' });
    freshSync(t.db, at(0));
    await runMonitor(t.deps(), at(0));
    freshSync(t.db, at(3));
    await runMonitor(t.deps(), at(3));
    expect(t.sent).toHaveLength(1);
    const restarted = { ...t.deps(), startedAt: at(10) };
    freshSync(t.db, at(11));
    await runMonitor(restarted, at(11));
    expect(t.sent).toHaveLength(1);
  });

  it('a throwing getSessionStatus does not stop the other checks', async () => {
    const t = setup({
      waha: () => { throw new Error('ECONNREFUSED'); },
      sync: { ok: false, startedAt: T0.toISOString(), calendars: [
        { client: 'Acme', ok: false, upserted: 0, cancelled: 0, removed: 0, skippedAllDay: 0,
          error: { message: 'x', reason: 'invalid_grant' } }] },
    });
    const summary = await runMonitor(t.deps(), at(11));
    expect(summary.checks.sync_stale!.failing).toBe(true);
    expect(summary.checks.google_auth!.failing).toBe(true);
    expect(summary.checks.waha_session!.failing).toBe(true);
    const subjects = t.sent.map((s) => s.subject);
    expect(subjects.some((s) => s.includes('sync is stale'))).toBe(true);
    expect(subjects.some((s) => s.includes('invalid_grant'))).toBe(true);
    expect(subjects.some((s) => s.includes('WhatsApp'))).toBe(false); // debounced
  });

  it('a stale failingSince from a previous process does not defeat the WAHA debounce', async () => {
    const t = setup({ waha: () => 'STOPPED', startedAt: at(0) });
    freshSync(t.db, at(0));
    await runMonitor(t.deps(), at(0));
    expect(t.sent).toHaveLength(0);
    t.ctl.waha = () => 'STARTING';
    const restarted = { ...t.deps(), startedAt: at(120) };
    for (const m of [120, 122]) {
      freshSync(t.db, at(m));
      await runMonitor(restarted, at(m));
    }
    expect(t.sent).toHaveLength(0);
    freshSync(t.db, at(123));
    await runMonitor(restarted, at(123));
    expect(t.sent).toHaveLength(1);
  });

  it('google_auth is skipped without a sync result: no email, state unchanged', async () => {
    const t = setup();
    const stored = JSON.stringify({ failing: true, failingSince: at(0).toISOString(), alertedAt: at(1).toISOString() });
    setKv(t.db, 'alert:google_auth', stored);
    freshSync(t.db, at(5));
    await runMonitor(t.deps(), at(5));
    expect(t.sent).toHaveLength(0);
    expect(getKv(t.db, 'alert:google_auth')).toBe(stored);
  });
});
