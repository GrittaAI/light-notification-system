import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeAll, describe, expect, it } from 'vitest';
import { type DB, openDb, setKv } from '../src/db.js';
import { SYNC_STALE_MS, checkHealth, startHealthServer } from '../src/health.js';
import { KV_LAST_SUCCESSFUL_SYNC } from '../src/sync.js';

const NOW = new Date('2026-11-16T03:00:00.000Z');

beforeAll(() => {
  process.env.LOG_LEVEL = 'error';
});

function setup(syncAgeMs: number | null) {
  const db: DB = openDb(':memory:');
  if (syncAgeMs !== null) setKv(db, KV_LAST_SUCCESSFUL_SYNC, new Date(NOW.getTime() - syncAgeMs).toISOString());
  return db;
}

const waha = (status: string | Error) => ({
  async getSessionStatus() {
    if (status instanceof Error) throw status;
    return status;
  },
});

describe('checkHealth', () => {
  it('200 when sync is fresh and WAHA is WORKING', async () => {
    const r = await checkHealth(setup(60_000), waha('WORKING'), NOW);
    expect(r.httpStatus).toBe(200);
    expect(r.body).toMatchObject({ ok: true, syncOk: true, syncAgeSeconds: 60, waha: { status: 'WORKING', ok: true } });
  });

  it('503 when the last sync is older than 10 minutes', async () => {
    const r = await checkHealth(setup(SYNC_STALE_MS + 1000), waha('WORKING'), NOW);
    expect(r.httpStatus).toBe(503);
    expect(r.body.syncOk).toBe(false);
    expect(r.body.ok).toBe(false);
  });

  it('503 with nulls when never synced', async () => {
    const r = await checkHealth(setup(null), waha('WORKING'), NOW);
    expect(r.httpStatus).toBe(503);
    expect(r.body).toMatchObject({ ok: false, lastSuccessfulSync: null, syncAgeSeconds: null, syncOk: false });
  });

  it('503 when WAHA needs a QR scan', async () => {
    const r = await checkHealth(setup(1000), waha('SCAN_QR_CODE'), NOW);
    expect(r.httpStatus).toBe(503);
    expect(r.body.waha).toEqual({ status: 'SCAN_QR_CODE', ok: false });
    expect(r.body.syncOk).toBe(true);
  });

  it('503 UNREACHABLE when the status call throws', async () => {
    const r = await checkHealth(setup(1000), waha(new Error('boom')), NOW);
    expect(r.httpStatus).toBe(503);
    expect(r.body.waha).toEqual({ status: 'UNREACHABLE', ok: false });
  });
});

describe('startHealthServer', () => {
  it('serves /health with the right status code and 404s everything else', async () => {
    const server = startHealthServer(setup(null), waha('WORKING'), 0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ ok: false, syncOk: false, waha: { status: 'WORKING', ok: true } });
      expect((await fetch(`${base}/other`)).status).toBe(404);
      expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(404);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});

describe('startHealthServer port conflict', () => {
  it('handles EADDRINUSE without crashing and does not listen', async () => {
    const blocker = http.createServer();
    await new Promise<void>((r) => blocker.listen(0, '0.0.0.0', r));
    const port = (blocker.address() as AddressInfo).port;
    const server = startHealthServer(setup(null), waha('WORKING'), port);
    try {
      const err = await new Promise<NodeJS.ErrnoException>((r) => server.once('error', r));
      expect(err.code).toBe('EADDRINUSE');
      expect(server.listening).toBe(false);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });
});
