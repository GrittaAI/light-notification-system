import { beforeAll, describe, expect, it } from 'vitest';
import { createVoiceLlm, extractJson, systemPrompt, toResult } from '../src/tasks/voice.js';
import { setupNudge } from './helpers/nudge.js';

beforeAll(() => { process.env.LOG_LEVEL = 'error'; });

const NOW = new Date('2026-11-18T08:30:00.000Z'); // Wed 18 Nov 2026, 2:00 PM IST

describe('voice model reply', () => {
  it('keeps title, plain-English when and priority; null-ish when becomes null', () => {
    expect(toResult({ title: 'bank jana hai', when: 'day after tomorrow at 3:30 pm', priority: null }))
      .toEqual({ title: 'Bank jana hai', when: 'day after tomorrow at 3:30 pm', priority: null });
    expect(toResult({ title: 'X', when: 'null' }).when).toBeNull();
    expect(toResult({ title: 'X' })).toEqual({ title: 'X', when: null, priority: null });
    expect(() => toResult({ title: '' })).toThrow();
    expect(() => toResult({ title: 'X', priority: 'max' })).toThrow();
  });
  it('finds JSON wrapped in prose or code fences', () => {
    expect(extractJson('Sure!\n```json\n{"title":"A","when":null}\n```')).toEqual({ title: 'A', when: null });
    expect(() => extractJson('no idea')).toThrow();
  });
  it('the prompt asks for translation, not date maths', () => {
    expect(systemPrompt()).toContain('Do NOT calculate dates');
    expect(systemPrompt()).toContain('parso = day after tomorrow');
  });
});

describe('createVoiceLlm (OpenAI-compatible, fake fetch)', () => {
  it('posts to <base>/chat/completions with the key and model, and parses the reply', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"Bank jana","when":"day after tomorrow at 2 pm","priority":"high"}' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const llm = createVoiceLlm({ baseUrl: 'https://llm.example/v1/', model: 'test-model', apiKey: 'k-123', fetch: fakeFetch });
    const r = await llm.parse('parso dopahar 2 baje bank jana zaruri', NOW);
    expect(r).toEqual({ title: 'Bank jana', when: 'day after tomorrow at 2 pm', priority: 'high' });
    expect(calls[0]!.url).toBe('https://llm.example/v1/chat/completions');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer k-123');
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent).toMatchObject({ model: 'test-model', temperature: 0 });
    expect(sent.messages[1]).toEqual({ role: 'user', content: 'parso dopahar 2 baje bank jana zaruri' });
    expect(sent.chat_template_kwargs).toBeUndefined(); // only sent to NVIDIA
  });
  it('turns thinking off on NVIDIA and reports an empty reply clearly', async () => {
    const bodies: any[] = [];
    const empty = createVoiceLlm({ baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'nvidia/x', apiKey: 'k',
      fetch: (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ choices: [{ message: { content: null } }] })); }) as unknown as typeof fetch });
    await expect(empty.parse('x', NOW)).rejects.toThrow('empty model reply');
    expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false });
  });
  it('throws on an HTTP error or a reply without JSON', async () => {
    const bad = createVoiceLlm({ baseUrl: 'https://x/v1', model: 'm', apiKey: 'k', fetch: (async () => new Response('nope', { status: 429 })) as unknown as typeof fetch });
    await expect(bad.parse('x', NOW)).rejects.toThrow('model HTTP 429');
    const prose = createVoiceLlm({ baseUrl: 'https://x/v1', model: 'm', apiKey: 'k', fetch: (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'I cannot' } }] }))) as unknown as typeof fetch });
    await expect(prose.parse('x', NOW)).rejects.toThrow();
  });
});

describe('POST /api/app/voice-parse', () => {
  const fakeLlm = (fail = false) => ({
    async parse(text: string) {
      if (fail) throw new Error('model HTTP 500');
      return { title: `T:${text}`, when: 'tomorrow at 9 am', priority: null };
    },
  });

  it('returns the model result for a signed-in person, and reports whether AI is available', async () => {
    const t = await setupNudge({ voiceLlm: fakeLlm(), env: { GOOGLE_OAUTH_CLIENT_ID: undefined } });
    t.person('ann@example.com', 'member');
    const ann = await t.loginWithCode('ann@example.com');
    expect((await t.request('POST', '/api/app/voice-parse', { body: { text: 'x' } })).status).toBe(401);
    expect((await t.request('GET', '/api/app/voice-parse', { cookie: ann })).json).toEqual({ ai: true });
    const r = await t.request('POST', '/api/app/voice-parse', { cookie: ann, body: { text: 'kal subah demo' } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ title: 'T:kal subah demo', when: 'tomorrow at 9 am', priority: null, source: 'ai' });
    expect((await t.request('POST', '/api/app/voice-parse', { cookie: ann, body: { text: '  ' } })).status).toBe(400);
    expect((await t.request('POST', '/api/app/voice-parse', { cookie: ann, body: { text: 'x'.repeat(501) } })).status).toBe(400);
  });

  it('limits each person to 20 requests a minute', async () => {
    const t = await setupNudge({ voiceLlm: fakeLlm(), env: { GOOGLE_OAUTH_CLIENT_ID: undefined } });
    t.person('ann@example.com', 'member');
    const ann = await t.loginWithCode('ann@example.com');
    for (let i = 0; i < 20; i++) expect((await t.request('POST', '/api/app/voice-parse', { cookie: ann, body: { text: 'x' } })).status).toBe(200);
    expect((await t.request('POST', '/api/app/voice-parse', { cookie: ann, body: { text: 'x' } })).status).toBe(429);
    t.advance(60_001);
    expect((await t.request('POST', '/api/app/voice-parse', { cookie: ann, body: { text: 'x' } })).status).toBe(200);
  });

  it('answers 503 when no model is configured and 502 when the model fails', async () => {
    const off = await setupNudge({ env: { GOOGLE_OAUTH_CLIENT_ID: undefined } });
    off.person('ann@example.com', 'member');
    const a = await off.loginWithCode('ann@example.com');
    expect((await off.request('GET', '/api/app/voice-parse', { cookie: a })).json).toEqual({ ai: false });
    expect((await off.request('POST', '/api/app/voice-parse', { cookie: a, body: { text: 'x' } })).status).toBe(503);
    const bad = await setupNudge({ voiceLlm: fakeLlm(true), env: { GOOGLE_OAUTH_CLIENT_ID: undefined } });
    bad.person('ann@example.com', 'member');
    const b = await bad.loginWithCode('ann@example.com');
    const r = await bad.request('POST', '/api/app/voice-parse', { cookie: b, body: { text: 'x' } });
    expect(r.status).toBe(502);
    expect(r.json.error).toBe('could not understand that automatically');
  });
});
