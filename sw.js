// Keeps the app shell on the phone so it opens instantly; tile data always comes fresh.
const CACHE = 'garg-tiles-v11';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'selection.js', 'vendor/jspdf.umd.min.js', 'icons/gs-logo.jpg', 'icons/brand-strip.jpg', 'vendor/fonts/Poppins-400.ttf', 'vendor/fonts/Poppins-600.ttf', 'vendor/fonts/Playfair-700.ttf', 'config.js', 'vendor/supabase.js', 'manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();         // a new version takes over at once instead of waiting for every tab to close
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())
));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // network first (asking the server each time, never the browser's own copy), so a new version
  // shows up as soon as it is published
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
