// sw.js — offline app shell. Caches ONLY this site's own files plus the pinned
// Leaflet build. Everything else (map tiles, weather, routing, GitHub, fonts)
// goes straight to the network: cached map tiles are opaque responses that
// Chrome counts as megabytes each, and one page load used to add ~260 MB.
// The roads themselves work offline through IndexedDB (js/store.js), not here.
//
// Bump CACHE when this list changes; activation deletes every older cache
// (including the old one full of tiles).
const CACHE = 'tougemap-v5';
const LEAFLET = [
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css'
];
// Every module the app imports must be here, or a first visit followed by going
// offline can't boot (test/sw.test.js checks this list against js/).
const SHELL = ['./', './index.html', './styles.css', './manifest.json', './icon-192.png', './icon-512.png',
  './js/app.js', './js/conditions-map.js', './js/config.js', './js/crypto.js', './js/curvature.js', './js/geo.js', './js/http.js',
  './js/library.js', './js/map.js', './js/planner.js', './js/repo.js', './js/routing.js', './js/store.js',
  './js/sync.js', './js/terrain.js', './js/tonight-rank.js', './js/ui.js', './js/weather.js'];

self.addEventListener('install', e =>
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll([...SHELL, ...LEAFLET.map(u => new Request(u, { mode: 'cors' }))]))
    .then(() => self.skipWaiting())));

self.addEventListener('activate', e =>
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())));

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Pinned, versioned Leaflet: cache-first — that exact URL never changes.
  if (LEAFLET.includes(url.href)) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    })));
    return;
  }

  if (url.origin !== self.location.origin) return; // tiles, APIs, fonts: network only

  // Own files: network-first, revalidating past the 10-minute HTTP cache GitHub
  // Pages sends, so a deploy shows up on the next load; offline, the last copy.
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
