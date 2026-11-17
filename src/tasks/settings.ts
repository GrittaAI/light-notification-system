// Task notification settings, stored in the settings table (tasks.* keys) and validated with zod on every write.

import { z } from 'zod';
import type { DB } from '../db.js';
import { parseOrThrow } from '../store-errors.js';

export interface QuietHours { enabled: boolean; start: string; end: string }
export interface TaskSettings {
  leadMinutes: number;
  repeatMinutes: number;
  /** A digest that is due anyway also pulls in tasks that become nudgeable within this many minutes (0 = off). */
  mergeAheadMinutes: number;
  defaultGroupId: string | null;
  quietHours: QuietHours;
}

export const DEFAULT_TASK_SETTINGS: TaskSettings = {
  leadMinutes: 10,
  repeatMinutes: 10,
  mergeAheadMinutes: 5,
  defaultGroupId: null,
  quietHours: { enabled: false, start: '21:00', end: '09:00' },
};

const KEYS = {
  leadMinutes: 'tasks.lead_minutes',
  repeatMinutes: 'tasks.repeat_minutes',
  mergeAheadMinutes: 'tasks.merge_ahead_minutes',
  defaultGroupId: 'tasks.default_group_id',
  quietHours: 'tasks.quiet_hours',
} as const;

const hhmm = z.string({ error: 'Use a time like 21:00' }).regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 21:00');
const minutes = (min: number, max: number) => {
  const msg = `Enter a whole number from ${min} to ${max}`;
  return z.number({ error: msg }).int(msg).min(min, msg).max(max, msg);
};

export const taskSettingsSchema = z.object({
  leadMinutes: minutes(1, 1440),
  repeatMinutes: minutes(5, 1440),
  mergeAheadMinutes: minutes(0, 15),
  defaultGroupId: z.string({ error: 'Choose a WhatsApp group' }).trim().regex(/^[\w-]+@g\.us$/, 'Choose a WhatsApp group').nullable(),
  quietHours: z
    .object({ enabled: z.boolean({ error: 'Turn quiet hours on or off' }), start: hhmm, end: hhmm })
    .refine((q) => !q.enabled || q.start !== q.end, 'Start and end times must be different'),
});

export function getTaskSettings(db: DB): TaskSettings {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'tasks.%'`).all() as { key: string; value: string }[];
  const raw: Record<string, unknown> = {};
  for (const r of rows) {
    try { raw[r.key] = JSON.parse(r.value); } catch { /* ignore a corrupt value: its default applies */ }
  }
  const candidate = {
    leadMinutes: raw[KEYS.leadMinutes] ?? DEFAULT_TASK_SETTINGS.leadMinutes,
    repeatMinutes: raw[KEYS.repeatMinutes] ?? DEFAULT_TASK_SETTINGS.repeatMinutes,
    mergeAheadMinutes: raw[KEYS.mergeAheadMinutes] ?? DEFAULT_TASK_SETTINGS.mergeAheadMinutes,
    defaultGroupId: raw[KEYS.defaultGroupId] ?? DEFAULT_TASK_SETTINGS.defaultGroupId,
    quietHours: raw[KEYS.quietHours] ?? DEFAULT_TASK_SETTINGS.quietHours,
  };
  const parsed = taskSettingsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : DEFAULT_TASK_SETTINGS;
}

/** Partial update: omitted fields keep their current value; the merged result is validated. Returns the new settings. */
export function setTaskSettings(db: DB, input: unknown): TaskSettings {
  const patch = parseOrThrow(taskSettingsSchema.partial(), input);
  const next = parseOrThrow(taskSettingsSchema, { ...getTaskSettings(db), ...patch });
  const at = new Date().toISOString();
  const up = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  db.transaction(() => {
    for (const [field, key] of Object.entries(KEYS)) up.run(key, JSON.stringify(next[field as keyof TaskSettings]), at);
  })();
  return next;
}
