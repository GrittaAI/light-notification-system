import { describe, expect, it, vi } from 'vitest';
import { createGroupsCache, TEST_MESSAGE } from '../src/admin/routes.js';
import { createWhatsApp, normalizeGroups } from '../src/whatsapp.js';

const env = { WAHA_URL: 'http://waha:3000', WAHA_SESSION: 'default', WAHA_API_KEY: 'k' };

describe('listGroups', () => {
  it('normalises string ids and _serialized ids, drops non-groups, sorts by name', () => {
    expect(normalizeGroups([
      { id: '2@g.us', name: 'Zed' },
      { id: { _serialized: '1@g.us' }, subject: 'Alpha' },
      { id: '3@c.us', name: 'Person' },
      { id: '4@g.us' },
      null,
    ])).toEqual([{ id: '4@g.us', name: '4@g.us' }, { id: '1@g.us', name: 'Alpha' }, { id: '2@g.us', name: 'Zed' }]);
  });

  it('calls the WAHA groups endpoint with the API key', async () => {
    const calls: { url: string; key: string | undefined }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), key: (init.headers as Record<string, string>)['X-Api-Key'] });
      return new Response(JSON.stringify([{ id: '1@g.us', name: 'A' }]), { status: 200 });
    }) as unknown as typeof fetch;
    const groups = await createWhatsApp(env, fakeFetch).listGroups();
    expect(groups).toEqual([{ id: '1@g.us', name: 'A' }]);
    expect(calls).toEqual([{ url: 'http://waha:3000/api/default/groups?exclude=participants', key: 'k' }]);
  });

  it('throws on a non-2xx response', async () => {
    const f = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    await expect(createWhatsApp(env, f).listGroups()).rejects.toThrow('HTTP 500');
  });
});

describe('groups cache', () => {
  it('caches for 5 minutes and refresh bypasses it', async () => {
    let n = 0;
    let t = 0;
    const get = createGroupsCache(async () => [{ id: `${++n}@g.us`, name: 'g' }], () => new Date(t));
    expect((await get(false))[0]!.id).toBe('1@g.us');
    t = 4 * 60_000;
    expect((await get(false))[0]!.id).toBe('1@g.us');
    expect((await get(true))[0]!.id).toBe('2@g.us');
    t = 4 * 60_000 + 5 * 60_000 + 1;
    expect((await get(false))[0]!.id).toBe('3@g.us');
  });
});

it('test message text is the agreed one', () => {
  expect(TEST_MESSAGE).toBe('✅ Test message from Pushup reminders — this group is set up correctly.');
});

describe('session management calls', () => {
  const env = { WAHA_URL: 'http://waha.local', WAHA_SESSION: 'default', WAHA_API_KEY: 'k-secret' };
  it('getSession maps me.id to a phone and pushName', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ status: 'WORKING', me: { id: '919000000001:12@c.us', pushName: 'Co' } })));
    const wa = createWhatsApp(env, f as unknown as typeof fetch);
    expect(await wa.getSession()).toEqual({ status: 'WORKING', me: { phone: '919000000001', name: 'Co' } });
    expect((f.mock.calls[0] as unknown[])[0]).toBe('http://waha.local/api/sessions/default');
    const none = createWhatsApp(env, (async () => new Response(JSON.stringify({ status: 'STOPPED', me: null }))) as unknown as typeof fetch);
    expect((await none.getSession()).me).toBeNull();
  });
  it('posts start/restart/logout/request-code to the documented paths with the key, and errors never include it', async () => {
    const urls: string[] = [];
    const f = vi.fn(async (u: string, init?: RequestInit) => {
      urls.push(`${init?.method} ${new URL(u).pathname} ${(init?.headers as Record<string, string>)['X-Api-Key']}`);
      return new Response(JSON.stringify({ code: 'ABCD-EFGH' }));
    });
    const wa = createWhatsApp(env, f as unknown as typeof fetch);
    await wa.startSession(); await wa.restartSession(); await wa.logoutSession();
    expect(await wa.requestPairingCode('919000000001')).toBe('ABCD-EFGH');
    expect(urls).toEqual([
      'POST /api/sessions/default/start k-secret', 'POST /api/sessions/default/restart k-secret',
      'POST /api/sessions/default/logout k-secret', 'POST /api/default/auth/request-code k-secret',
    ]);
    const bad = createWhatsApp(env, (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch);
    await expect(bad.logoutSession()).rejects.toThrow(/HTTP 500/);
    await expect(bad.logoutSession()).rejects.not.toThrow(/k-secret/);
  });
  it('getQrPng returns bytes', async () => {
    const wa = createWhatsApp(env, (async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch);
    expect([...(await wa.getQrPng())]).toEqual([1, 2, 3]);
  });
});
