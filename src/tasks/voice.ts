// Voice tasks: the spoken sentence is sent here first and an OpenAI-compatible chat model (NVIDIA build.nvidia.com by
// default) splits it into { title, when, priority }, with `when` rewritten in plain English. The app then computes the
// due time from `when` with its tested IST parser (models get weekdays and Hindi day words wrong). The model never
// writes anything, and the spoken text is never logged.

import { z } from 'zod';
import { logger } from '../logger.js';

const log = logger.child({ module: 'voice' });

export interface VoiceResult {
  title: string;
  /** The date/time words rewritten in plain English ("day after tomorrow at 3:30 pm"), or null. The app computes the date. */
  when: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent' | null;
}

export interface VoiceLlm {
  parse(text: string, now: Date): Promise<VoiceResult>;
}

export interface VoiceLlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const modelReply = z.object({
  title: z.string().trim().min(1).max(200),
  when: z.string().trim().max(120).nullable().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).nullable().optional(),
});

/**
 * The model only does language: it separates the task from the date/time words and rewrites those in plain English.
 * Date arithmetic (which small models get wrong: weekdays, "parso", "13th") is done by the app's tested parser.
 */
export function systemPrompt(): string {
  return [
    'You split one spoken to-do item into JSON. The speaker is in India and may mix English and Hindi (Hinglish, in Latin or Devanagari script).',
    'Reply with ONLY one JSON object, no other text: {"title": string, "when": string or null, "priority": "low"|"medium"|"high"|"urgent" or null}.',
    'title: the task itself without the date, time, priority or filler like "remind me to"; keep the speaker\'s own words (Hinglish stays Hinglish, in Latin script); capital first letter.',
    'when: ONLY the date and time words, rewritten in simple English using forms like: "today", "tonight", "tomorrow", "day after tomorrow", "on friday", "next friday", "on 13th", "on 13 december", "in 3 days", "at 3:30 pm", "at 9 am", "in 2 hours", "in 30 minutes", "in the morning", "in the afternoon", "in the evening", "at night". Do NOT calculate dates; just translate.',
    'Hindi: kal = tomorrow, parso = day after tomorrow, aaj = today, subah = morning (am), dopahar = afternoon (pm), shaam = evening (pm), raat = night (pm), baje = o\'clock, saade 3 = 3:30, sava 3 = 3:15, paune 3 = 2:45, 13 tarikh = on 13th, somvar/mangalvar/budhvar/guruvar/shukravar/shanivar/ravivar = monday..sunday.',
    'Always write am or pm with a time: from the words (shaam/evening/raat/night/dopahar = pm, subah/morning = am), else from context.',
    'when is null if no date or time is said. Never invent one.',
    'priority only when the speaker says it: urgent/asap/bahut zaruri = urgent, important/zaruri = high, low priority/no rush = low; otherwise null.',
    'Examples:',
    '"parso dopahar saade 3 baje bank jana hai" -> {"title":"Bank jana hai","when":"day after tomorrow at 3:30 pm","priority":null}',
    '"Get a demo for margin sales on 13th" -> {"title":"Get a demo for margin sales","when":"on 13th","priority":null}',
    '"remind me to call Ravi in 2 hours, it is important" -> {"title":"Call Ravi","when":"in 2 hours","priority":"high"}',
  ].join('\n');
}

/** The first {...} block in a model reply (models sometimes wrap JSON in prose or code fences). */
export function extractJson(content: string): unknown {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON in model reply');
  return JSON.parse(content.slice(start, end + 1));
}

/** Validates the model's JSON. */
export function toResult(raw: unknown): VoiceResult {
  const v = modelReply.parse(raw);
  const when = v.when && v.when.trim() && !/^(null|none|n\/a)$/i.test(v.when.trim()) ? v.when.trim() : null;
  return { title: v.title.charAt(0).toUpperCase() + v.title.slice(1), when, priority: v.priority ?? null };
}

export function createVoiceLlm(cfg: VoiceLlmConfig): VoiceLlm {
  const doFetch = cfg.fetch ?? fetch;
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const isNvidia = /(^|\.)nvidia\.com$/i.test(new URL(cfg.baseUrl).hostname);
  return {
    async parse(text, now) {
      const started = Date.now();
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}`, Accept: 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          max_tokens: 300,
          messages: [{ role: 'system', content: systemPrompt() }, { role: 'user', content: text }],
          // NVIDIA-hosted reasoning models (Nemotron) otherwise spend the whole budget "thinking" and return no
          // content. Only sent to NVIDIA: other OpenAI-compatible APIs may reject unknown fields.
          ...(isNvidia && { chat_template_kwargs: { enable_thinking: false } }),
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 10_000),
      });
      if (!res.ok) {
        log.warn('voice model request failed', { status: res.status, ms: Date.now() - started });
        throw new Error(`model HTTP ${res.status}`);
      }
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('empty model reply (is it a reasoning model with thinking on?)');
      const result = toResult(extractJson(content));
      log.info('voice task parsed by model', { ms: Date.now() - started, chars: text.length, hasWhen: result.when !== null });
      return result;
    },
  };
}
