// App-shell cache only. API calls go to the network every time so stock, prices and orders are never stale.
const CACHE = 'taneja-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api')) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && (url.pathname.startsWith('/assets/') || event.request.mode === 'navigate')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request.mode === 'navigate' ? '/' : event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request.mode === 'navigate' ? '/' : event.request).then((r) => r ?? Response.error())),
  );
});
