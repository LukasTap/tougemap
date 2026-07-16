# TougeMap v2 — Design Spec

**Date:** 2026-07-16
**Status:** Approved (design), pending implementation plan
**Supersedes:** `H:\tougemap.html` (single-file v1, kept untouched as backup)

---

## 1. Purpose

A personal, cross-device map of driving ("touge") roads. The owner has already
driven most of the country, so the **primary value is the curated library of
saved roads** — their geometry plus the owner's accumulated knowledge (character,
pavement, deer risk, notes) and live conditions (weather, fog). Discovering *new*
curvy roads is a secondary, occasional tool.

The single most important job the app does: **"It's tonight, which of my roads
should I drive, and is it close enough?"**

### Non-goals
- Not a social/collaborative platform. One writer (the owner), many read-only viewers.
- No road *creation* on the phone. Drawing routes happens on the PC.
- No GPS track *recording*. (Phone GPS is used only for "roads near me".)
- No build toolchain (no npm/bundler). Plain files served over HTTPS.

---

## 2. Constraints & decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Hosting | Static site on **GitHub Pages** (public repo) | Free, personal, no company infra, HTTPS kills the CORS problem |
| Data store | **`roads.json` in a public GitHub repo** | Free version history; public read = read-only share; token write = owner-only |
| Write auth | GitHub **personal access token**, stored per-device in `localStorage` (PC only) | Token is never baked into the shipped files (would be publicly exposed) |
| Read auth | None (public raw fetch) | Friends open a link, see roads, zero setup |
| Code shape | Multiple **plain files, ES modules, no build step** | Maintainable; replaces the 2,654-line monolith |
| Device split | **PC = create/edit; Phone = view/check** | Matches real usage; removes the broken mobile-drawing code entirely |
| Curvature discovery | Kept **verbatim**, demoted to on-demand + cached | Algorithm is correct and valuable but slow; not in the main path |
| Distance from home | **Real OSRM road drive-time**, cached in `roads.json` | Air-distance rings mislead in SK terrain; drive-time is accurate |
| Look & feel | Keep the existing dark "tactical/JDM" aesthetic, tightened | Owner likes it; on-theme |

---

## 3. Architecture

### 3.1 File layout (`H:\tougemap\`)

```
index.html            markup, PWA manifest link, module entry
styles.css            all styling (dark theme kept, deduped)
manifest.json         PWA install metadata
sw.js                 service worker: cache app shell + last roads.json
roads.json            sample/empty seed (real data lives in the GitHub repo)
docs/                 this spec + implementation plan
js/
  app.js              bootstrap, mode/route switching, shared state
  map.js              Leaflet init, tile layers, GPS locate, coords bar
  store.js            roads data model, IndexedDB cache, v1→v2 migration
  sync.js             GitHub read (public) + write (token), config/onboarding
  weather.js          open-meteo fetch, fog scoring, forecast render helpers
  curvature.js        adamfranco/curvature port + Overpass loader (verbatim logic)
  planner.js          PC-only: draw/route (OSRM)/name/save/edit metadata
  library.js          road cards, shape thumbnails, sort/filter
  tonight.js          "Tonight" decision view (rank by conditions)
  ui.js               shared helpers: modals, bottom sheet, responsive glue
```

Each module has one responsibility and a small public surface. `curvature.js`,
`weather.js`, and the OSRM helpers are pure-ish and independently testable.

### 3.2 Data model — `roads.json`

```jsonc
{
  "version": 2,
  "home": { "lat": 48.7, "lon": 19.1 },     // or null
  "roads": [
    {
      "id": 1721145600000,                   // stable numeric id (creation ms)
      "name": "Muránska planina loop",
      "points": [ { "lat": 48.7, "lon": 20.0 }, ... ],  // route geometry
      "km": 24.3,
      "created": "2026-07-16",
      "driveTimeFromHome": {                 // cached; recomputed when home moves
        "minutes": 52,
        "km": 61,
        "computedForHome": { "lat": 48.7, "lon": 19.1 }
      },
      "meta": {
        "pavement": "good",                  // "pristine" | "good" | "rough" | null
        "character": "technical",            // "technical" | "flowing" | "mixed" | null
        "deer": "high",                      // "low" | "medium" | "high" | null (display only)
        "notes": "Gravel patch around km 8, gorgeous in autumn."
      }
    }
  ]
}
```

**Migration:** v1 exports (`{version:1, home, roads:[{id,name,points,color,km,saved}]}`)
import cleanly — `saved`→`created`, drop `color`, add empty `meta`, leave
`driveTimeFromHome` null (computed lazily). The owner's existing localStorage
roads are migrated on first run and offered for the initial commit.

### 3.3 Sync (`sync.js`)

- **Read:** `GET` the raw file
  (`https://raw.githubusercontent.com/<owner>/<repo>/<branch>/roads.json`),
  fall back to the Contents API. Result cached in IndexedDB.
- **Write (PC only):** GitHub Contents API `PUT /repos/{owner}/{repo}/contents/roads.json`
  with base64 body + current `sha`. Fetch latest `sha` immediately before writing
  to avoid stale-write conflicts. Each write is a commit (free history).
- **Config:** `{ owner, repo, branch, path, token }` in `localStorage`. A first-run
  **"Connect GitHub"** onboarding screen collects these; a fine-grained token with
  *contents: read/write* on the one repo is sufficient. Clear instructions +
  "test connection" button.
- **Offline:** reads served from IndexedDB cache; writes require connectivity —
  when offline the Save button is disabled with an explanatory hint (no silent
  data loss, no queue in v2).

---

## 4. Features

### 4.1 Library (both devices)
Front door of the app. Road **cards** show: name, a small **shape thumbnail**
(rendered from `points`), length, drive-time from home, tonight's **fog badge**,
and metadata chips (pavement/character/deer). **Sort/filter** by: drive-time,
fog-tonight, length, region, character, pavement, deer risk, name.

### 4.2 Tonight decision view (both devices)
Ranks the whole library by **conditions over the coming night(s)** (20:00–06:00):
fog score (existing dew-point-spread algorithm), rain probability, temperature.
Optional **"reachable tonight"** filter using cached drive-time from home.
Deer risk is shown as a badge but **does not affect ranking** (all drives are at
night; it's static context).

**Weather-fetch policy:** never persisted (no forecast survives a reload; the
service worker caches only app shell + `roads.json`). In-session only, with a
~30 min in-memory TTL — safe because open-meteo is hourly-granular, so within the
TTL the numbers are identical to a live fetch. Road midpoints are **quantized to a
~10 km grid** and fetched once per cell (weather doesn't vary meaningfully within
10 km), so the Tonight view costs a handful of calls rather than one per road.
Every forecast shows an **"updated HH:MM"** timestamp plus a manual refresh.

### 4.3 Road detail (both devices)
Length, drive-time from home, full night forecast + hourly fog strip (reuse the
existing render, now from the single `weather.js`), metadata, notes. On PC also
the edit affordances.

### 4.4 Create & edit — PC only (`planner.js`)
Draw a route: place Start/End/optional Waypoints → OSRM route → name → save
(commits to GitHub). Edit metadata (pavement/character/deer/notes), rename,
delete, zoom. Set/move **home** (recomputes affected drive-times).

### 4.5 Roads near me — phone (`map.js`)
Device geolocation → sort saved roads by proximity to current position and
highlight nearby ones. (Optional stretch: surface nearby *curvature* roads too.)

### 4.6 Curvature discovery — mainly PC (`curvature.js`)
The adamfranco/curvature port kept intact. On-demand load per region/params,
**results cached** in IndexedDB so repeat views are instant. Clear progress +
graceful Overpass-mirror fallback. A found road can be saved into the library.

---

## 5. UX / visual

- Dark tactical theme retained; typography and spacing tightened; duplicate CSS removed.
- **PC:** two-pane — library/list + controls on the left, map on the right.
  Modes: **Library · Tonight · Discover**.
- **Phone:** map-first with a properly rebuilt **bottom sheet** for road detail;
  a simple top switch for **Library · Tonight · Near me**. No drawing UI.
- Clean empty/onboarding states, including the "Connect GitHub" flow.

---

## 6. External services

| Service | Use | Notes / risk |
|---|---|---|
| GitHub (Pages + Contents API) | hosting + data store | Core. Token scope limited to one repo. |
| open-meteo | weather + fog inputs | No key, CORS-friendly. Already works. |
| OSRM public demo | route drawing + drive-time from home | Rate-limited/flaky → **graceful fallback to air distance**, clear errors. |
| Overpass API (multi-mirror) | curvature discovery | Slow; behind the on-demand cached Discover mode. |
| Nominatim | auto-name discovered roads | Optional; best-effort. |

---

## 7. Error handling

- **Network / API down:** every fetch has a timeout + user-visible status; OSRM
  falls back to air distance labelled as approximate.
- **Invalid/expired token:** surfaced in Connect-GitHub with a clear message; reads still work.
- **GitHub write conflict (stale sha):** re-fetch sha and retry once; if still
  conflicting, tell the user to reload (rare for a single writer).
- **Geolocation denied:** "Near me" degrades to the normal library; no nagging.
- **Corrupt/missing roads.json:** fall back to cache, then to empty library; never crash.

---

## 8. Testing / verification

No framework (static app). Verification is:
1. **Pure-logic sanity:** small inline checks for `curvature.js` (known
   input→curvature), `store.js` migration (v1 sample→v2), fog scoring.
2. **Manual browser checklist** driven via the local preview: load library from a
   test repo, save/edit/delete a road (commit appears), Tonight ranking with a
   mocked forecast, phone layout + "near me", offline read from cache, OSRM
   fallback, curvature discover + cache hit.
3. Cross-device smoke: write on PC profile, read on a second (phone-sized) profile.

---

## 9. Known limitations / accepted trade-offs

- OSRM public demo can be slow/down; mitigated by fallback, not eliminated.
- Writes require connectivity (no offline write queue in v2).
- Single-writer model by design; concurrent writers are not supported.
- Curvature discovery remains slow on first load per region (cached thereafter).

---

## 10. Resolved since draft

- **Single public repo** holds both the app files and `roads.json`. (Read-only
  sharing wants the data public anyway, so there's no reason to split.)
- **Writes require connectivity** — accepted; creation happens on the PC at home.
- **Weather is never persisted** — in-session TTL + grid dedup only (see §4.2).

### Deferred to the implementation plan
- Exact fine-grained-token setup steps to document in the Connect-GitHub onboarding.
