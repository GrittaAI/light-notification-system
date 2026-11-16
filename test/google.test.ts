import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, envSchema } from '../src/config.js';
import { isNotShared, loadServiceAccountKey } from '../src/google.js';
import { openDb } from '../src/db.js';
import { runMonitor } from '../src/monitor.js';
import { startupSummary } from '../src/startup.js';
import { seedFromConfigFile } from '../src/store.js';
import { runSync } from '../src/sync.js';
import type { Calendar } from '../src/google.js';

const SECRET = 'DUMMY-PRIVATE-KEY-MATERIAL-1234567890';
const validKey = {
  type: 'service_account',
  client_email: 'sa@proj.iam.gserviceaccount.com',
  private_key: `-----BEGIN PRIVATE KEY-----\n${SECRET}\n-----END PRIVATE KEY-----\n`,
};

let dir: string;
let keyFile: string;

beforeAll(() => {
  process.env.LOG_LEVEL = 'error';
  dir = mkdtempSync(join(tmpdir(), 'sa-test-'));
  keyFile = join(dir, 'key.json');
  writeFileSync(keyFile, JSON.stringify(validKey));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error('expected a throw');
}

describe('loadServiceAccountKey', () => {
  it('reads the key from a file', () => {
    expect(loadServiceAccountKey({ GOOGLE_SERVICE_ACCOUNT_KEY_FILE: keyFile })).toEqual({
      client_email: validKey.client_email,
      private_key: validKey.private_key,
    });
  });

  it('parses the key from JSON in the environment', () => {
    const key = loadServiceAccountKey({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(validKey) });
    expect(key.client_email).toBe(validKey.client_email);
  });

  it('errors when both or neither are set', () => {
    const both = { GOOGLE_SERVICE_ACCOUNT_KEY_FILE: keyFile, GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(validKey) };
    expect(messageOf(() => loadServiceAccountKey(both))).toContain('only one');
    expect(messageOf(() => loadServiceAccountKey({}))).toContain('set one of');
  });

  it('errors on malformed JSON or missing fields without leaking the key', () => {
    const bad = [
      `{"type":"service_account","private_key":"${SECRET}"`, // truncated JSON
      JSON.stringify({ ...validKey, type: 'authorized_user' }),
      JSON.stringify({ ...validKey, client_email: undefined }),
      JSON.stringify({ ...validKey, private_key: '' }),
    ];
    for (const json of bad) {
      const m = messageOf(() => loadServiceAccountKey({ GOOGLE_SERVICE_ACCOUNT_JSON: json }));
      expect(m).not.toContain(SECRET);
      expect(m).not.toContain('PRIVATE KEY');
    }
    const badFile = join(dir, 'bad.json');
    writeFileSync(badFile, bad[0]!);
    expect(messageOf(() => loadServiceAccountKey({ GOOGLE_SERVICE_ACCOUNT_KEY_FILE: badFile }))).not.toContain(SECRET);
  });

  it('reports a directory path', () => {
    const d = join(dir, 'a-directory');
    mkdirSync(d);
    const m = messageOf(() => loadServiceAccountKey({ GOOGLE_SERVICE_ACCOUNT_KEY_FILE: d }));
    expect(m).toContain('is a directory');
    expect(m).toContain('Docker');
  });

  it('reports a missing file', () => {
    const m = messageOf(() => loadServiceAccountKey({ GOOGLE_SERVICE_ACCOUNT_KEY_FILE: join(dir, 'nope.json') }));
    expect(m).toContain('cannot read');
  });
});

describe('envSchema service account variables', () => {
  const base = {
    WAHA_URL: 'http://waha:3000', WAHA_SESSION: 'default', WAHA_API_KEY: 'k',
    ALERT_EMAIL_TO: 'ops@example.com', SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587',
    SMTP_USER: 'u', SMTP_PASS: 'p',
    SUPERADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'a-long-test-password',
  };
  it('accepts exactly one, treating empty strings as unset', () => {
    expect(envSchema.safeParse({ ...base, GOOGLE_SERVICE_ACCOUNT_KEY_FILE: 'k.json', GOOGLE_SERVICE_ACCOUNT_JSON: '' }).success).toBe(true);
    expect(envSchema.safeParse({ ...base, GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }).success).toBe(true);
  });
  it('rejects both and neither', () => {
    const both = envSchema.safeParse({ ...base, GOOGLE_SERVICE_ACCOUNT_KEY_FILE: 'k.json', GOOGLE_SERVICE_ACCOUNT_JSON: '{}' });
    expect(both.success).toBe(false);
    expect(JSON.stringify(both.error?.issues)).toContain('not both');
    const neither = envSchema.safeParse({ ...base, GOOGLE_SERVICE_ACCOUNT_KEY_FILE: '' });
    expect(neither.success).toBe(false);
    expect(JSON.stringify(neither.error?.issues)).toContain('set one of');
  });
});

const gErr = (status: number, reason: string) => ({
  response: { status, data: { error: { code: status, errors: [{ reason }] } } },
});

describe('isNotShared', () => {
  it('is true for 404 and a plain 403', () => {
    expect(isNotShared(gErr(404, 'notFound'))).toBe(true);
    expect(isNotShared(gErr(403, 'forbidden'))).toBe(true);
  });
  it('is false for 403 rate limit and API-disabled reasons', () => {
    expect(isNotShared(gErr(403, 'rateLimitExceeded'))).toBe(false);
    expect(isNotShared(gErr(403, 'accessNotConfigured'))).toBe(false);
  });
  it('is false for other errors', () => {
    expect(isNotShared(gErr(500, 'backendError'))).toBe(false);
    expect(isNotShared(new Error('network'))).toBe(false);
  });
});

describe('not-shared calendar through sync, startup check and monitor', () => {
  it('carries the exact message everywhere', async () => {
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({
      closers: [],
      clients: [{ name: 'Client A', calendarId: 'a@gmail.com', whatsappGroupId: '1203@g.us' }],
    }));
    try {
      const calendar = {
        events: { list: async () => { throw gErr(404, 'notFound'); } },
      } as unknown as Calendar;
      const db = openDb(':memory:');
      seedFromConfigFile(db, cfgPath);
      const result = await runSync(db, calendar, { serviceAccountEmail: 'sa@proj.iam.gserviceaccount.com' });
      const msg = 'Calendar Client A is not shared with the service account sa@proj.iam.gserviceaccount.com (See all event details)';

      expect(result.ok).toBe(false);
      expect(result.calendars[0]!.error).toEqual({ message: msg, status: 404, reason: 'not_shared' });
      expect(startupSummary(result, 'WORKING').calendars.failing).toEqual([{ client: 'Client A', error: msg }]);

      const sent: { subject: string; text: string }[] = [];
      const startedAt = new Date(Date.now() - 11 * 60_000);
      await runMonitor({
        db,
        whatsapp: { async getSessionStatus() { return 'WORKING'; } },
        alerts: { async send(subject: string, text: string) { sent.push({ subject, text }); } },
        getLastSyncResult: () => result,
        startedAt,
      }, new Date());
      const stale = sent.find((m) => m.subject.includes('sync is stale'));
      expect(stale?.text).toContain(msg);
    } finally {
      // nothing to restore
    }
  });
});
