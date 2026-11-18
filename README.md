# TougeMap

A personal, cross-device map of driving ("touge") roads. Save your favourite
roads, see their length, distance from home, and tonight's fog / temperature /
rain, and rank the whole library by how good a drive it'll be *tonight*.
Curvature discovery (finding new twisty roads from OpenStreetMap) is a secondary
tool.

- No build step, no server, no framework. Plain static files + Leaflet, hosted on
  GitHub Pages.
- Your roads live in **`roads.json` in this repo, encrypted** with a passphrase
  (AES-256-GCM, key from PBKDF2). The repo is public, so without the passphrase
  the file is just ciphertext — nobody can clone it or open the site and see your
  roads or your home point.
- **Viewing** needs only the passphrase. **Editing** (draw / save / rename /
  delete / set home) also needs a GitHub token, and only works on a desktop-size
  screen.

## How it works

- Opening the app on a new device asks for the passphrase once; it's remembered
  in that browser's `localStorage`. **🔑 → Forget this device** removes the
  passphrase, the token and the offline copy from that browser.
- Roads are kept in IndexedDB too (decrypted), so the app works **offline** in the
  field. When it's showing that offline copy, a banner says so and saving is off.
- **Hazard pins** mark spots on a road: bad surface, wildlife crossing, tricky
  corner, or a plain note. Add them on the PC (road details → + Add pin → click
  the road); drag to move along the road, click for edit/delete. They show for the
  selected road, or for every road once zoomed in, plus as ticks on the
  elevation strip.
- Weather is **never** stored — always fetched fresh (with a 30-minute in-session
  de-dupe).
- **Saving is safe against stale copies.** The app remembers exactly which version
  of `roads.json` it loaded (its git sha) and every save replaces only that
  version. If the file changed elsewhere in the meantime, GitHub refuses the save
  and the app tells you to reload — it never silently overwrites. A save that
  fails changes nothing in the app either.
- **Other devices see a save within about a minute.** Everything reads
  `roads.json` through the GitHub API (the PC with its token, everyone else
  anonymously — 60 requests per hour per network, one per app load). If that
  allowance runs out, the app reads the public file instead, which GitHub's CDN
  can serve up to 5 minutes old.
- If the roads can't be loaded at all, the app says so and stays read-only instead
  of showing an empty library you could accidentally save over.
- Before each save the app gzips and encrypts the library, then decrypts it again
  to check, and only then uploads it. Every save is a commit, so any version can
  be recovered from the repo history.

## Setup

### 1. Repo + Pages
Public repo on your personal account, with these files. Settings → Pages →
Deploy from a branch → `main` / `/ (root)`. The app is then at
`https://<username>.github.io/<repo>/`. Set `owner` in `js/config.js` to your
username (and repo/branch/path if you changed them).

A brand-new repo needs no `roads.json`: the first save creates it.

### 2. Write token (only on the PC you edit from)
GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate.
Only this repo; Repository permissions → **Contents: Read and write**.

### 3. Connect the app
Open the app → **🔑** → paste the token, and set a passphrase (typed twice). Setting
or changing the passphrase re-encrypts and saves the library straight away; the
new passphrase only takes effect on that device once the save succeeded. Other
devices then need the new passphrase.

On the phone (or a friend's browser), just enter the passphrase when asked.

## Local development

No toolchain required. Serve the folder over HTTP (not `file://`):
```bash
python -m http.server 5178        # then open http://localhost:5178/
```

**Sample data:** `http://localhost:5178/?fixture` loads the made-up roads in
`dev/fixture-roads.json` instead of the real library, with saving switched off.
Handy for working on the UI without the passphrase. Only works on localhost.
Add `&fakesave` (`/?fixture&fakesave`) to try every editing flow (pins, rename,
home…): "saves" then only change the page's memory and nothing is sent anywhere.

**Tests** (Node 20+, zero dependencies):
```bash
npm test          # node --test → test/*.test.js
```

## Deploying
Push to `main`; GitHub Pages redeploys in a minute or so. The service worker is
network-first for the app's own files and revalidates past Pages' 10-minute
cache, so an online device picks up a deploy on its next load; offline devices
keep working from the last cached copy. If you add a file under `js/`, add it to
`SHELL` in `sw.js` (a test checks this) and bump `CACHE`.

## Layout
```
index.html          app shell / layout
styles.css          dark tactical theme
manifest.json       PWA install metadata
sw.js               offline app shell (own files + pinned Leaflet only)
roads.json          your saved-road library (encrypted)
dev/                sample data for local development (?fixture)
docs/               v2 design spec + implementation plan
js/
  app.js            bootstrap, views (Library / Tonight / Discover | Near me), inspector
  ui.js             view switching, bottom sheet, modal, unlock/settings, status banner
  map.js            Leaflet map, layers, GPS locate
  library.js        road cards, shape thumbnails, sort/filter, escaping
  planner.js        PC-only: draw / route / save / edit, home, drive distance, pins
  pins.js           hazard pins: types, snapping onto the road
  terrain.js        elevation profile, forecast points along a road
  conditions-map.js Tonight map: roads coloured by section
  repo.js           the loaded library + the only way to change it (copy → write → adopt)
  sync.js           GitHub read / write, sha pinning, local auth
  crypto.js         passphrase encryption (AES-GCM + PBKDF2, gzip)
  store.js          v2 schema, v1→v2 migration, IndexedDB cache
  tonight-rank.js   rank the library by night conditions
  weather.js        open-meteo fetch, fog scoring, night chart geometry
  curvature.js      adamfranco/curvature port + Overpass loader (Discover)
  routing.js        OSRM helpers + air-distance fallback
  geo.js            geometry helpers
  http.js           fetch with timeout
  config.js         repo coordinates, dev fixture switch
test/               node --test unit tests
```
The design mock-ups that used to live in `design/` are on the `design-archive`
branch.

## External services (all free; no keys except your GitHub token)
- **GitHub** — hosting (Pages) + data store (Contents API / raw read)
- **open-meteo** — weather & fog inputs
- **OSRM** (public demo) — route drawing & distance from home; falls back to air distance
- **Overpass** — curvature discovery
- Map tiles: OpenStreetMap, OpenTopoMap, Esri World Imagery
