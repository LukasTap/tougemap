// sw.js
const CACHE = 'tougemap-v2-1';
const SHELL = ['./', './index.html', './styles.css',
  './js/app.js','./js/ui.js','./js/map.js','./js/library.js','./js/planner.js',
  './js/store.js','./js/sync.js','./js/weather.js','./js/geo.js','./js/config.js',
  './js/crypto.js','./js/curvature.js','./js/routing.js','./js/tonight-rank.js','./manifest.json'];

self.addEventListener('install', e =>
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));

self.addEventListener('activate', e =>
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));

// Network-first with cache fallback: when online you always get the freshly
// deployed shell (no version-bump footgun); offline you fall back to the last
// cached copy. Weather/routing/overpass/GitHub-API are never touched here.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // NEVER cache weather, routing, overpass, or the GitHub API
  if (/open-meteo|project-osrm|overpass|api\.github\.com|nominatim/.test(url.host + url.pathname)) return;
  // roads.json: network-first, cache fallback (never store weather etc.)
  if (url.pathname.endsWith('roads.json') || url.host.includes('raw.githubusercontent')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  // App shell: network-first so deployed updates apply immediately; refresh the
  // cached copy on every successful fetch; fall back to cache when offline.
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request))
  );
});
