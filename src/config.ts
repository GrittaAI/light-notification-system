import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

// ---------- config.json (first-start import only; no secrets here) ----------

// International number, digits only (a leading "+" and spaces/dashes are stripped).
// e.g. "+91 98765-43210" -> "919876543210"
/**
 * A WhatsApp number (international format, digits only after cleaning) with a caller-chosen error message.
 * `typeMessage` (Nudge only) also replaces zod's wording for a missing or non-string value; without it the base is a plain
 * z.string(), so the reminders console's messages stay exactly as they were.
 */
export const whatsappSchemaWith = (message: string, typeMessage?: string) => z
  .string(typeMessage ? { error: typeMessage } : undefined)
  .transform((s) => s.replace(/[\s\-()]/g, '').replace(/^\+/, ''))
  .pipe(z.string().regex(/^[1-9]\d{7,14}$/, message));
export const whatsappSchema = whatsappSchemaWith('must be an international number with country code');

export const closerSchema = z.object({
  name: z.string().trim().min(1),
  // Stored lowercase so attendee matching is case-insensitive.
  email: z.string().trim().toLowerCase().pipe(z.email()),
  whatsapp: whatsappSchema,
});

export const clientSchema = z.object({
  name: z.string().trim().min(1),
  calendarId: z.string().trim().min(1),
  whatsappGroupId: z.string().trim().regex(/^[\w-]+@g\.us$/, 'must be a WhatsApp group id ending in @g.us'),
});

export const appConfigSchema = z
  .object({
    closers: z.array(closerSchema),
    clients: z.array(clientSchema).min(1),
  })
  .superRefine((cfg, ctx) => {
    const dupes = (values: string[]) => values.filter((v, i) => values.indexOf(v) !== i);
    for (const email of new Set(dupes(cfg.closers.map((c) => c.email)))) {
      ctx.addIssue({ code: 'custom', path: ['closers'], message: `duplicate closer email: ${email}` });
    }
    for (const id of new Set(dupes(cfg.clients.map((c) => c.calendarId)))) {
      ctx.addIssue({ code: 'custom', path: ['clients'], message: `duplicate calendarId: ${id}` });
    }
  });

export type AppConfig = z.infer<typeof appConfigSchema>;
export type Closer = AppConfig['closers'][number];
export type Client = AppConfig['clients'][number];

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function configPath(): string {
  return process.env.CONFIG_PATH ?? 'config.json';
}

/** Reads and validates config.json. Throws ConfigError with a readable message on any problem. */
export function loadConfig(path = configPath()): AppConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`cannot read ${path}: ${(err as Error).message}`);
  }
  const result = appConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`invalid ${path}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

// ---------- secrets from environment / .env (read once at startup) ----------

// Empty strings count as unset (e.g. `GOOGLE_SERVICE_ACCOUNT_JSON=` in a .env file).
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v : undefined));

// "true"/"false" (case-insensitive); unset or empty means false.
const boolString = optionalString
  .refine((v) => v === undefined || ['true', 'false'].includes(v.trim().toLowerCase()), 'must be "true" or "false"')
  .transform((v) => v?.trim().toLowerCase() === 'true');

export const envSchema = z
  .object({
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE: optionalString,
  GOOGLE_SERVICE_ACCOUNT_JSON: optionalString,
  WAHA_URL: z.url(),
  WAHA_SESSION: z.string().min(1),
  WAHA_API_KEY: z.string().min(1),
  ALERT_EMAIL_TO: z.email(),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive(),
  SMTP_USER: z.string().min(1),
  SMTP_PASS: z.string().min(1),
  DB_PATH: z.string().min(1).default('data/app.db'),
  HEALTH_PORT: z.coerce.number().int().positive().default(8080),
  // Admin UI
  SUPERADMIN_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
  ADMIN_PASSWORD: optionalString.refine((v) => v === undefined || v.length >= 12, 'must be at least 12 characters'),
  GOOGLE_OAUTH_CLIENT_ID: optionalString,
  ADMIN_PORT: z.coerce.number().int().positive().default(8081),
  ADMIN_HOST: z.string().min(1).default('127.0.0.1'),
  ADMIN_COOKIE_SECURE: boolString,
  ADMIN_TRUST_PROXY: boolString,
  // Which product this process runs: the call reminders (default) or Nudge (tasks). See README "Nudge".
  SERVICE_ROLE: z.enum(['reminders', 'tasks']).default('reminders'),
  // Nudge
  APP_NAME: z.string().trim().min(1).default('Pushup Nudge'),
  TASKS_PORT: z.coerce.number().int().positive().default(8082),
  TASKS_HOST: z.string().min(1).default('127.0.0.1'),
  TASKS_HEALTH_PORT: z.coerce.number().int().positive().default(8083),
  // Public base URL of Nudge (e.g. https://nudge.grittaai.com) used for links in WhatsApp messages. Unset: no links.
  TASKS_PUBLIC_URL: optionalString
    .refine((v) => v === undefined || /^https?:\/\/[^\s/]+/i.test(v.trim()), 'must be an http(s) URL')
    .transform((v) => v?.trim().replace(/\/+$/, '')),
  })
  .superRefine((env, ctx) => {
    if (!env.ADMIN_PASSWORD && !env.GOOGLE_OAUTH_CLIENT_ID) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_PASSWORD'],
        message: 'set at least one admin login method: ADMIN_PASSWORD or GOOGLE_OAUTH_CLIENT_ID',
      });
    }
    // Nudge does not read Google Calendar: only the reminders role needs the service account key.
    if (env.SERVICE_ROLE === 'tasks') return;
    const hasFile = !!env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
    const hasJson = !!env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (hasFile && hasJson) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_SERVICE_ACCOUNT_KEY_FILE'],
        message: 'set only one of GOOGLE_SERVICE_ACCOUNT_KEY_FILE and GOOGLE_SERVICE_ACCOUNT_JSON, not both',
      });
    } else if (!hasFile && !hasJson) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_SERVICE_ACCOUNT_KEY_FILE'],
        message: 'set one of GOOGLE_SERVICE_ACCOUNT_KEY_FILE (path to the JSON key) or GOOGLE_SERVICE_ACCOUNT_JSON (the key contents)',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Loads .env if present (real environment variables win), then validates. */
export function loadEnv(envFile = '.env'): Env {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    throw new ConfigError(`invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
