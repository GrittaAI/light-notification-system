import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { setupNudge } from './helpers/nudge.js';

beforeAll(() => { process.env.LOG_LEVEL = 'error'; });

const FILES: [string, string][] = [
  ['/', 'text/html; charset=utf-8'], ['/index.html', 'text/html; charset=utf-8'], ['/app.js', 'text/javascript; charset=utf-8'],
  ['/sync-core.js', 'text/javascript; charset=utf-8'], ['/idb.js', 'text/javascript; charset=utf-8'], ['/admin.js', 'text/javascript; charset=utf-8'], ['/sw.js', 'text/javascript; charset=utf-8'],
  ['/styles.css', 'text/css; charset=utf-8'], ['/icons.svg', 'image/svg+xml'], ['/logo.svg', 'image/svg+xml'],
  ['/manifest.webmanifest', 'application/manifest+json'], ['/icon-192.png', 'image/png'], ['/icon-512.png', 'image/png'],
  ['/icon-maskable-512.png', 'image/png'], ['/apple-touch-icon.png', 'image/png'],
];

describe('Nudge static files', () => {
  it('serves every PWA file with the right content type', async () => {
    const t = await setupNudge();
    for (const [path, type] of FILES) {
      const r = await t.request('GET', path);
      expect(r.status, path).toBe(200);
      expect(r.headers['content-type'], path).toBe(type);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('serves sw.js with no-cache and index.html with no-store; other paths are not served', async () => {
    const t = await setupNudge();
    expect((await t.request('GET', '/sw.js')).headers['cache-control']).toBe('no-cache');
    expect((await t.request('GET', '/index.html')).headers['cache-control']).toBe('no-store');
    for (const p of ['/test.js', '/../package.json', '/%2e%2e/package.json', '/.env', '/sw.js.map', '/admin/app.js']) {
      expect((await t.request('GET', p)).status, p).toBe(404);
    }
  });

  it('sets a CSP with worker-src and manifest-src (self only), img-src self data:, and no unsafe-inline', async () => {
    const t = await setupNudge();
    const csp = String((await t.request('GET', '/')).headers['content-security-policy']);
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("manifest-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('the reminders admin console CSP is unchanged (no worker-src / manifest-src)', async () => {
    const { CSP, NUDGE_CSP } = await import('../src/http/common.js');
    expect(CSP).not.toContain('worker-src');
    expect(NUDGE_CSP.startsWith(CSP)).toBe(true);
  });

  it('the service worker caches the shell only and never /api', () => {
    const sw = readFileSync(new URL('../public/nudge/sw.js', import.meta.url), 'utf8');
    expect(sw).toContain("startsWith('/api/')");
    expect(sw).not.toMatch(/put\([^)]*api/i);
  });

  it('the PWA source never uses innerHTML-style sinks or inline handlers/styles', () => {
    for (const f of ['app.js', 'idb.js', 'sync-core.js', 'admin.js', 'index.html']) {
      const src = readFileSync(new URL(`../public/nudge/${f}`, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
      if (f === 'index.html') expect(src).not.toMatch(/\sstyle=|\sonclick=|<script(?![^>]*\ssrc=)/);
    }
  });

  it('GET /api/app/nudge-target tells the profile where nudges go (own person only)', async () => {
    const t = await setupNudge();
    t.person('ann@example.com', 'member', { notifyTarget: 'dm', whatsapp: '919812345678' });
    const c = await t.loginWithCode('ann@example.com');
    expect((await t.request('GET', '/api/app/nudge-target', { cookie: c })).json).toEqual({ target: 'dm', configured: true });
    const sup = await t.loginSuper();
    expect((await t.request('GET', '/api/app/nudge-target', { cookie: sup })).json).toEqual({ target: 'none', configured: false });
    expect((await t.request('GET', '/api/app/nudge-target')).status).toBe(401);
  });
});

describe('service worker versioning', () => {
  it('serves sw.js from memory with the shell hash filled in; any shell file change changes it', async () => {
    const { cpSync, mkdtempSync, writeFileSync, readFileSync: rf } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'nudge-pub-'));
    cpSync(new URL('../public/nudge/', import.meta.url), dir, { recursive: true });
    const fetchSw = async () => {
      const t = await setupNudge({ publicDir: dir });
      const r = await t.request('GET', '/sw.js');
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-cache');
      return r.body;
    };
    const first = await fetchSw();
    expect(first).not.toContain('__SHELL_HASH__');
    expect(first).toMatch(/const VERSION = '[0-9a-f]{12}';/);
    expect(await fetchSw()).toBe(first); // stable for unchanged files
    for (const f of ['app.js', 'styles.css', 'index.html', 'icon-192.png', 'manifest.webmanifest']) {
      const orig = rf(join(dir, f));
      writeFileSync(join(dir, f), Buffer.concat([orig, Buffer.from(f.endsWith('.png') ? [0] : '\n')]));
      const changed = await fetchSw();
      expect(changed, f).not.toBe(first);
      expect(changed).not.toContain('__SHELL_HASH__');
      writeFileSync(join(dir, f), orig);
    }
    expect(rf(new URL('../public/nudge/sw.js', import.meta.url), 'utf8')).toContain("'__SHELL_HASH__'");
  });
});
