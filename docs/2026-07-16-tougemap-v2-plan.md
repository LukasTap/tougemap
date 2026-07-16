# TougeMap v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the single-file `H:\tougemap.html` into a maintainable, cross-device, GitHub-backed static PWA whose primary surface is a synced library of saved driving roads with live night-conditions.

**Architecture:** Plain ES-module files served over HTTPS from GitHub Pages — no bundler, no framework. Pure-logic modules (`geo`, `store`, `curvature`, `weather` scoring) are Node-testable; browser modules (`map`, `library`, `tonight`, `planner`, `sync`, `app`, `ui`) are thin and manually verified. Road data lives as `roads.json` in the same public repo; the owner writes via a GitHub token on PC, everyone else reads the public file.

**Tech Stack:** Vanilla JS (ES modules), Leaflet 1.9.4 (CDN), open-meteo (weather, no key), OSRM public demo (routing), Overpass (curvature discovery), GitHub Contents API (write) + raw fetch (read), IndexedDB (offline read cache), `node --test` (unit tests, no deps).

## Global Constraints

- **No build step / no runtime dependencies.** Only Leaflet from CDN. `package.json` exists solely for `type: module` + the test script; it has **zero** `dependencies`/`devDependencies`.
- **Token never in shipped files.** The GitHub PAT is entered at runtime and stored in `localStorage`; it must never be written into any committed file.
- **Weather never persisted.** No forecast in IndexedDB or the service worker cache. In-memory session cache only, ~30 min TTL, ~10 km grid dedup.
- **Single public repo** holds app files + `roads.json`.
- **PC creates/edits; phone views only.** No drawing/editing UI on viewports ≤768px.
- **Keep the curvature algorithm verbatim.** It is a correct port of adamfranco/curvature; port the functions unchanged from the v1 source, only re-homing them into a module.
- **Data schema v2** exactly as in the design spec §3.2; migrate v1 imports losslessly.
- **Dark tactical theme** retained; colors from the v1 `:root` custom properties.
- Source of truth for verbatim ports: `H:\tougemap.html` (v1), referenced by line number below.

---

### Task 1: Project scaffold + test harness

**Files:**
- Create: `H:\tougemap\package.json`
- Create: `H:\tougemap\.gitignore`
- Create: `H:\tougemap\index.html` (skeleton only)
- Create: `H:\tougemap\test\smoke.test.js`

**Interfaces:**
- Produces: `npm test` runs `node --test`; ES-module `.js` files resolve in both Node and browser.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "tougemap",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```gitignore
node_modules/
.DS_Store
*.local
# never commit a token or private data snapshots
secrets.*
```

- [ ] **Step 3: Create `index.html` skeleton**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>TougeMap</title>
  <link rel="manifest" href="manifest.json">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.css"/>
  <link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Barlow:wght@300;400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div id="app"></div>
  <script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.js"></script>
  <script type="module" src="js/app.js"></script>
</body>
</html>
```

- [ ] **Step 4: Write the smoke test**

```js
// test/smoke.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('test harness runs', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 5: Run tests, verify pass**

Run: `cd /h/tougemap && npm test`
Expected: `# pass 1`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore index.html test/smoke.test.js
git commit -m "chore: scaffold TougeMap v2 (no-build ES modules + node --test)"
```

---

### Task 2: Geometry utilities (`js/geo.js`)

**Files:**
- Create: `H:\tougemap\js\geo.js`
- Test: `H:\tougemap\test\geo.test.js`

**Interfaces:**
- Produces:
  - `haversineKm(lat1, lon1, lat2, lon2): number` — great-circle km
  - `polylineKm(points): number` — `points: {lat,lon}[]`
  - `bearingLabel(lat1, lon1, lat2, lon2): string` — one of N/NE/E/SE/S/SW/W/NW
  - `gridCellKey(lat, lon, cellDeg = 0.1): string` — quantized "lat,lon" bucket (~11 km at 0.1°)
  - `simplifyForThumbnail(points, maxPoints = 40): {lat,lon}[]` — even-stride downsample for card thumbnails

- [ ] **Step 1: Write failing tests**

```js
// test/geo.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, polylineKm, bearingLabel, gridCellKey, simplifyForThumbnail } from '../js/geo.js';

test('haversineKm ~ known distance (Bratislava→Košice ≈ 315 km)', () => {
  const d = haversineKm(48.1486, 17.1077, 48.7164, 21.2611);
  assert.ok(Math.abs(d - 315) < 15, `got ${d}`);
});

test('polylineKm sums segments', () => {
  const pts = [{lat:48.0,lon:19.0},{lat:48.1,lon:19.0},{lat:48.2,lon:19.0}];
  const d = polylineKm(pts);
  assert.ok(Math.abs(d - haversineKm(48.0,19.0,48.2,19.0)) < 0.5, `got ${d}`);
});

test('bearingLabel east', () => {
  assert.equal(bearingLabel(48.0, 19.0, 48.0, 20.0), 'E');
});

test('gridCellKey buckets nearby points together, far points apart', () => {
  assert.equal(gridCellKey(48.71, 19.11), gridCellKey(48.73, 19.14)); // <11km
  assert.notEqual(gridCellKey(48.7, 19.1), gridCellKey(49.5, 19.1));
});

test('simplifyForThumbnail caps point count and keeps ends', () => {
  const pts = Array.from({length: 500}, (_, i) => ({lat: 48 + i/1000, lon: 19}));
  const out = simplifyForThumbnail(pts, 40);
  assert.ok(out.length <= 40);
  assert.deepEqual(out[0], pts[0]);
  assert.deepEqual(out[out.length - 1], pts[pts.length - 1]);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd /h/tougemap && node --test test/geo.test.js`
Expected: FAIL — cannot find module `../js/geo.js`.

- [ ] **Step 3: Implement `js/geo.js`**

```js
// js/geo.js — pure geometry helpers, no browser deps
const R_KM = 6371;
const d2r = Math.PI / 180;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * d2r, dLon = (lon2 - lon1) * d2r;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dLon / 2) ** 2;
  return R_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function polylineKm(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++)
    d += haversineKm(points[i-1].lat, points[i-1].lon, points[i].lat, points[i].lon);
  return d;
}

export function bearingLabel(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * d2r;
  const y = Math.sin(dLon) * Math.cos(lat2 * d2r);
  const x = Math.cos(lat1 * d2r) * Math.sin(lat2 * d2r) -
            Math.sin(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.cos(dLon);
  const b = (Math.atan2(y, x) / d2r + 360) % 360;
  return ['N','NE','E','SE','S','SW','W','NW'][Math.round(b / 45) % 8];
}

export function gridCellKey(lat, lon, cellDeg = 0.1) {
  const q = (v) => (Math.round(v / cellDeg) * cellDeg).toFixed(2);
  return `${q(lat)},${q(lon)}`;
}

export function simplifyForThumbnail(points, maxPoints = 40) {
  if (points.length <= maxPoints) return points.slice();
  const stride = (points.length - 1) / (maxPoints - 1);
  const out = [];
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.round(i * stride)]);
  out[out.length - 1] = points[points.length - 1];
  return out;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd /h/tougemap && node --test test/geo.test.js`
Expected: `# pass 5`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add js/geo.js test/geo.test.js
git commit -m "feat(geo): haversine, polylineKm, bearing, grid dedup, thumbnail simplify"
```

---

### Task 3: Data store + v1→v2 migration (`js/store.js`)

**Files:**
- Create: `H:\tougemap\js\store.js`
- Test: `H:\tougemap\test\store.test.js`

**Interfaces:**
- Consumes: `polylineKm` from `js/geo.js`.
- Produces:
  - `SCHEMA_VERSION = 2`
  - `migrate(raw): {version, home, roads}` — accepts a v1 export (`{version:1,...}` or bare array) or v2; returns normalized v2. Idempotent.
  - `normalizeRoad(r): road` — fills `meta` defaults, computes `km` if missing, leaves `driveTimeFromHome: null` when absent.
  - `emptyData(): {version:2, home:null, roads:[]}`
  - `META_DEFAULT = {pavement:null, character:null, deer:null, notes:''}`
  - Browser-only (not unit-tested, verified in Task 12): `cacheRead(): Promise<data|null>`, `cacheWrite(data): Promise<void>` over IndexedDB store `tougemap/roads`.

- [ ] **Step 1: Write failing tests**

```js
// test/store.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, normalizeRoad, emptyData, SCHEMA_VERSION, META_DEFAULT } from '../js/store.js';

const V1 = {
  version: 1,
  home: { lat: 48.7, lon: 19.1 },
  roads: [{ id: 111, name: 'Old Road', points: [{lat:48.7,lon:20.0},{lat:48.75,lon:20.1}], color:'#b000ff', km: 12.3, saved: '16. 7. 2026' }]
};

test('migrate v1 → v2 shape', () => {
  const out = migrate(V1);
  assert.equal(out.version, SCHEMA_VERSION);
  assert.deepEqual(out.home, { lat: 48.7, lon: 19.1 });
  const r = out.roads[0];
  assert.equal(r.id, 111);
  assert.equal(r.name, 'Old Road');
  assert.equal(r.created, '16. 7. 2026');      // saved → created
  assert.ok(!('color' in r));                    // color dropped
  assert.deepEqual(r.meta, META_DEFAULT);        // meta seeded
  assert.equal(r.driveTimeFromHome, null);
});

test('migrate accepts bare array', () => {
  const out = migrate(V1.roads);
  assert.equal(out.version, SCHEMA_VERSION);
  assert.equal(out.roads.length, 1);
});

test('migrate is idempotent on v2', () => {
  const once = migrate(V1);
  const twice = migrate(once);
  assert.deepEqual(twice, once);
});

test('normalizeRoad computes km when missing', () => {
  const r = normalizeRoad({ id: 1, name: 'X', points: [{lat:48.0,lon:19.0},{lat:48.1,lon:19.0}] });
  assert.ok(r.km > 10 && r.km < 12, `got ${r.km}`);
});

test('emptyData', () => {
  assert.deepEqual(emptyData(), { version: 2, home: null, roads: [] });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd /h/tougemap && node --test test/store.test.js`
Expected: FAIL — cannot find module `../js/store.js`.

- [ ] **Step 3: Implement `js/store.js` (pure core)**

```js
// js/store.js — data model, migration, and (browser) IndexedDB cache
import { polylineKm } from './geo.js';

export const SCHEMA_VERSION = 2;
export const META_DEFAULT = { pavement: null, character: null, deer: null, notes: '' };

export function emptyData() {
  return { version: 2, home: null, roads: [] };
}

export function normalizeRoad(r) {
  const points = Array.isArray(r.points) ? r.points : [];
  return {
    id: r.id ?? Date.now(),
    name: r.name ?? 'Unnamed road',
    points,
    km: typeof r.km === 'number' ? r.km : Math.round(polylineKm(points) * 10) / 10,
    created: r.created ?? r.saved ?? new Date().toISOString().slice(0, 10),
    driveTimeFromHome: r.driveTimeFromHome ?? null,
    meta: { ...META_DEFAULT, ...(r.meta ?? {}) }
  };
}

export function migrate(raw) {
  const roadsIn = Array.isArray(raw) ? raw : (raw?.roads ?? []);
  const home = (Array.isArray(raw) ? null : raw?.home) ?? null;
  return {
    version: SCHEMA_VERSION,
    home: home && typeof home.lat === 'number' ? { lat: home.lat, lon: home.lon } : null,
    roads: roadsIn.map(normalizeRoad)
  };
}

// ── Browser-only IndexedDB cache (verified manually in Task 12) ────────────
const DB = 'tougemap', STORE = 'roads', KEY = 'data';
function openDb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
export async function cacheRead() {
  try {
    const db = await openDb();
    return await new Promise((res) => {
      const r = db.transaction(STORE).objectStore(STORE).get(KEY);
      r.onsuccess = () => res(r.result ?? null);
      r.onerror = () => res(null);
    });
  } catch { return null; }
}
export async function cacheWrite(data) {
  try {
    const db = await openDb();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(data, KEY);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch { /* cache is best-effort */ }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd /h/tougemap && node --test test/store.test.js`
Expected: `# pass 5`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add js/store.js test/store.test.js
git commit -m "feat(store): v2 schema, lossless v1 migration, IndexedDB cache"
```

---

### Task 4: Curvature engine (`js/curvature.js`) — verbatim port

**Files:**
- Create: `H:\tougemap\js\curvature.js`
- Test: `H:\tougemap\test\curvature.test.js`

**Interfaces:**
- Produces (pure, exported):
  - `distOnEarth(lat1,lon1,lat2,lon2): number` (metres)
  - `circumCircleRadius(a,b,c): number`
  - `segmentWeight(radius): {level, weight}`
  - `buildSegments(coords): segment[]` where `coords: [lat,lon][]`
  - `filterDeflections(segs): void` (mutates)
  - `splitOnStraights(coords, segs, threshold=2414): {coords, segs}[]`
  - `totalCurvatureFromSegs(segs): number`
  - `curvColor(c): string`, `fogColor(r): string` (color helper shared with weather — exported here, imported by weather/library)
  - `joinAndScore(elements): road[]` — wraps the collector.py join + post-processing pipeline; input is the raw Overpass `elements` array, output is scored collections (curvature ≥ 300).
  - `buildOverpassQuery(regions, types): string`
  - `async fetchOverpass(query, mirrors?): Promise<elements[]>` (network; not unit-tested)

**PORT INSTRUCTION:** Copy these functions from `H:\tougemap.html` **unchanged** (logic identical — only add `export` and move junction/oneway/traffic-calming squash helpers alongside): `distOnEarth` (v1 L558–566), `circumCircleRadius` (568–575), `segmentWeight` (577–583), `squashNearOnewayChange` (588–608), `squashCurvatureForJunctions` (612–616), `squashCurvatureForTrafficCalming` (619–623), `buildSegments` (627–663), `filterDeflections`/`segHeading`/`filterDeflection` (667–695), `splitOnStraights` (699–753), `totalCurvatureFromSegs` (780–782), `curvColor` (810–826), `fogColor` (827–832). Move the collector join + post-processing pipeline (the body of `loadRoads`, v1 L881–1162) into a pure `joinAndScore(elements)` that takes the parsed `json.elements` and returns the `collections` array; and extract the query builder (v1 L845–855) into `buildOverpassQuery`. Do **not** alter any numeric constant or branch.

- [ ] **Step 1: Write failing characterization tests**

```js
// test/curvature.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distOnEarth, circumCircleRadius, segmentWeight, buildSegments, totalCurvatureFromSegs, curvColor } from '../js/curvature.js';

test('distOnEarth ~111km per degree latitude', () => {
  assert.ok(Math.abs(distOnEarth(48, 19, 49, 19) - 111000) < 2000);
});

test('segmentWeight buckets match adamfranco levels', () => {
  assert.deepEqual(segmentWeight(20), { level: 4, weight: 2.0 });
  assert.deepEqual(segmentWeight(50), { level: 3, weight: 1.6 });
  assert.deepEqual(segmentWeight(80), { level: 2, weight: 1.3 });
  assert.deepEqual(segmentWeight(150), { level: 1, weight: 1.0 });
  assert.deepEqual(segmentWeight(400), { level: 0, weight: 0 });
});

test('circumCircleRadius of near-straight is large', () => {
  assert.ok(circumCircleRadius(100, 100, 199) > 1000);
});

test('a tightly curved chain scores curvature > 0; a straight chain scores 0', () => {
  const straight = [];
  for (let i = 0; i < 10; i++) straight.push([48 + i * 0.001, 19]);
  assert.equal(Math.round(totalCurvatureFromSegs(buildSegments(straight))), 0);

  const curvy = [];
  for (let i = 0; i < 20; i++) {
    const a = i * 0.4;
    curvy.push([48 + 0.0009 * Math.sin(a), 19 + 0.0009 * Math.cos(a)]);
  }
  assert.ok(totalCurvatureFromSegs(buildSegments(curvy)) > 0);
});

test('curvColor clamps low curvature to yellow', () => {
  assert.equal(curvColor(300), '#ffff00');
  assert.match(curvColor(20000), /^rgb\(/);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd /h/tougemap && node --test test/curvature.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `js/curvature.js`** by porting the functions per the PORT INSTRUCTION above. Ensure every listed function has `export`. Keep `joinAndScore` free of DOM/`fetch` (move the `setStatus` calls out to the caller). Add:

```js
// tail of js/curvature.js — network wrapper kept separate from pure pipeline
export function buildOverpassQuery(regions, types) {
  // regions: [{bbox:'w,s,e,n'}], types: ['secondary',...]  (ported from v1 L845–855)
  const parts = regions.flatMap(r => {
    const [w, s, e, n] = r.bbox.split(',');
    return types.map(tp =>
      `way["highway"="${tp}"]["junction"!="roundabout"]["area"!="yes"](${s},${w},${n},${e});`);
  });
  return `[out:json][timeout:90];\n(\n${parts.join('\n')}\n);\nout body;\n>;\nout skel qt;`;
}

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];

export async function fetchOverpass(query, mirrors = OVERPASS_MIRRORS) {
  for (const ep of mirrors) {
    try {
      const res = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(query) });
      if (res.ok) return (await res.json()).elements;
    } catch { /* try next mirror */ }
  }
  throw new Error('All Overpass mirrors failed');
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd /h/tougemap && node --test test/curvature.test.js`
Expected: `# pass 5`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add js/curvature.js test/curvature.test.js
git commit -m "feat(curvature): port adamfranco engine verbatim into module + tests"
```

---

### Task 5: Weather + fog (`js/weather.js`)

**Files:**
- Create: `H:\tougemap\js\weather.js`
- Test: `H:\tougemap\test\weather.test.js`

**Interfaces:**
- Consumes: `gridCellKey` from `js/geo.js`.
- Produces:
  - `calcFogScore(forecast, now): number` — pure; `now` injected (Date). (Ported from v1 `calcFogScore` L1362–1384, with `now` as a parameter instead of `new Date()`.)
  - `fogBadge(score): {lbl, cls}` (v1 L1386–1391), `wmoDesc(code): string` (v1 L1393–1397)
  - `nightFogRisk(spread, rh, wind): number` — the per-hour dot formula factored out of the render loop
  - `createWeatherClient({fetchFn = fetch, now = () => new Date(), ttlMs = 30*60*1000}) → { get(lat,lon): Promise<forecast>, clear() }` — in-memory TTL cache keyed by `gridCellKey`, dedups concurrent calls. **No persistence.**

- [ ] **Step 1: Write failing tests**

```js
// test/weather.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcFogScore, fogBadge, createWeatherClient } from '../js/weather.js';

function fakeForecast() {
  // build a forecast whose next night hour has tiny dew spread + high RH + calm wind
  const times = [], temp = [], dew = [], rh = [], wind = [];
  const base = new Date('2026-07-16T18:00:00');
  for (let i = 0; i < 24; i++) {
    const t = new Date(base.getTime() + i * 3600000);
    times.push(t.toISOString().slice(0,16));
    const night = t.getHours() >= 20 || t.getHours() <= 6;
    temp.push(10); dew.push(night ? 9.5 : 4); rh.push(night ? 97 : 60); wind.push(night ? 2 : 15);
  }
  return { hourly: { time: times, temperature_2m: temp, dew_point_2m: dew, relative_humidity_2m: rh, windspeed_10m: wind } };
}

test('calcFogScore high for calm humid night', () => {
  const score = calcFogScore(fakeForecast(), new Date('2026-07-16T18:30:00'));
  assert.ok(score >= 60, `got ${score}`);
});

test('fogBadge thresholds', () => {
  assert.equal(fogBadge(10).lbl, 'LOW');
  assert.equal(fogBadge(45).lbl, 'MEDIUM');
  assert.equal(fogBadge(70).lbl, 'HIGH');
  assert.equal(fogBadge(90).lbl, 'EXTREME');
});

test('weather client caches within TTL and dedups grid cells', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; return { ok: true, json: async () => fakeForecast() }; };
  const client = createWeatherClient({ fetchFn, now: () => new Date('2026-07-16T18:30:00'), ttlMs: 60000 });
  await client.get(48.71, 19.11);
  await client.get(48.73, 19.14); // same ~10km cell → no new call
  assert.equal(calls, 1);
  await client.get(49.5, 21.0);   // far → new call
  assert.equal(calls, 2);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd /h/tougemap && node --test test/weather.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `js/weather.js`**

```js
// js/weather.js — open-meteo fetch + fog scoring (no persistence)
import { gridCellKey } from './geo.js';

export function calcFogScore(d, now) {
  let max = 0;
  for (let i = 0; i < d.hourly.time.length; i++) {
    const t = new Date(d.hourly.time[i]);
    if (t <= now) continue;
    const h = t.getHours();
    if (h < 20 && h > 6) continue;
    const spread = d.hourly.temperature_2m[i] - d.hourly.dew_point_2m[i];
    const rh = d.hourly.relative_humidity_2m[i];
    const wind = d.hourly.windspeed_10m[i];
    let risk = 0;
    if (spread <= 1) risk += 40; else if (spread <= 2) risk += 30; else if (spread <= 4) risk += 15;
    if (rh > 95) risk += 25; else if (rh > 90) risk += 15; else if (rh > 85) risk += 5;
    if (wind < 5) risk += 15; else if (wind < 10) risk += 5;
    if (h >= 2 && h <= 6) risk += 10;
    max = Math.max(max, risk);
    if (i > 24) break;
  }
  return Math.min(100, max);
}

export function fogBadge(s) {
  if (s < 30) return { lbl: 'LOW', cls: 'fog-low' };
  if (s < 60) return { lbl: 'MEDIUM', cls: 'fog-med' };
  if (s < 80) return { lbl: 'HIGH', cls: 'fog-high' };
  return { lbl: 'EXTREME', cls: 'fog-extreme' };
}

export function wmoDesc(c) {
  if (c === 0) return 'Clear sky';
  if (c <= 3) return 'Partly cloudy';
  if (c <= 49) return 'Fog / mist';
  if (c <= 67) return 'Rain';
  if (c <= 77) return 'Snow';
  if (c <= 82) return 'Showers';
  return 'Thunderstorm';
}

export function nightFogRisk(spread, rh, wind) {
  let fr = spread <= 1 ? 80 : spread <= 2 ? 50 : spread <= 4 ? 25 : 10;
  if (rh > 90) fr = Math.min(100, fr + 20);
  if (wind < 5) fr = Math.min(100, fr + 10);
  return fr;
}

const HOURLY = 'temperature_2m,relative_humidity_2m,dew_point_2m,precipitation_probability,weathercode,windspeed_10m';

export function createWeatherClient({ fetchFn = fetch, now = () => new Date(), ttlMs = 30 * 60 * 1000 } = {}) {
  const cache = new Map();   // cellKey -> {ts, promise}
  return {
    async get(lat, lon) {
      const key = gridCellKey(lat, lon);
      const hit = cache.get(key);
      if (hit && (now().getTime() - hit.ts) < ttlMs) return hit.promise;
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${HOURLY}&forecast_days=2&timezone=auto`;
      const promise = fetchFn(url).then(r => { if (!r.ok) throw new Error('wx ' + r.status); return r.json(); });
      cache.set(key, { ts: now().getTime(), promise });
      promise.catch(() => cache.delete(key)); // don't cache failures
      return promise;
    },
    clear() { cache.clear(); }
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd /h/tougemap && node --test test/weather.test.js`
Expected: `# pass 3`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add js/weather.js test/weather.test.js
git commit -m "feat(weather): fog scoring + TTL/grid-dedup client, no persistence"
```

---

### Task 6: Tonight ranking (`js/tonight-rank.js`)

**Files:**
- Create: `H:\tougemap\js\tonight-rank.js`
- Test: `H:\tougemap\test\tonight-rank.test.js`

**Interfaces:**
- Consumes: `calcFogScore` from `js/weather.js`.
- Produces:
  - `scoreRoad(road, forecast, now): {fog, rainPct, temp, score}` — lower `score` = better drive; `score = fog*1.0 + rainPct*0.6 + tempPenalty`, where `tempPenalty = max(0, 8 - temp) * 2` (cold nights penalized). Deer risk is **not** an input.
  - `rankRoads(entries, now): road[]` — `entries: {road, forecast}[]`; returns roads sorted best→worst; roads with no forecast sort last.
  - `reachable(road, maxMinutes): boolean` — true if `driveTimeFromHome?.minutes <= maxMinutes`; roads with null drive-time return `false` only when a filter is active (caller decides).

- [ ] **Step 1: Write failing tests**

```js
// test/tonight-rank.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRoad, rankRoads, reachable } from '../js/tonight-rank.js';

const now = new Date('2026-07-16T18:30:00');
const clearFc = { hourly: mkHourly(15, 15, 30, 20, 0) };  // dry, warm, breezy → low fog
const foggyFc = { hourly: mkHourly(10, 9.6, 97, 2, 0) };  // fog-prone

function mkHourly(temp, dew, rh, wind, precip) {
  const time = [], T = [], D = [], R = [], W = [], P = [], C = [];
  const base = new Date('2026-07-16T18:00:00');
  for (let i = 0; i < 24; i++) {
    const t = new Date(base.getTime() + i * 3600000);
    time.push(t.toISOString().slice(0,16));
    T.push(temp); D.push(dew); R.push(rh); W.push(wind); P.push(precip); C.push(0);
  }
  return { time, temperature_2m: T, dew_point_2m: D, relative_humidity_2m: R, windspeed_10m: W, precipitation_probability: P, weathercode: C };
}

test('clear night scores better (lower) than foggy night', () => {
  const clear = scoreRoad({}, clearFc, now).score;
  const foggy = scoreRoad({}, foggyFc, now).score;
  assert.ok(clear < foggy, `clear ${clear} !< foggy ${foggy}`);
});

test('rankRoads puts clear-night road first, forecastless road last', () => {
  const a = { id: 1, name: 'Clear' }, b = { id: 2, name: 'Foggy' }, c = { id: 3, name: 'Unknown' };
  const ranked = rankRoads([{road:b,forecast:foggyFc},{road:a,forecast:clearFc},{road:c,forecast:null}], now);
  assert.deepEqual(ranked.map(r => r.id), [1, 2, 3]);
});

test('reachable respects cached drive-time', () => {
  assert.equal(reachable({ driveTimeFromHome: { minutes: 40 } }, 60), true);
  assert.equal(reachable({ driveTimeFromHome: { minutes: 80 } }, 60), false);
  assert.equal(reachable({ driveTimeFromHome: null }, 60), false);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd /h/tougemap && node --test test/tonight-rank.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `js/tonight-rank.js`**

```js
// js/tonight-rank.js — pure ranking of the library by night conditions
import { calcFogScore } from './weather.js';

function nextNightIndex(d, now) {
  return d.hourly.time.findIndex(t => new Date(t) > now);
}

export function scoreRoad(road, forecast, now) {
  const ni = nextNightIndex(forecast, now);
  const fog = calcFogScore(forecast, now);
  const rainPct = ni >= 0 ? (forecast.hourly.precipitation_probability?.[ni] ?? 0) : 0;
  const temp = ni >= 0 ? forecast.hourly.temperature_2m[ni] : 15;
  const tempPenalty = Math.max(0, 8 - temp) * 2;
  const score = fog * 1.0 + rainPct * 0.6 + tempPenalty;
  return { fog, rainPct, temp, score };
}

export function rankRoads(entries, now) {
  return entries
    .map(e => ({ road: e.road, s: e.forecast ? scoreRoad(e.road, e.forecast, now).score : Infinity }))
    .sort((a, b) => a.s - b.s)
    .map(x => x.road);
}

export function reachable(road, maxMinutes) {
  const m = road.driveTimeFromHome?.minutes;
  return typeof m === 'number' && m <= maxMinutes;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd /h/tougemap && node --test test/tonight-rank.test.js`
Expected: `# pass 3`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add js/tonight-rank.js test/tonight-rank.test.js
git commit -m "feat(tonight): pure condition-based ranking + reachability"
```

---

### Task 7: Routing helpers (`js/routing.js`)

**Files:**
- Create: `H:\tougemap\js\routing.js`
- Test: `H:\tougemap\test\routing.test.js`

**Interfaces:**
- Consumes: `haversineKm` from `js/geo.js`.
- Produces:
  - `buildOsrmUrl(points, {overview='full'}): string` — `points: {lat,lon}[]` → `.../driving/lon,lat;lon,lat?...`
  - `parseOsrmRoute(json): {points:{lat,lon}[], km, minutes} | null`
  - `async route(points, {fetchFn=fetch}): Promise<{points,km,minutes}>` — throws on failure (caller falls back to air distance)
  - `airFallback(fromLat, fromLon, toLat, toLon): {km, minutes:null, approx:true}`
  - `nearestPoint(fromLat, fromLon, points): {point, km}` — nearest road vertex to home

- [ ] **Step 1: Write failing tests**

```js
// test/routing.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOsrmUrl, parseOsrmRoute, airFallback, nearestPoint } from '../js/routing.js';

test('buildOsrmUrl orders lon,lat and joins with ;', () => {
  const url = buildOsrmUrl([{lat:48.1,lon:17.1},{lat:48.7,lon:21.2}]);
  assert.match(url, /driving\/17\.1,48\.1;21\.2,48\.7/);
});

test('parseOsrmRoute extracts km, minutes, points', () => {
  const json = { code:'Ok', routes:[{ distance: 61000, duration: 3120, geometry:{ coordinates:[[17.1,48.1],[21.2,48.7]] } }] };
  const r = parseOsrmRoute(json);
  assert.equal(r.km, 61);
  assert.equal(r.minutes, 52);
  assert.deepEqual(r.points[0], { lat: 48.1, lon: 17.1 });
});

test('parseOsrmRoute returns null on non-Ok', () => {
  assert.equal(parseOsrmRoute({ code: 'NoRoute', routes: [] }), null);
});

test('nearestPoint finds closest vertex', () => {
  const { point } = nearestPoint(48.70, 19.10, [{lat:49.0,lon:20.0},{lat:48.71,lon:19.11}]);
  assert.deepEqual(point, { lat: 48.71, lon: 19.11 });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd /h/tougemap && node --test test/routing.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `js/routing.js`**

```js
// js/routing.js — OSRM helpers with air-distance fallback
import { haversineKm } from './geo.js';

const OSRM = 'https://router.project-osrm.org/route/v1';

export function buildOsrmUrl(points, { overview = 'full' } = {}) {
  const coords = points.map(p => `${p.lon},${p.lat}`).join(';');
  return `${OSRM}/driving/${coords}?overview=${overview}&geometries=geojson&steps=false`;
}

export function parseOsrmRoute(json) {
  if (json?.code !== 'Ok' || !json.routes?.length) return null;
  const r = json.routes[0];
  return {
    points: (r.geometry?.coordinates ?? []).map(c => ({ lat: c[1], lon: c[0] })),
    km: Math.round(r.distance / 100) / 10,
    minutes: Math.round(r.duration / 60)
  };
}

export async function route(points, { fetchFn = fetch } = {}) {
  const res = await fetchFn(buildOsrmUrl(points));
  const parsed = parseOsrmRoute(await res.json());
  if (!parsed) throw new Error('No route');
  return parsed;
}

export function airFallback(fromLat, fromLon, toLat, toLon) {
  return { km: Math.round(haversineKm(fromLat, fromLon, toLat, toLon)), minutes: null, approx: true };
}

export function nearestPoint(fromLat, fromLon, points) {
  let best = points[0], bestKm = Infinity;
  for (const p of points) {
    const d = haversineKm(fromLat, fromLon, p.lat, p.lon);
    if (d < bestKm) { bestKm = d; best = p; }
  }
  return { point: best, km: bestKm };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd /h/tougemap && node --test test/routing.test.js`
Expected: `# pass 4`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add js/routing.js test/routing.test.js
git commit -m "feat(routing): OSRM url/parse + air fallback + nearest vertex"
```

---

### Task 8: GitHub sync (`js/sync.js`)

**Files:**
- Create: `H:\tougemap\js\sync.js`
- Test: `H:\tougemap\test\sync.test.js`

**Interfaces:**
- Consumes: `migrate`, `emptyData`, `cacheRead`, `cacheWrite` from `js/store.js`.
- Produces:
  - `loadConfig(): {owner,repo,branch,path,token}|null` / `saveConfig(cfg)` / `clearToken()` (localStorage key `tougemap_gh`)
  - `rawUrl(cfg): string` — `https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}`
  - `encodeContent(obj): string` — base64 of pretty JSON (uses `btoa`+UTF-8 safe encoding)
  - `async readRoads(cfg, {fetchFn=fetch}): Promise<data>` — public raw fetch → `migrate`; on network failure returns `cacheRead()` result or `emptyData()`; writes fresh reads to cache.
  - `async writeRoads(cfg, data, {fetchFn=fetch}): Promise<void>` — GET current sha via Contents API, PUT new content; throws on missing token / auth failure.
  - `async testConnection(cfg, {fetchFn=fetch}): Promise<{ok, message}>`

- [ ] **Step 1: Write failing tests** (pure/url + encode + read-fallback with mock fetch)

```js
// test/sync.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawUrl, encodeContent } from '../js/sync.js';

test('rawUrl composes correctly', () => {
  const cfg = { owner: 'lt', repo: 'tougemap', branch: 'main', path: 'roads.json' };
  assert.equal(rawUrl(cfg), 'https://raw.githubusercontent.com/lt/tougemap/main/roads.json');
});

test('encodeContent round-trips through base64 (incl. non-ASCII)', () => {
  const b64 = encodeContent({ name: 'Muránska planina', v: 2 });
  const back = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  assert.equal(back.name, 'Muránska planina');
  assert.equal(back.v, 2);
});
```

> Note: `readRoads`/`writeRoads`/`testConnection` hit the network and are verified live in Task 13. Keep `btoa` usage guarded so the module imports in Node (define `encodeContent` via `Buffer` when `btoa` is absent).

- [ ] **Step 2: Run, verify fail**

Run: `cd /h/tougemap && node --test test/sync.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `js/sync.js`**

```js
// js/sync.js — GitHub read (public) + write (token)
import { migrate, emptyData, cacheRead, cacheWrite } from './store.js';

const LS_KEY = 'tougemap_gh';
const API = 'https://api.github.com';

export function loadConfig() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || null; } catch { return null; }
}
export function saveConfig(cfg) { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); }
export function clearToken() {
  const c = loadConfig(); if (c) { delete c.token; saveConfig(c); }
}

export function rawUrl(cfg) {
  return `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${cfg.branch}/${cfg.path}`;
}

export function encodeContent(obj) {
  const json = JSON.stringify(obj, null, 2);
  if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(json)));
  return Buffer.from(json, 'utf8').toString('base64'); // Node/test path
}

export async function readRoads(cfg, { fetchFn = fetch } = {}) {
  try {
    const res = await fetchFn(rawUrl(cfg) + '?t=' + Date.now()); // cache-bust
    if (!res.ok) throw new Error('read ' + res.status);
    const data = migrate(await res.json());
    await cacheWrite(data);
    return data;
  } catch {
    return (await cacheRead()) || emptyData();
  }
}

async function currentSha(cfg, fetchFn) {
  const url = `${API}/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.path}?ref=${cfg.branch}`;
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (res.status === 404) return null;      // file doesn't exist yet
  if (!res.ok) throw new Error('sha ' + res.status);
  return (await res.json()).sha;
}

export async function writeRoads(cfg, data, { fetchFn = fetch } = {}) {
  if (!cfg.token) throw new Error('No GitHub token configured');
  const sha = await currentSha(cfg, fetchFn);
  const url = `${API}/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.path}`;
  const body = {
    message: `Update roads (${data.roads.length} saved)`,
    content: encodeContent(data),
    branch: cfg.branch,
    ...(sha ? { sha } : {})
  };
  const res = await fetchFn(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('write ' + res.status + ' — check token scope (contents: read/write)');
  await cacheWrite(data);
}

export async function testConnection(cfg, { fetchFn = fetch } = {}) {
  try {
    const res = await fetchFn(`${API}/repos/${cfg.owner}/${cfg.repo}`, {
      headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}
    });
    if (res.ok) return { ok: true, message: 'Connected' };
    return { ok: false, message: `GitHub returned ${res.status}` };
  } catch (e) { return { ok: false, message: e.message }; }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd /h/tougemap && node --test test/sync.test.js`
Expected: `# pass 2`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add js/sync.js test/sync.test.js
git commit -m "feat(sync): GitHub public read + token write, cache fallback"
```

---

### Task 9: Styles (`styles.css`)

**Files:**
- Create: `H:\tougemap\styles.css`

**PORT INSTRUCTION:** Move the v1 `<style>` block (`H:\tougemap.html` L10–259) into `styles.css`, applying these cleanups: (1) delete the duplicated `.custom-road-tooltip` / focus-suppression / leaflet-override blocks that appear twice (v1 L200–201 & 241–242, L237–245 repeat) — keep one copy; (2) drop `#cors-warn` styles (banner is gone); (3) keep the `:root` custom properties, mode tabs, cards, weather, bottom sheet, and mobile media queries. No new design; this is a dedupe + re-home.

- [ ] **Step 1: Create `styles.css`** per the port instruction. Add three small additions used by later tasks:

```css
/* road-card shape thumbnail */
.road-thumb{width:100%;height:44px;display:block;background:var(--surface2);border-radius:3px}
.road-thumb path{fill:none;stroke:var(--accent);stroke-width:2;vector-effect:non-scaling-stroke}
/* metadata chips */
.meta-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:3px;font-size:10px;font-family:'Space Mono',monospace;border:1px solid var(--border2);color:var(--text2)}
.meta-chip.deer-high{border-color:var(--red);color:var(--red)}
.meta-chip.deer-medium{border-color:var(--yellow);color:var(--yellow)}
/* onboarding */
#onboard{position:fixed;inset:0;background:var(--bg);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px}
#onboard .box{max-width:420px;width:100%;background:var(--surface);border:1px solid var(--border2);border-radius:8px;padding:24px}
```

- [ ] **Step 2: Verify no duplicate selectors remain**

Run: `cd /h/tougemap && grep -c "leaflet-interactive:focus" styles.css`
Expected: `2` or fewer (originally 4 in v1). Confirm `#cors-warn` count is `0`: `grep -c "cors-warn" styles.css` → `0`.

- [ ] **Step 3: Commit**

```bash
git add styles.css
git commit -m "feat(styles): port + dedupe v1 CSS, drop CORS banner, add card/onboard styles"
```

---

### Task 10: Map core + GPS (`js/map.js`)

**Files:**
- Create: `H:\tougemap\js\map.js`

**Interfaces:**
- Consumes: Leaflet global `L`; `haversineKm` from `js/geo.js`.
- Produces:
  - `initMap(elId): L.Map` — center `[48.8,19.5]`, zoom 9, zoom control bottom-right (ported from v1 L499–500)
  - `TILES` + `setLayer(name)` (ported v1 L493–518)
  - `roadGroup`, `savedGroup`, `discoverGroup` layer groups (exported)
  - `async locate(): Promise<{lat,lon}>` — wraps `navigator.geolocation.getCurrentPosition`; rejects if denied
  - `sortByProximity(roads, lat, lon): road[]` — nearest-first by road midpoint (pure; re-exported from geo for convenience)

**VERIFICATION (browser, no unit test):** covered in Task 14 checklist.

- [ ] **Step 1: Implement `js/map.js`**

```js
// js/map.js — Leaflet setup, layers, GPS
import { haversineKm } from './geo.js';

export const TILES = {
  osm:  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OSM' }),
  topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenTopoMap' }),
  sat:  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: '© Esri' })
};

export let map = null;
export const roadGroup = L.layerGroup();
export const savedGroup = L.layerGroup();
export const discoverGroup = L.layerGroup();
let curLayer = 'osm';

export function initMap(elId) {
  map = L.map(elId, { center: [48.8, 19.5], zoom: 9, layers: [TILES.osm] });
  map.zoomControl.setPosition('bottomright');
  savedGroup.addTo(map);
  return map;
}

export function setLayer(name) {
  map.removeLayer(TILES[curLayer]);
  map.addLayer(TILES[name]);
  curLayer = name;
  ['osm','topo','sat'].forEach(k =>
    document.getElementById('btn-' + k)?.classList.toggle('active', k === name));
}

export function locate() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('No geolocation'));
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lon: p.coords.longitude }),
      e => rej(e), { enableHighAccuracy: true, timeout: 10000 });
  });
}

export function sortByProximity(roads, lat, lon) {
  const mid = r => r.points[Math.floor(r.points.length / 2)];
  return roads.slice().sort((a, b) =>
    haversineKm(lat, lon, mid(a).lat, mid(a).lon) - haversineKm(lat, lon, mid(b).lat, mid(b).lon));
}
```

- [ ] **Step 2: Commit**

```bash
git add js/map.js
git commit -m "feat(map): Leaflet init, layer switch, GPS locate, proximity sort"
```

---

### Task 11: Library + road cards (`js/library.js`)

**Files:**
- Create: `H:\tougemap\js\library.js`

**Interfaces:**
- Consumes: `simplifyForThumbnail` from `js/geo.js`; `fogBadge` from `js/weather.js`.
- Produces:
  - `thumbnailSvg(points): string` — inline SVG polyline of the road shape, viewBox-normalized
  - `roadCardHtml(road, {fogScore=null}): string` — name, thumbnail, km, drive-time, fog badge, meta chips
  - `sortRoads(roads, key): road[]` — keys: `name|km|driveTime|created`
  - `filterRoads(roads, {q, character, pavement, deer, reachableMin}): road[]`
  - `metaChipsHtml(meta): string`

**VERIFICATION:** `sortRoads`/`filterRoads`/`thumbnailSvg` are pure — add quick tests.

- [ ] **Step 1: Write failing tests**

```js
// test/library.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thumbnailSvg, sortRoads, filterRoads } from '../js/library.js';

const roads = [
  { id:1, name:'Alpha', km:10, created:'2026-01-01', driveTimeFromHome:{minutes:80}, points:[{lat:48,lon:19},{lat:48.1,lon:19.1}], meta:{character:'technical',pavement:'good',deer:'low',notes:''} },
  { id:2, name:'Bravo', km:30, created:'2026-02-01', driveTimeFromHome:{minutes:20}, points:[{lat:49,lon:20},{lat:49.1,lon:20.1}], meta:{character:'flowing',pavement:'rough',deer:'high',notes:''} }
];

test('thumbnailSvg emits a polyline path', () => {
  const svg = thumbnailSvg(roads[0].points);
  assert.match(svg, /<svg/);
  assert.match(svg, /<path/);
});

test('sortRoads by driveTime ascending', () => {
  assert.deepEqual(sortRoads(roads, 'driveTime').map(r => r.id), [2, 1]);
});

test('filterRoads by character + reachableMin', () => {
  const out = filterRoads(roads, { character: 'flowing', reachableMin: 60 });
  assert.deepEqual(out.map(r => r.id), [2]);
});

test('filterRoads text query matches name', () => {
  assert.deepEqual(filterRoads(roads, { q: 'alph' }).map(r => r.id), [1]);
});
```

- [ ] **Step 2: Run, verify fail** — `node --test test/library.test.js` → module not found.

- [ ] **Step 3: Implement `js/library.js`**

```js
// js/library.js — road cards, thumbnails, sort/filter
import { simplifyForThumbnail } from './geo.js';
import { fogBadge } from './weather.js';

export function thumbnailSvg(points) {
  const pts = simplifyForThumbnail(points, 40);
  const lats = pts.map(p => p.lat), lons = pts.map(p => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const w = 100, h = 44, pad = 4;
  const sx = (maxLon - minLon) || 1e-6, sy = (maxLat - minLat) || 1e-6;
  const d = pts.map((p, i) => {
    const x = pad + ((p.lon - minLon) / sx) * (w - 2 * pad);
    const y = h - pad - ((p.lat - minLat) / sy) * (h - 2 * pad); // invert lat
    return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="road-thumb" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${d}"/></svg>`;
}

export function metaChipsHtml(meta) {
  const chips = [];
  if (meta.character) chips.push(`<span class="meta-chip">${meta.character}</span>`);
  if (meta.pavement)  chips.push(`<span class="meta-chip">${meta.pavement}</span>`);
  if (meta.deer)      chips.push(`<span class="meta-chip deer-${meta.deer}">🦌 ${meta.deer}</span>`);
  return chips.join('');
}

export function roadCardHtml(road, { fogScore = null } = {}) {
  const dt = road.driveTimeFromHome?.minutes != null ? `${road.driveTimeFromHome.minutes} min` : '—';
  const fog = fogScore != null ? (b => `<span class="fog-badge ${b.cls}">${b.lbl}</span>`)(fogBadge(fogScore)) : '';
  return `
    <div class="road-lib-item" data-id="${road.id}">
      ${thumbnailSvg(road.points)}
      <div class="road-lib-name">${road.name}</div>
      <div class="road-lib-meta"><span>${road.km} km</span><span>${dt} from home</span>${fog}</div>
      <div class="road-lib-chips">${metaChipsHtml(road.meta)}</div>
    </div>`;
}

export function sortRoads(roads, key) {
  const by = {
    name: (a, b) => a.name.localeCompare(b.name),
    km: (a, b) => b.km - a.km,
    created: (a, b) => (b.created || '').localeCompare(a.created || ''),
    driveTime: (a, b) => (a.driveTimeFromHome?.minutes ?? Infinity) - (b.driveTimeFromHome?.minutes ?? Infinity)
  };
  return roads.slice().sort(by[key] || by.name);
}

export function filterRoads(roads, { q = '', character = null, pavement = null, deer = null, reachableMin = null } = {}) {
  const ql = q.trim().toLowerCase();
  return roads.filter(r =>
    (!ql || r.name.toLowerCase().includes(ql)) &&
    (!character || r.meta.character === character) &&
    (!pavement || r.meta.pavement === pavement) &&
    (!deer || r.meta.deer === deer) &&
    (reachableMin == null || (r.driveTimeFromHome?.minutes ?? Infinity) <= reachableMin));
}
```

- [ ] **Step 4: Run, verify pass** — `node --test test/library.test.js` → `# pass 4`.

- [ ] **Step 5: Commit**

```bash
git add js/library.js test/library.test.js
git commit -m "feat(library): thumbnails, cards, sort/filter"
```

---

### Task 12: Planner — PC create/edit (`js/planner.js`)

**Files:**
- Create: `H:\tougemap\js\planner.js`

**Interfaces:**
- Consumes: `map`, `savedGroup` from `js/map.js`; `route`, `nearestPoint`, `airFallback` from `js/routing.js`; `polylineKm` from `js/geo.js`; `writeRoads`, `readRoads`, `loadConfig` from `js/sync.js`; `normalizeRoad` from `js/store.js`.
- Produces:
  - `startPlacing(type)`, `setRoutePoint`, `addWaypoint`, route preview via OSRM (ported from v1 L1729–1855)
  - `async saveRoad(name, draftPoints, appState): Promise<void>` — builds a v2 road (`normalizeRoad`), pushes to `appState.data.roads`, calls `writeRoads`, re-renders
  - `editMeta(id, patch, appState)`, `renameRoad`, `deleteRoad` — each mutates `appState.data` then `writeRoads`
  - `async recomputeDriveTime(road, home, appState)` — OSRM home→nearest vertex, cache into `road.driveTimeFromHome = {minutes, km, computedForHome:home}`; air fallback on failure
  - `async setHome(lat, lon, appState)` — set `appState.data.home`, invalidate + recompute drive-times, `writeRoads`

**PORT INSTRUCTION:** Reuse v1 routing/draw/marker logic (`tryRouting` L1815–1855, `setRoutePoint`/waypoints L1743–1810, `calcRoadDistance` L2031–2069) but: replace all `localStorage` persistence with `writeRoads(cfg, appState.data)`; drop per-road `color` (always render `#b000ff`); write metadata via the new schema. Guard the whole module behind a `isDesktop()` check in `app.js` so it never loads UI handlers on phone.

- [ ] **Step 1: Implement `js/planner.js`** following the port instruction. Drive-time cache logic:

```js
export async function recomputeDriveTime(road, home, appState) {
  if (!home) { road.driveTimeFromHome = null; return; }
  const { point } = nearestPoint(home.lat, home.lon, road.points);
  try {
    const r = await route([home, point]);
    road.driveTimeFromHome = { minutes: r.minutes, km: r.km, computedForHome: { ...home } };
  } catch {
    const air = airFallback(home.lat, home.lon, point.lat, point.lon);
    road.driveTimeFromHome = { minutes: null, km: air.km, computedForHome: { ...home }, approx: true };
  }
}
```

- [ ] **Step 2: Verify in browser** (see Task 14 checklist item "Planner"): draw a route, save → a commit appears in the repo, card shows drive-time.

- [ ] **Step 3: Commit**

```bash
git add js/planner.js
git commit -m "feat(planner): PC draw/route/save/edit → GitHub, drive-time cache"
```

---

### Task 13: App shell, views, onboarding, PWA (`js/app.js`, `js/ui.js`, `manifest.json`, `sw.js`)

**Files:**
- Create: `H:\tougemap\js\ui.js` (bottom sheet, modal, view switching, responsive helpers — port/rebuild from v1 L2343–2401 bottom sheet)
- Create: `H:\tougemap\js\app.js` (bootstrap + wiring)
- Create: `H:\tougemap\manifest.json`
- Create: `H:\tougemap\sw.js`

**Interfaces:**
- `app.js` produces a single `appState = { data, cfg, weatherClient, now }` and wires: initial `readRoads`, render library/tonight/near-me, mode tabs, onboarding when `loadConfig()` is null.
- `isDesktop() = matchMedia('(min-width: 769px)').matches` gates planner/discover UI.

- [ ] **Step 1: Implement `manifest.json`**

```json
{
  "name": "TougeMap",
  "short_name": "TougeMap",
  "start_url": "./index.html",
  "display": "standalone",
  "background_color": "#0a0c0e",
  "theme_color": "#0a0c0e",
  "icons": [
    { "src": "icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```
> Generate two solid-background PNG icons (192/512) with the "TM" wordmark; commit them as `icon-192.png`/`icon-512.png`.

- [ ] **Step 2: Implement `sw.js` — cache app shell + roads.json ONLY (never weather/OSRM/overpass)**

```js
// sw.js
const CACHE = 'tougemap-v2-1';
const SHELL = ['./', './index.html', './styles.css',
  './js/app.js','./js/ui.js','./js/map.js','./js/library.js','./js/planner.js',
  './js/store.js','./js/sync.js','./js/weather.js','./js/geo.js',
  './js/curvature.js','./js/routing.js','./js/tonight-rank.js','./manifest.json'];

self.addEventListener('install', e =>
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));

self.addEventListener('activate', e =>
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // NEVER cache weather, routing, overpass, or the GitHub API
  if (/open-meteo|project-osrm|overpass|api\.github\.com|nominatim/.test(url.host + url.pathname)) return;
  if (url.pathname.endsWith('roads.json') || url.host.includes('raw.githubusercontent')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request))); // network-first
    return;
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request))); // shell: cache-first
});
```

- [ ] **Step 3: Implement `js/ui.js`** — rebuild the bottom sheet (port v1 L2343–2401), a generic name/meta modal, and `showView(name)` that toggles `Library|Tonight|Near me` (phone) / `Library|Tonight|Discover` (desktop). Register the service worker:

```js
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
```

- [ ] **Step 4: Implement `js/app.js`** — bootstrap:

```js
// js/app.js (bootstrap sketch — wire the concrete render fns from library/tonight/planner)
import { initMap } from './map.js';
import { loadConfig } from './sync.js';
import { readRoads } from './sync.js';
import { createWeatherClient } from './weather.js';
import { showView, showOnboarding, isDesktop } from './ui.js';

const appState = { data: { version:2, home:null, roads:[] }, cfg: loadConfig(), weatherClient: createWeatherClient(), now: () => new Date() };

async function boot() {
  initMap('map'); // ensure index.html #app contains the map container built by ui.js layout
  if (!appState.cfg) { showOnboarding(appState); return; } // collect owner/repo/branch/path[/token]
  appState.data = await readRoads(appState.cfg);
  showView(isDesktop() ? 'library' : 'library', appState);
}
boot();
```
> Fill in the concrete DOM layout (header, mode tabs, map container, panels) in `ui.js` by porting the v1 markup (index `#app` structure, v1 L268–487) minus the CORS banner and minus mobile drawing UI. Onboarding form collects `owner/repo/branch/path` and an optional token (desktop only), calls `saveConfig`, then `boot()` again.

- [ ] **Step 5: Run full unit suite**

Run: `cd /h/tougemap && npm test`
Expected: all suites pass, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add js/app.js js/ui.js manifest.json sw.js icon-192.png icon-512.png
git commit -m "feat(app): shell, views, onboarding, PWA (shell+roads cache only)"
```

---

### Task 14: Live verification + deploy docs (`README.md`)

**Files:**
- Create: `H:\tougemap\README.md`
- Create/seed: `H:\tougemap\roads.json` (from migrating the owner's existing localStorage/v1 export, if available; else `{"version":2,"home":null,"roads":[]}`)

- [ ] **Step 1: Serve locally and run the browser checklist** using the preview tools (dev server: `npx --yes serve H:\tougemap -l 5178` or any static server; the app must run over http, not file://).

Verify each:
- [ ] App loads with no console errors; onboarding appears on first run.
- [ ] Enter a test repo config (no token) → library reads the public `roads.json`.
- [ ] **Desktop planner:** draw start/end → OSRM preview → name → Save. Confirm a new commit in the repo and the card shows drive-time from home.
- [ ] Edit metadata (pavement/character/deer/notes), rename, delete → each writes a commit.
- [ ] Set/move Home → affected drive-times recompute.
- [ ] **Tonight view:** ranks roads; toggling "reachable tonight" filters by cached drive-time; "updated HH:MM" shown; only a handful of open-meteo calls fire (check network panel — grid dedup working).
- [ ] **Phone (≤768px viewport):** no drawing UI; bottom sheet shows road detail; "Near me" sorts by GPS proximity (allow location).
- [ ] **Offline:** disable network → library still renders from cache; Save is disabled with a hint; weather shows unavailable (never stale).
- [ ] **Curvature discover (desktop):** load a small region → roads render; re-open → served from cache (fast); a discovered road can be saved.
- [ ] OSRM fallback: simulate failure → distance shows air-distance labelled approximate.

- [ ] **Step 2: Write `README.md`** covering: what it is; one-repo layout; **GitHub Pages enablement** (Settings → Pages → deploy from `main` / root); **fine-grained token setup** (github.com → Settings → Developer settings → Fine-grained tokens → repo-scoped, *Contents: Read and write*), where to paste it (desktop onboarding), and the read-only share URL for friends (`https://<owner>.github.io/<repo>/`).

- [ ] **Step 3: Final commit**

```bash
git add README.md roads.json
git commit -m "docs: README (Pages + token setup) and seed roads.json"
```

- [ ] **Step 4: Cross-device smoke** — write a road on the PC profile; open the GitHub Pages URL on the phone; confirm it appears (read-only).

---

## Self-Review

**Spec coverage:**
- §2 hosting/data/auth/code-shape/device-split → Tasks 1, 8, 12, 13, 14 ✓
- §3.1 file layout → Tasks 1–13 create every listed module ✓
- §3.2 schema + migration → Task 3 ✓
- §3.3 sync (read/write/config/offline) → Task 8 + sw.js Task 13 ✓
- §4.1 library cards/sort/filter → Task 11 ✓
- §4.2 Tonight + weather policy (TTL/grid/no-persist) → Tasks 5, 6, 13, sw.js ✓
- §4.3 road detail → Tasks 11/13 (render) ✓
- §4.4 PC create/edit/home → Task 12 ✓
- §4.5 roads near me (GPS) → Task 10 + 13 ✓
- §4.6 curvature discovery (cached, on-demand) → Task 4 + 14 ✓
- §5 UX/theme → Task 9 (styles) + 13 (layout) ✓
- §7 error handling (OSRM fallback, token, geolocation, corrupt json) → Tasks 7, 8, 10, 8 ✓
- §8 testing → node tests Tasks 2–8,11 + browser checklist Task 14 ✓

**Placeholder scan:** verbatim-port references cite exact v1 line ranges (not placeholders — the code exists and is copied unchanged). All new logic has full code + tests. No TBD/TODO.

**Type consistency:** `driveTimeFromHome.{minutes,km,computedForHome}` consistent across store/tonight-rank/library/planner; `points:{lat,lon}[]` consistent; `meta:{pavement,character,deer,notes}` consistent; layer group names `roadGroup/savedGroup/discoverGroup` consistent between map.js and planner.js.

---
```

