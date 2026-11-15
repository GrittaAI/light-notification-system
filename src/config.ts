import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

// ---------- config.json (re-read on every sync run; no secrets here) ----------

const closerSchema = z.object({
  name: z.string().trim().min(1),
  // Stored lowercase so attendee matching is case-insensitive.
  email: z.string().trim().toLowerCase().pipe(z.email()),
  // International number, digits only (a leading "+" and spaces/dashes are stripped).
  // e.g. "+91 98765-43210" -> "919876543210"
  whatsapp: z
    .string()
    .transform((s) => s.replace(/[\s\-()]/g, '').replace(/^\+/, ''))
    .pipe(z.string().regex(/^[1-9]\d{7,14}$/, 'must be an international number with country code')),
});

const clientSchema = z.object({
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

// Last config that passed validation. If someone saves a broken config.json we keep
// using this one (the caller logs the error) instead of stopping all reminders.
let lastGoodConfig: AppConfig | undefined;

/**
 * Reloads config.json. On failure returns the last valid config with `error` set;
 * throws only if no config has ever loaded successfully.
 */
export function loadConfigOrLastGood(): { config: AppConfig; fresh: boolean; error?: unknown } {
  try {
    lastGoodConfig = loadConfig();
    return { config: lastGoodConfig, fresh: true };
  } catch (err) {
    if (!lastGoodConfig) throw err;
    return { config: lastGoodConfig, fresh: false, error: err };
  }
}

// ---------- secrets from environment / .env (read once at startup) ----------

const envSchema = z.object({
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REFRESH_TOKEN: z.string().min(1),
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
