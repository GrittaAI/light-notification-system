// Nudge service worker: caches the app shell only (never /api/*), cache-first, so the app opens offline.
// A new version installs in the background and waits; the page offers "New version available, tap to refresh".
// A waiting worker activates when all Nudge tabs/windows are closed, or when the user taps Refresh.
// VERSION is a content hash of the shell files, put in by the Nudge server when it serves this file.
const VERSION = '__SHELL_HASH__';
const CACHE = `nudge-shell-${VERSION}`;
const SHELL = [
  '/', '/index.html', '/app.js', '/sync-core.js', '/idb.js', '/admin.js', '/voice-parse.js', '/styles.css', '/icons.svg', '/logo.svg',
  '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png',
];

async function precache() {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache()); // no skipWaiting: the new version waits for the next load (or the user's tap)
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('nudge-shell-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'PRECACHE') event.waitUntil(precache());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return; // API responses are never cached
  const isNav = req.mode === 'navigate';
  const path = isNav ? '/' : url.pathname;
  if (!SHELL.includes(path)) return;
  event.respondWith((async () => {
    const cached = await caches.match(path, { cacheName: CACHE });
    if (cached) return cached;
    const res = await fetch(req);
    if (res.ok) (await caches.open(CACHE)).put(path, res.clone());
    return res;
  })());
});
