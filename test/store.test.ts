import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type DB, openDb } from '../src/db.js';
import {
  createClient, createCloser, listClients, deleteClient, deleteCloser, getOffsets, listAudit, listClosers, loadRuntimeConfig,
  seedFromConfigFile, setOffsets, StoreError, updateCloser,
} from '../src/store.js';

beforeAll(() => {
  process.env.LOG_LEVEL = 'error';
});

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

const dir = mkdtempSync(join(tmpdir(), 'store-test-'));
const writeCfg = (name: string, content: unknown) => {
  const path = join(dir, name);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
};
const validCfg = {
  closers: [{ name: 'Asha', email: 'Asha@Example.com', whatsapp: '+91 90000-00001' }],
  clients: [{ name: 'Client A', calendarId: 'a@gmail.com', whatsappGroupId: '120363000000000001@g.us' }],
};

function fails(fn: () => unknown): StoreError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(StoreError);
    return err as StoreError;
  }
  throw new Error('expected a StoreError');
}

describe('seedFromConfigFile', () => {
  it('imports a valid file once, normalising values, and audits it', () => {
    const path = writeCfg('ok.json', validCfg);
    expect(seedFromConfigFile(db, path)).toMatchObject({ imported: true, closers: 1, clients: 1 });
    expect(listClosers(db)[0]).toMatchObject({ email: 'asha@example.com', whatsapp: '919000000001', active: true });
    expect(listAudit(db)[0]).toMatchObject({ actor: 'system', action: 'import_config_json', details: { closers: 1, clients: 1 } });
    // Second call: tables are not empty, nothing happens.
    expect(seedFromConfigFile(db, path)).toMatchObject({ imported: false });
    expect(listClosers(db)).toHaveLength(1);
  });

  it('skips when the tables are non-empty', () => {
    createCloser(db, { name: 'X', email: 'x@example.com', whatsapp: '919000000009' });
    expect(seedFromConfigFile(db, writeCfg('ok2.json', validCfg)).imported).toBe(false);
    expect(loadRuntimeConfig(db).clients).toEqual([]);
  });

  it('imports on a fresh database', () => {
    expect(seedFromConfigFile(db, writeCfg('ok3.json', validCfg)).imported).toBe(true);
  });

  it('tolerates a missing file and an invalid file', () => {
    expect(seedFromConfigFile(db, join(dir, 'nope.json')).imported).toBe(false);
    expect(seedFromConfigFile(db, writeCfg('bad.json', '{ not json')).imported).toBe(false);
    expect(seedFromConfigFile(db, writeCfg('bad2.json', { closers: [], clients: [] })).imported).toBe(false);
    expect(listClosers(db)).toEqual([]);
  });
});

describe('seed flag', () => {
  it('never re-imports after the rows are hard-deleted', () => {
    const path = writeCfg('flag.json', validCfg);
    expect(seedFromConfigFile(db, path).imported).toBe(true);
    for (const c of listClosers(db)) deleteCloser(db, c.id, true);
    for (const c of listClients(db)) deleteClient(db, c.id, true);
    expect(seedFromConfigFile(db, path).imported).toBe(false);
    expect(listClosers(db)).toEqual([]);
  });

  it('marks an existing non-empty database so later emptying does not import', () => {
    const c = createCloser(db, { name: 'X', email: 'x@example.com', whatsapp: '919000000009' });
    const path = writeCfg('flag2.json', validCfg);
    expect(seedFromConfigFile(db, path).imported).toBe(false);
    deleteCloser(db, c.id, true);
    expect(seedFromConfigFile(db, path).imported).toBe(false);
  });
});

describe('closers and clients', () => {
  it('validates input with field errors and normalises', () => {
    const e = fails(() => createCloser(db, { name: '', email: 'nope', whatsapp: '123' }));
    expect(e.kind).toBe('validation');
    expect(Object.keys(e.fields!).sort()).toEqual(['email', 'name', 'whatsapp']);
    const row = createCloser(db, { name: ' Asha ', email: ' ASHA@Example.com ', whatsapp: '+91 98765-43210' });
    expect(row).toMatchObject({ name: 'Asha', email: 'asha@example.com', whatsapp: '919876543210' });

    expect(fails(() => createClient(db, { name: 'C', calendarId: 'c@gmail.com', whatsappGroupId: 'abc@c.us' })).fields)
      .toHaveProperty('whatsappGroupId');
  });

  it('returns a conflict for duplicate closer email and client calendarId', () => {
    createCloser(db, { name: 'A', email: 'a@example.com', whatsapp: '919000000001' });
    expect(fails(() => createCloser(db, { name: 'B', email: 'A@example.com', whatsapp: '919000000002' })).kind).toBe('conflict');
    const g = '120363000000000001@g.us';
    createClient(db, { name: 'C', calendarId: 'c@gmail.com', whatsappGroupId: g });
    expect(fails(() => createClient(db, { name: 'D', calendarId: 'c@gmail.com', whatsappGroupId: g })).kind).toBe('conflict');
    const other = createCloser(db, { name: 'B', email: 'b@example.com', whatsapp: '919000000002' });
    expect(fails(() => updateCloser(db, other.id, { name: 'B', email: 'a@example.com', whatsapp: '919000000002' })).kind).toBe('conflict');
  });

  it('soft-deletes by default, hard-deletes on request; loadRuntimeConfig returns active rows only', () => {
    const a = createCloser(db, { name: 'A', email: 'a@example.com', whatsapp: '919000000001' });
    const b = createCloser(db, { name: 'B', email: 'b@example.com', whatsapp: '919000000002' });
    const c1 = createClient(db, { name: 'C1', calendarId: 'c1@gmail.com', whatsappGroupId: '1@g.us' });
    createClient(db, { name: 'C2', calendarId: 'c2@gmail.com', whatsappGroupId: '2@g.us' });
    deleteCloser(db, a.id);
    deleteClient(db, c1.id);
    expect(listClosers(db).find((c) => c.id === a.id)).toMatchObject({ active: false });
    expect(loadRuntimeConfig(db)).toMatchObject({
      closers: [{ name: 'B', email: 'b@example.com', whatsapp: '919000000002' }],
      clients: [{ name: 'C2', calendarId: 'c2@gmail.com', whatsappGroupId: '2@g.us' }],
      offsets: [60, 30, 10, 5],
      offsetAddedAt: { 60: null, 30: null, 10: null, 5: null },
    });
    deleteCloser(db, b.id, true);
    expect(listClosers(db)).toHaveLength(1);
    expect(fails(() => deleteCloser(db, 9999)).kind).toBe('not_found');
    // Re-enable through update keeps the id.
    expect(updateCloser(db, a.id, { name: 'A', email: 'a@example.com', whatsapp: '919000000001', active: true }).active).toBe(true);
  });
});

describe('offsets setting', () => {
  it('validates: integers 1..1440, unique, 1..10 entries', () => {
    for (const bad of [[], [0], [1441], [1.5], [10, 10], Array.from({ length: 11 }, (_, i) => i + 1), 'x', null, ['5']]) {
      expect(fails(() => setOffsets(db, bad)).kind).toBe('validation');
    }
  });

  it('maps per-element errors to the reminderOffsets field', () => {
    expect(fails(() => setOffsets(db, [10, 0])).fields).toHaveProperty('reminderOffsets');
    expect(fails(() => setOffsets(db, 'x')).fields).toHaveProperty('reminderOffsets');
  });

  it('keeps addedAt for remaining offsets, stamps new ones, drops removed ones, migrates plain arrays', () => {
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('reminder_offsets', '[30,10]', '2026-01-01T00:00:00.000Z')`).run();
    expect(getOffsets(db).addedAt).toEqual({ 30: null, 10: null });
    const saved = setOffsets(db, [30, 20]);
    const a = getOffsets(db).addedAt;
    expect(a[30]).toBeNull();
    expect(a[20]).toBe(saved.updatedAt);
    expect(a[10]).toBeUndefined();
  });

  it('stores sorted descending and exposes updatedAt', () => {
    const saved = setOffsets(db, [5, 120, 30]);
    expect(saved.offsets).toEqual([120, 30, 5]);
    const rt = loadRuntimeConfig(db);
    expect(rt.offsets).toEqual([120, 30, 5]);
    expect(Object.keys(rt.offsetAddedAt).sort()).toEqual(['120', '30', '5']);
    expect(rt.offsetAddedAt[120]).toBe(saved.updatedAt);
    expect(getOffsets(db).offsets).toEqual([120, 30, 5]);
  });
});
