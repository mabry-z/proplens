// PropLens service worker: opens instantly and works offline.
// Bump VERSION whenever app files change so phones pick up the update.
const VERSION = 'v3';
const SHELL = `proplens-shell-${VERSION}`;
const DATA = 'proplens-data';
const FONTS = 'proplens-fonts';
const APP_FILES = ['./', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'icon.svg',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/favicon-64.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('proplens-shell-') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Board data: always try the network; fall back to the last saved copy when offline.
  if (url.pathname.startsWith('/rest/v1/')) {
    // The time filter changes every visit, so leave it out of the saved copy's key.
    const keyUrl = new URL(url); keyUrl.searchParams.delete('kickoff');
    const key = keyUrl.toString();
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(DATA).then(c => c.put(key, copy)); }
      return res;
    }).catch(async () => {
      const hit = await caches.match(key);
      if (!hit) throw new Error('offline');
      const headers = new Headers(hit.headers);
      headers.set('x-proplens-offline', '1');
      return new Response(await hit.blob(), { status: 200, headers });
    }));
    return;
  }

  // Fonts: cache forever once downloaded.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // App files: serve instantly from cache, refresh in the background.
  if (url.origin === self.location.origin) {
    e.respondWith(caches.open(SHELL).then(async c => {
      const hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
