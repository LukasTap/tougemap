# TougeMap

A personal, cross-device map of driving ("touge") roads. Save your favourite
roads, see their length, drive-time from home, and tonight's weather/fog, and
rank the whole library by how good a drive it'll be *tonight*. Curvature
discovery (finding new twisty roads from OpenStreetMap) is a secondary tool.

- **You** (the owner) create/edit roads on the **PC**, and the app commits them
  to a JSON file in **your** GitHub repo.
- **Any device** — your phone, a friend's browser — reads that public file and
  views the roads, weather, and "roads near me". No account needed to view.
- No build step, no server, no framework. Plain static files + Leaflet.

## How it works

- The app is static files served over HTTPS (GitHub Pages).
- Your saved roads live in **`roads.json` in this same repo**.
- **Reading** roads needs no auth — it's a public file.
- **Writing** (save/edit/delete a road, set home) is done only from the PC,
  authenticated with a GitHub **personal access token** you paste into the app's
  onboarding screen. The token is stored in that browser's `localStorage` only —
  it is never committed, logged, or put in a URL.
- Roads are cached in the browser (IndexedDB) so the app works **offline** in the
  field; it refreshes when it has signal. Weather is **never** cached to disk —
  it's fetched fresh (with a short in-session de-dupe) so it's never stale.

## One-time setup

### 1. Create the repo
Create a **public** repo on **your personal** GitHub account (e.g. `tougemap`),
and put these files in it. Commit a starter `roads.json`:
```json
{ "version": 2, "home": null, "roads": [] }
```

### 2. Enable GitHub Pages
Repo **Settings → Pages → Build and deployment → Deploy from a branch**, pick
`main` / `/ (root)`. Your app (and the read-only share link for friends) is then:
```
https://<your-username>.github.io/<repo>/
```

### 3. Create a write token (PC only)
On GitHub: **Settings → Developer settings → Fine-grained tokens → Generate new
token**. Scope it to **only this one repo**, with **Repository permissions →
Contents: Read and write**. Copy the token.

### 4. Connect the app
Open the app. On first run it asks for **owner / repo / branch / path**
(`main` / `roads.json` are the defaults). On the **PC**, also paste your token
so you can save/edit. On the **phone**, leave the token blank — it only needs to
read. Done.

## Sharing (read-only)
Because the repo is public, anyone you give the Pages URL to just opens it and
sees your roads, on any device, with zero setup. They can view everything; only
you (with the token, on your PC) can change anything.

## Migrating roads from the old single-file version
The old `tougemap.html` stored roads in that browser's `localStorage`. There is
no in-app import UI — to bring your roads over: open the old app, use its
**Export** to download the JSON, then commit that file as `roads.json` in this
repo (or hand it off to be committed for you). The app's `migrate()` reads the
old v1 format automatically the next time it loads the file, so no manual
conversion is needed.

## Local development
No toolchain required. Serve the folder over HTTP (not `file://`) and open it:
```bash
python -m http.server 5178        # then open http://127.0.0.1:5178/
# or:  npx serve -l 5178 .
```

Run the unit tests (Node 18+; zero dependencies):
```bash
npm test        # runs node --test over test/*.test.js
```

## Deploying updates
Just push your changed files to the repo — GitHub Pages redeploys automatically.
The service worker is **network-first for the app shell**, so an online device
picks up the new version on its next load; offline devices keep working from the
last cached copy. (No cache-version bump needed.)

## Layout
```
index.html          app shell / layout
styles.css          dark tactical theme
manifest.json,sw.js PWA install + offline (shell + roads.json only; never weather)
roads.json          your saved-road library (the data)
js/
  app.js            bootstrap, views (Library / Tonight / Discover|Near me)
  ui.js             view switching, bottom sheet, modal, onboarding
  map.js            Leaflet map, layers, GPS locate
  library.js        road cards, shape thumbnails, sort/filter
  planner.js        PC-only: draw/route/save/edit, home, drive-time
  tonight-rank.js   rank the library by night conditions
  weather.js        open-meteo fetch + fog scoring (in-session cache only)
  curvature.js      adamfranco/curvature port + Overpass loader (discovery)
  routing.js        OSRM helpers + air-distance fallback
  sync.js           GitHub read (public) / write (token)
  store.js          v2 schema, v1→v2 migration, IndexedDB cache
  geo.js            geometry helpers
test/               node --test unit tests for the pure modules
```

## External services (all free, no keys except your GitHub token)
- **GitHub** — hosting (Pages) + data store (Contents API / raw read)
- **open-meteo** — weather & fog inputs
- **OSRM** (public demo) — route drawing & drive-time; falls back to air distance
- **Overpass** — curvature discovery (secondary)
- **Nominatim** — best-effort auto-naming of discovered roads
