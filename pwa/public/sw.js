/* VaultTabs service worker.
 *
 * - Precaches only a static offline page (nothing user-specific).
 * - Navigations: network-first; successful same-origin HTML is cached so the app shell (and the
 *   offline /unlock page) still opens without a connection; otherwise /offline.html.
 *   Pages contain no user data: everything sensitive is fetched and decrypted client-side.
 * - Cache-first only for immutable build assets (/_next/static/*) and icons.
 * - API responses and cross-origin requests are never touched or cached.
 */

const VERSION = 'v3';
const SHELL_CACHE = `vaulttabs-shell-${VERSION}`;
const STATIC_CACHE = `vaulttabs-static-${VERSION}`;
const OFFLINE_URL = '/offline.html';
const CACHEABLE_PAGES = new Set(['/', '/login', '/register', '/unlock', '/dashboard', '/devices', '/settings']);
const STATIC_ASSETS = /^\/(_next\/static\/|icon-\d+\.png$|favicon\.png$|manifest\.json$)/;

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(cache => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(k => k.startsWith('vaulttabs-') && k !== SHELL_CACHE && k !== STATIC_CACHE)
            .map(k => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never handle cross-origin requests (the API lives on its own origin) or any /api path.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api')) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstPage(req, url));
    return;
  }

  // React Server Component payloads and everything else dynamic: straight to the network.
  if (req.headers.get('RSC') || url.searchParams.has('_rsc')) return;

  if (STATIC_ASSETS.test(url.pathname)) {
    event.respondWith(cacheFirst(req));
  }
});

async function networkFirstPage(req, url) {
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic' && !res.redirected && CACHEABLE_PAGES.has(url.pathname)) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(url.pathname, res.clone());
    }
    return res;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    return (await cache.match(url.pathname)) || (await cache.match(OFFLINE_URL)) || Response.error();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === 'basic') await cache.put(req, res.clone());
  return res;
}
