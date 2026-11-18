// js/app.js — bootstrap + wiring. Builds the single appState, boots the
// onboarding flow (or loads roads.json + renders Library), and wires the
// Library / Tonight / Discover-or-Near-me views plus the desktop-only
// planner (draw/save/edit/home) and Discover curvature UI.

import { initMap, setLayer, locate, sortByProximity, map, discoverGroup } from './map.js';
import { loadAuth, saveToken, savePassphrase, forgetDevice } from './sync.js';
import { createRepo } from './repo.js';
import { idbGet, idbPut, DISCOVER_DB, DISCOVER_STORE } from './store.js';
import {
  createWeatherClient, wmoDesc, nightGroups, nightExtremes, decisionHours,
  buildNightChart, axisLabelIndices, LABEL_W, roadConditions, currentReadings, pointSummaries,
  scrubPoints, nearestScrubPoint
} from './weather.js';
import { roadProfile, pickWeatherPoints, withShares, needsTerrain, computeTerrain } from './terrain.js';
import { showConditionsOnMap, hideConditionsOnMap } from './conditions-map.js';
import { rankRoads, reachable } from './tonight-rank.js';
import { roadCardHtml, thumbnailSvg, metaChipsHtml, sortRoads, filterRoads, escapeHtml, fogStripHtml, POINT_MARK } from './library.js';
import {
  onDraftUpdate, getDraftState, startPlacing, handleMapClick, clearRoutePoint,
  removeWaypoint, clearWaypoints, saveRoad, editMeta, renameRoad,
  deleteRoad, setHome, renderSavedRoads, selectRoad, onRoadSelect, renderHomeMarker
} from './planner.js';
import { nearestPoint, route } from './routing.js';
import { buildOverpassQuery, fetchOverpass, joinAndScore, curvColor, fogColor } from './curvature.js';
import {
  isDesktop, showView, showInspector, hideInspector, openSheet,
  openNameModal, showUnlock, showSettings, hideOnboarding, setDiscoverStatus, setStatusBanner, initUi
} from './ui.js';

const repo = createRepo();
export const appState = {
  repo,
  get data() { return repo.data; }, // read-only view; change it via repo.commit()
  auth: loadAuth(),                 // { token, passphrase } — token=write, passphrase=decrypt
  weatherClient: createWeatherClient(),
  now: () => new Date()
};

// A road's conditions: forecasts at its start, end, summit and low point
// (terrain.js), combined hour by hour into the worst case (weather.js).
// Forecasts are cached in memory, so asking again for the same road is cheap.
// Resolves to null when no forecast is available.
async function conditionsFor(road) {
  if (!road.points?.length) return null;
  const profile = roadProfile(road);
  const points = withShares(pickWeatherPoints(profile), profile[profile.length - 1]?.km || 0);
  const forecasts = await Promise.all(points.map(p => appState.weatherClient.get(p.lat, p.lon).catch(() => null)));
  return roadConditions(points, forecasts, appState.now());
}

// The card strip's rows: one per forecast point, along the road.
const fogRowsOf = (cond) => pointSummaries(cond).map(p => ({ label: p.label, role: p.role, risks: p.risks, hours: p.hours }));

// ── ONE-TIME ELEVATION BACKFILL (the device that can save) ──────────────────
// Roads saved before elevation profiles existed get one, a road at a time, at a
// pace well inside Open-Meteo's 600-coordinates-a-minute allowance (each road
// is 50). Saved in small batches so progress survives closing the tab; anything
// left (rate limit, offline) is picked up on the next load. Phones never do
// this — they read the profiles from roads.json.
const TERRAIN_PACE_MS = 7000;   // ~430 coordinates a minute, leaving room for forecasts
const TERRAIN_SAVE_EVERY = 8;
let terrainBackfilling = false;
const pause = (ms) => new Promise(r => setTimeout(r, ms));

async function backfillTerrain() {
  if (terrainBackfilling || repo.writeBlock(appState.auth)) return;
  const todo = appState.data.roads.filter(needsTerrain);
  if (!todo.length) return;
  terrainBackfilling = true;
  const done = new Map();
  const save = async () => {
    if (!done.size) return;
    const batch = new Map(done);
    await repo.commit(appState.auth, next => {
      for (const r of next.roads) if (batch.has(r.id) && needsTerrain(r)) r.terrain = batch.get(r.id);
    });
    for (const id of batch.keys()) done.delete(id);
    renderSavedRoads(appState);
    refreshCurrentView();
  };
  try {
    for (let i = 0; i < todo.length; i++) {
      if (i) await pause(TERRAIN_PACE_MS);
      setStatusBanner(`Adding elevation profiles to your roads (one-time): ${i + 1} of ${todo.length}…`, 'info');
      try { const t = await computeTerrain(todo[i].points); if (t) done.set(todo[i].id, t); }
      catch { break; } // rate-limited or offline — the rest waits for the next load
      if (done.size >= TERRAIN_SAVE_EVERY) await save();
    }
    await save();
  } catch { /* save refused (conflict, offline): computed again next load */ }
  finally { terrainBackfilling = false; updateStatusBanner(); }
}

let currentView = 'library';
const VIEW_NAMES = { library: 'Library', tonight: 'Tonight', nearme: 'Near Me', discover: 'Discover' };
let placingHome = false;

// ── DISCOVER CACHE (IndexedDB, 24 h) ────────────────────────────────────────
const DISCOVER_TTL_MS = 24 * 60 * 60 * 1000;
async function discoverCacheRead(key) {
  const hit = await idbGet(DISCOVER_DB, DISCOVER_STORE, key);
  return hit && (Date.now() - hit.ts) < DISCOVER_TTL_MS ? hit.collections : null;
}
const discoverCacheWrite = (key, collections) =>
  idbPut(DISCOVER_DB, DISCOVER_STORE, key, { ts: Date.now(), collections });

// ── WRITE GUARD ──────────────────────────────────────────────────────────────
// The repo refuses writes when they can't succeed (offline, no token, library
// not loaded from GitHub). Checking up front gives the reason immediately.
function writeBlockedAlert() {
  const block = repo.writeBlock(appState.auth);
  if (block) { alert(block); return true; }
  return false;
}
const failAlert = (what) => (err) => { alert(`${what} — ${err?.message || err}`); refreshCurrentView(); };

// ── STALE-RENDER GUARD ───────────────────────────────────────────────────────
// Tonight and Near-me await forecasts / GPS (seconds). On a phone every view and
// the road inspector share one container (the bottom sheet), so a late result
// must not overwrite whatever was opened in the meantime. Any navigation bumps
// this; an async render only writes if it is still the latest.
let renderSeq = 0;
const isCurrent = (seq) => seq === renderSeq;

function zoomToPoints(points) {
  if (!points?.length) return;
  const b = L.polyline(points.map(p => [p.lat, p.lon])).getBounds();
  map.fitBounds(b, { padding: [40, 40] });
}

function refreshCurrentView() {
  renderView(currentView, isDesktop() ? getDesktopContainer(currentView) : document.getElementById('sheet-content'));
}
function getDesktopContainer(name) {
  const ids = { library: 'library-list', tonight: 'tonight-list', discover: 'discover-list' };
  return document.getElementById(ids[name]);
}

function switchView(name) {
  currentView = name;
  if (name !== 'tonight') hideConditionsOnMap(); // other views show the roads purple
  const container = showView(name);
  renderView(name, container);
}

function renderView(name, container) {
  const seq = ++renderSeq;
  if (name === 'library') renderLibrary(container, seq);
  else if (name === 'tonight') renderTonight(container, seq);
  else if (name === 'discover') renderDiscoverList(container);
  else if (name === 'nearme') renderNearMe(container, seq);
}

function wireCardClicks(container, roads) {
  container.querySelectorAll('.road-lib-item[data-id]').forEach(el => {
    el.addEventListener('click', () => {
      const id = Number(el.dataset.id);
      const road = roads.find(r => r.id === id);
      selectRoad(id);
      if (road) zoomToPoints(road.points);
    });
  });
}

// ── LIBRARY VIEW ─────────────────────────────────────────────────────────────
function updateRoadCount() {
  const el = document.getElementById('road-count');
  if (el) el.textContent = `${appState.data.roads.length} saved`;
}

function renderLibrary(container, seq) {
  if (!container) return;
  updateRoadCount();
  const q = document.getElementById('library-search')?.value || '';
  const sortKey = document.getElementById('library-sort')?.value || 'name';
  const roads = sortRoads(filterRoads(appState.data.roads, { q }), sortKey);
  if (!roads.length) {
    container.innerHTML = appState.data.roads.length
      ? '<div style="font-size:11px;color:var(--text3);padding:12px 0">No roads match the search.</div>'
      : `<div style="font-size:11px;color:var(--text3);padding:12px 0">${repo.source === 'remote' || repo.source === 'fixture'
          ? 'No roads saved yet.<br>Draw a road on the map and save it.'
          : 'Roads couldn’t be loaded — see the notice at the top of the map.'}</div>`;
    return;
  }
  container.innerHTML = roads.map(r => roadCardHtml(r)).join('');
  wireCardClicks(container, roads);
  // Per-card fog strip, filled in as each road's conditions arrive.
  for (const r of roads) {
    conditionsFor(r).then(cond => {
      if (!cond || !isCurrent(seq)) return;
      const metaEl = container.querySelector(`.road-lib-item[data-id="${r.id}"] .road-lib-meta`);
      if (!metaEl || metaEl.parentElement.querySelector('.fog-strip')) return;
      metaEl.insertAdjacentHTML('afterend', fogStripHtml(fogRowsOf(cond)));
    }).catch(() => {});
  }
}

// ── TONIGHT VIEW ─────────────────────────────────────────────────────────────
// The controls render inside the view (not the desktop sidebar), so the phone
// gets refresh and "within N km" too. The choice is remembered per device.
const TONIGHT_OPTS_KEY = 'tougemap_tonight';
const tonightOpts = (() => {
  try { return { reach: false, km: 100, ...JSON.parse(localStorage.getItem(TONIGHT_OPTS_KEY) || '{}') }; }
  catch { return { reach: false, km: 100 }; }
})();
function saveTonightOpts() {
  try { localStorage.setItem(TONIGHT_OPTS_KEY, JSON.stringify(tonightOpts)); } catch { /* per-device nicety */ }
}

function tonightBarHtml() {
  return `<div class="tonight-bar">
      <label class="tonight-within"><input type="checkbox" data-t="reach" ${tonightOpts.reach ? 'checked' : ''}> Within
        <input type="number" data-t="km" value="${tonightOpts.km}" min="10" step="10" inputmode="numeric"> km of home</label>
      <span class="tonight-stamp" data-t="stamp">Loading…</span>
      <button class="pt-btn" data-t="refresh" title="Fetch fresh forecasts">↻ Refresh</button>
    </div>
    <div data-t="results"><div class="weather-loading">Loading forecasts…</div></div>`;
}

function wireTonightBar(container) {
  const q = (k) => container.querySelector(`[data-t="${k}"]`);
  q('reach')?.addEventListener('change', (e) => { tonightOpts.reach = e.target.checked; saveTonightOpts(); refreshCurrentView(); });
  q('km')?.addEventListener('change', (e) => {
    tonightOpts.km = Math.max(10, Number(e.target.value) || 100); saveTonightOpts(); refreshCurrentView();
  });
  q('refresh')?.addEventListener('click', () => { appState.weatherClient.clear(); refreshCurrentView(); });
}

async function renderTonight(container, seq) {
  if (!container) return;
  container.innerHTML = tonightBarHtml();
  wireTonightBar(container);
  const results = container.querySelector('[data-t="results"]');
  const roads = appState.data.roads;
  const entries = await Promise.all(roads.map(async road =>
    ({ road, conditions: await conditionsFor(road).catch(() => null) })));
  if (!isCurrent(seq)) return; // the user moved on while forecasts loaded
  let ranked = rankRoads(entries);
  if (tonightOpts.reach) ranked = ranked.filter(r => reachable(r, tonightOpts.km));

  if (!ranked.length) {
    results.innerHTML = `<div style="font-size:11px;color:var(--text3);padding:12px 0">${roads.length ? 'No roads within that distance.' : 'No roads saved yet.'}</div>`;
  } else {
    const byId = new Map(entries.map(e => [e.road.id, e]));
    results.innerHTML = ranked.map(road => {
      const entry = byId.get(road.id);
      const fogRows = entry?.conditions ? fogRowsOf(entry.conditions) : null;
      const dist = road.driveTimeFromHome?.km != null ? `<span>${road.driveTimeFromHome.km} km away</span>` : '';
      return `<div class="road-lib-item" data-id="${escapeHtml(road.id)}">
        ${thumbnailSvg(road.points)}
        <div class="road-lib-name">${escapeHtml(road.name)}</div>
        <div class="road-lib-meta"><span>${escapeHtml(road.km)} km</span>${dist}</div>
        ${fogStripHtml(fogRows)}
        <div class="road-lib-chips">${metaChipsHtml(road.meta)}</div>
      </div>`;
    }).join('');
    wireCardClicks(results, ranked);
  }
  // Every road on the map in its sections' colours — all of them, not just the
  // ones the distance filter keeps in the list: the map is for looking around.
  showConditionsOnMap(entries);
  const stamp = container.querySelector('[data-t="stamp"]');
  if (stamp) stamp.textContent = 'Updated ' + appState.now().toTimeString().slice(0, 5);
}

// ── NEAR ME VIEW (mobile only) ───────────────────────────────────────────────
async function renderNearMe(container, seq) {
  if (!container) return;
  container.innerHTML = '<div class="weather-loading">Getting your location…</div>';
  try {
    const { lat, lon } = await locate();
    if (!isCurrent(seq)) return;
    const sorted = sortByProximity(appState.data.roads, lat, lon);
    container.innerHTML = sorted.length
      ? sorted.map(r => roadCardHtml(r)).join('')
      : '<div style="font-size:11px;color:var(--text3);padding:12px 0">No roads saved yet.</div>';
    wireCardClicks(container, sorted);
  } catch (e) {
    if (!isCurrent(seq)) return;
    container.innerHTML = `<div style="font-size:11px;color:var(--text3);padding:12px 0">Location unavailable: ${escapeHtml(e?.message || e)}</div>`;
  }
}

// ── SHARED ROAD INSPECTOR ────────────────────────────────────────────────────
function roadInspectorHtml(road, editable) {
  const meta = road.meta || {};
  const dh = road.driveTimeFromHome;
  const fromHomeKm = dh?.km != null ? `${dh.km} km` : '—';
  const fromHomeSub = dh?.minutes != null ? `${dh.minutes} min by road`
    : (dh?.approx ? 'air (routing down)' : (appState.data.home ? 'not computed yet' : 'set Home point'));
  const chips = metaChipsHtml(meta);
  const subLbl = 'text-transform:none;letter-spacing:0;color:var(--text3);margin-top:2px;font-size:10px';
  return `
    <div class="road-name">${escapeHtml(road.name)}</div>
    ${chips ? `<div class="road-lib-chips" style="margin:4px 0 12px">${chips}</div>` : '<div style="height:8px"></div>'}
    <div class="stat-grid">
      <div class="stat-card">
        <div class="val">${fromHomeKm}</div>
        <div class="lbl">From home</div>
        <div class="lbl" style="${subLbl}">${fromHomeSub}</div>
      </div>
      <div class="stat-card">
        <div class="val">${road.km} km</div>
        <div class="lbl">Road length</div>
        <div class="lbl" style="${subLbl}">${road.points.length} pts</div>
      </div>
    </div>
    <div id="inspector-weather" class="weather-loading" style="margin-top:14px">Loading forecast…</div>
    ${editable ? `
    <button class="pt-btn" id="insp-edit-toggle" style="width:100%;margin-top:14px">✎ Edit details</button>
    <div id="insp-edit-form" style="display:none;margin-top:10px">
      <div style="display:flex;gap:6px;margin-bottom:8px">
        <button class="pt-btn" id="insp-rename-btn">Rename</button>
        <button class="pt-btn danger" id="insp-delete-btn">Delete</button>
      </div>
      <select class="search-input" id="insp-pavement" style="margin-bottom:6px">
        <option value="">Surface…</option>
        <option value="glass" ${meta.pavement === 'glass' ? 'selected' : ''}>Glass — flawless, rare</option>
        <option value="smooth" ${meta.pavement === 'smooth' ? 'selected' : ''}>Smooth — minor blemishes at most</option>
        <option value="patchy" ${meta.pavement === 'patchy' ? 'selected' : ''}>Patchy — some bad sections</option>
        <option value="broken" ${meta.pavement === 'broken' ? 'selected' : ''}>Broken — has to be read and avoided</option>
      </select>
      <select class="search-input" id="insp-character" style="margin-bottom:6px">
        <option value="">Character…</option>
        <option value="flowing" ${meta.character === 'flowing' ? 'selected' : ''}>Flowing</option>
        <option value="technical" ${meta.character === 'technical' ? 'selected' : ''}>Technical</option>
        <option value="mixed" ${meta.character === 'mixed' ? 'selected' : ''}>Mixed</option>
      </select>
      <select class="search-input" id="insp-deer" style="margin-bottom:6px">
        <option value="">Deer…</option>
        <option value="rare" ${meta.deer === 'rare' ? 'selected' : ''}>Rare</option>
        <option value="some" ${meta.deer === 'some' ? 'selected' : ''}>Some</option>
        <option value="heavy" ${meta.deer === 'heavy' ? 'selected' : ''}>Heavy</option>
      </select>
      <textarea class="search-input" id="insp-notes" placeholder="Notes" style="margin-bottom:6px;min-height:50px">${escapeHtml(meta.notes)}</textarea>
      <button class="btn-planner primary" id="insp-save-meta-btn">SAVE META</button>
    </div>` : ''}
    <button class="pt-btn" id="insp-back-btn" style="margin-top:10px;width:100%">← Back to ${VIEW_NAMES[currentView] || 'list'}</button>
  `;
}

const hh = (h) => String(h).padStart(2, '0');

function nightLabel(key, idx) {
  if (idx === 0) return 'Tonight';
  const d = new Date(`${key}T20:00:00`);
  // en-GB explicitly: the rest of the UI is English, and the browser locale
  // would otherwise mix a Slovak weekday into "št night".
  return isNaN(d.getTime()) ? 'Next night' : `${d.toLocaleDateString('en-GB', { weekday: 'short' })} night`;
}

// Both nights as one chart: fog above, temperature below, one shared x-axis.
// Height is the value, colour carries meaning — fog green→purple by severity,
// temperature keyed to real degrees so freezing reads as ice regardless of how
// the night's own range happens to fall.
function nightChartHtml(chart) {
  const { geom, segments, ticks, breaks, temp } = chart;
  const tickMarks = ticks.map(x =>
    `<line class="nc-tick" x1="${x}" y1="${geom.tmpBase}" x2="${x}" y2="${geom.tickEnd}"/>`).join('');
  // No "day" caption under the rule: it landed in the same band as the hour
  // labels and read as debris. Two labelled nights either side of a gap say it.
  const breakMarks = breaks.map(x =>
    `<line class="nc-break" x1="${x}" y1="0" x2="${x}" y2="${geom.tickEnd}"/>`).join('');
  // Drawn first, behind everything: the stretch actually driven. A neutral lift
  // rather than another colour — every hue on this chart already means something.
  const driveBand = segments.map(s => s.drive
    ? `<rect class="nc-drive" x="${s.drive.x0}" y="0" width="${s.drive.width}" height="${geom.tickEnd}"/>
       <line class="nc-drive-edge" x1="${s.drive.x0}" y1="0" x2="${s.drive.x0}" y2="${geom.tickEnd}"/>
       <line class="nc-drive-edge" x1="${s.drive.x1}" y1="0" x2="${s.drive.x1}" y2="${geom.tickEnd}"/>`
    : '').join('');
  // Temperature needs a readable scale of its own — without it the curve only
  // says "down, and white at the bottom".
  // Temperature only: its scale is auto-ranged, so a height means nothing until
  // a line says what. Fog is pinned to an absolute 0–100 and needs none.
  const tmpGrid = temp.ticks.map(t =>
    `<line class="nc-grid" x1="0" y1="${t.y}" x2="${geom.w}" y2="${t.y}"/>` +
    `<text class="nc-grid-lbl" x="${geom.w}" y="${t.y - 2}" text-anchor="end">${t.v}°</text>`).join('');
  const bands =
    (temp.frostHeight > 0 ? `<rect class="nc-frost" x="0" y="${temp.frostY}" width="${geom.w}" height="${temp.frostHeight}"/>` : '') +
    (temp.iceHeight > 0 ? `<rect class="nc-ice" x="0" y="${temp.freezeY}" width="${geom.w}" height="${temp.iceHeight}"/>` : '') +
    (temp.showFreeze
      ? `<line class="nc-freeze" x1="0" y1="${temp.freezeY}" x2="${geom.w}" y2="${temp.freezeY}"/>` +
        `<text class="nc-freeze-lbl" x="${geom.w}" y="${temp.freezeY - 2}" text-anchor="end">0°C</text>`
      : '');
  const plots = segments.map((s, i) => {
    const dim = i ? ' nc-later' : '';
    return `<line class="nc-base${dim}" x1="${s.x0}" y1="${geom.fogBase}" x2="${s.x1}" y2="${geom.fogBase}"/>
      <path class="nc-fog-area${dim}" d="${s.fogArea}" fill="url(#ncFogFill)"/>
      <path class="nc-fog-line${dim}" d="${s.fogLine}" stroke="url(#ncFogStroke)"/>
      <path class="nc-tmp-line${dim}" d="${s.tempLine}" stroke="url(#ncTmpStroke)"/>
      <circle class="nc-peak${dim}" cx="${s.peak.x}" cy="${s.peak.y}" r="3.2" fill="${fogColor(s.peak.risk)}"/>`;
  }).join('');
  const first = segments[0];
  return `<svg class="night-chart" viewBox="0 0 ${geom.w} ${geom.h}" xmlns="http://www.w3.org/2000/svg" role="img">
      <title>Fog and temperature by hour, 20:00–06:00</title>
      <defs>
        <linearGradient id="ncFogStroke" x1="0" y1="${geom.fogBase}" x2="0" y2="${geom.fogTop}" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#3ecf6e"/><stop offset=".30" stop-color="#3ecf6e"/>
          <stop offset=".42" stop-color="#f5c842"/><stop offset=".62" stop-color="#8090c8"/>
          <stop offset=".82" stop-color="#c8b4ff"/><stop offset="1" stop-color="#c8b4ff"/>
        </linearGradient>
        <linearGradient id="ncFogFill" x1="0" y1="${geom.fogBase}" x2="0" y2="${geom.fogTop}" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#3ecf6e" stop-opacity=".05"/>
          <stop offset=".42" stop-color="#f5c842" stop-opacity=".14"/>
          <stop offset=".82" stop-color="#c8b4ff" stop-opacity=".30"/>
        </linearGradient>
        <linearGradient id="ncTmpStroke" x1="0" y1="${geom.tmpBase}" x2="0" y2="${geom.tmpTop}" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#d8f0fa"/>
          <stop offset="${temp.stopFreeze}" stop-color="#d8f0fa"/>
          <stop offset="${temp.stopFreeze}" stop-color="#7fc8e8"/>
          <stop offset="${temp.stopFrost}" stop-color="#7fc8e8"/>
          <stop offset="${temp.stopFrost}" stop-color="#8a9bb0"/>
          <stop offset=".70" stop-color="#8a9bb0"/>
          <stop offset="1" stop-color="#c98a30"/>
        </linearGradient>
      </defs>
      ${driveBand}
      ${bands}
      ${tmpGrid}
      ${tickMarks}
      ${plots}
      ${breakMarks}
      <g class="nc-scrub" aria-hidden="true">
        <line class="nc-scrub-line" y1="0" y2="${geom.tickEnd}"/>
        <circle class="nc-scrub-dot nc-scrub-fog" r="3.5"/>
        <circle class="nc-scrub-dot nc-scrub-tmp" r="3"/>
      </g>
    </svg>`;
}

// Hour labels under each night. Up to four, and when the driving window's edges
// are in range they take two of the slots — so the shaded band is bounded by
// two labelled hours and needs no legend of its own.
//
// Each label is positioned at its true fraction of the night rather than spaced
// evenly: evenly-spaced labels only approximate their own hour, and here they
// would land clear of the band edges they are supposed to mark.
const CHAR_W = 7.2;     // Space Mono at 9px with the uppercase letter-spacing

function axisHtml(segments, hourW) {
  // Thin the labels ACROSS the whole axis, not per night. Each night picks its
  // own first, but the gap is only 12 units wide — so one night's 06 and the
  // next night's 20 are centred barely a label apart and run together. Walking
  // the union in x order drops the second of any such pair.
  let lastX = -Infinity;
  const perSeg = segments.map((s) => {
    const kept = [];
    for (const k of axisLabelIndices(s.hours, hourW)) {
      const x = s.x0 + k * hourW;
      if (x - lastX < LABEL_W) continue;
      lastX = x;
      kept.push(k);
    }
    return kept;
  });

  return segments.map((s, i) => {
    const n = s.hours.length;
    const span = Math.max(1, n - 1) * hourW;
    const marks = perSeg[i].map(k => {
      const pct = n < 2 ? 50 : (k / (n - 1)) * 100;
      return `<span style="left:${pct.toFixed(1)}%">${hh(s.hours[k].hour)}</span>`;
    }).join('');
    // The night's name is dropped rather than left to collide with the next
    // one; position and the neighbour's name still identify it.
    const name = nightLabel(s.key, i);
    const fits = span >= name.length * CHAR_W + 9;
    return `<div class="nc-axis-seg${i ? ' nc-later' : ''}" style="flex:${Math.max(1, n - 1)} 1 0">
        <div class="nc-axis-night">${fits ? name : ''}</div>
        <div class="nc-axis-hours">${marks}</div>
      </div>`;
  }).join('<div class="nc-axis-gap" aria-hidden="true"></div>');
}

// The road's height along its length, with each forecast point marked in the
// colour of its own worst fog — so "which end is the problem" is visible before
// any number is read. A flat road isn't stretched into fake mountains: the
// vertical scale never shows less than 50 m.
function profileSvg(profile, pointStats) {
  const s = (profile || []).filter(p => typeof p.ele === 'number');
  if (s.length < 2) return '';
  const W = 308, H = 40, top = 5, bottom = 3;
  const total = s[s.length - 1].km || 1;
  const eles = s.map(p => p.ele);
  const lo = Math.min(...eles), hi = Math.max(...eles), span = Math.max(hi - lo, 50);
  const x = (km) => +((km / total) * W).toFixed(1);
  const y = (e) => +(top + (1 - (e - lo) / span) * (H - top - bottom)).toFixed(1);
  const line = 'M' + s.map(p => `${x(p.km)} ${y(p.ele)}`).join(' L');
  const marks = pointStats.filter(p => typeof p.ele === 'number').map(p =>
    `<circle cx="${x(p.km)}" cy="${y(p.ele)}" r="3.4" fill="${p.fog != null ? fogColor(p.fog) : 'var(--text3)'}" class="pf-mark"/>`).join('');
  return `<svg class="profile-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Elevation along the road, ${lo}–${hi} m">
      <path class="pf-area" d="${line} L${W} ${H} L0 ${H} Z"/>
      <path class="pf-line" d="${line}"/>
      <text class="nc-grid-lbl" x="${W}" y="${top + 2}" text-anchor="end">${hi} m</text>
      <text class="nc-grid-lbl" x="${W}" y="${H - 1}" text-anchor="end">${lo} m</text>
      ${marks}
    </svg>`;
}

// Full weather panel: current conditions, the night chart, where along the road
// it's worst, and four night-scoped tiles. Every number is the worst of the
// road's forecast points (start / summit / end / low point), and says which
// point it came from whenever there is more than one.
function weatherHtml(cond, profile) {
  const now = appState.now();
  const multi = cond.points.length > 1;
  const at = (label) => (multi && label ? ` · ${label.toLowerCase()}` : '');
  const { coldest } = currentReadings(cond, now);
  const groups = nightGroups(cond.hours);
  const chart = buildNightChart(groups);
  // The chart draws the whole night; the numbers are scoped to the hours actually
  // driven. A worst-hour figure taken from 05:00 is true and useless.
  const decide = groups.length ? decisionHours(groups[0].hours) : [];
  const ext = nightExtremes(decide);
  const scope = decide.length
    ? `Worst of ${hh(decide[0].hour)}:00–${hh(decide[decide.length - 1].hour)}:00`
    : '';

  // Each point on its own, over the same hours.
  const pointStats = pointSummaries(cond);
  const rows = multi ? `<div class="where-rows">${pointStats.map(p => `
      <div class="where-row">
        <i class="where-dot" style="background:${p.fog != null ? fogColor(p.fog) : 'var(--text3)'}"></i>
        <span class="where-name"><b class="where-mark">${POINT_MARK[p.role] || ""}</b> ${escapeHtml(p.label)}</span>
        <span class="where-ele">${p.ele != null ? `${p.ele} m` : ''}</span>
        <span class="where-val">${p.fog != null ? `fog ${p.fog}%` : '—'}${p.temp != null ? ` · <span class="${p.temp <= 3 ? 'w-ice' : ''}">${Math.round(p.temp)}°C</span>` : ''}</span>
      </div>`).join('')}</div>` : '';
  const where = profileSvg(profile, pointStats) + rows;

  const tile = (k, v, when, cls) =>
    `<div class="w-detail"><div class="wlbl">${k}</div><div class="wval ${cls || ''}">${v}${when ? `<span class="wat"> at ${when}</span>` : ''}</div></div>`;
  const tiles = ext ? [
    tile('Coldest', `${Math.round(ext.coldest.temp)}°C`, `${hh(ext.coldest.hour)}h${at(ext.coldest.tempAt)}`, ext.coldest.temp <= 3 ? 'w-ice' : ''),
    tile('Fog peak', `${ext.foggiest.risk}%`, `${hh(ext.foggiest.hour)}h${at(ext.foggiest.riskAt)}`, 'w-fog'),
    tile('Calmest wind', `${Math.round(ext.calmest.wind)} km/h`, `${hh(ext.calmest.hour)}h`),
    tile('Rain peak', `${Math.round(ext.wettest.precip)}%`, ext.wettest.precip > 0 ? `${hh(ext.wettest.hour)}h` : '')
  ].join('') : '';

  const html = `
    ${coldest ? `<div class="weather-now">
      <div class="weather-main"><div class="temp-big">${Math.round(coldest.temp)}°C</div>
        <div class="weather-desc">${wmoDesc(coldest.code)}${multi ? ` · coldest point: ${escapeHtml(coldest.label.toLowerCase())}` : ''}</div></div>
    </div>` : ''}
    <div class="hourly-title" data-resting="Fog above · temperature below">Fog above · temperature below</div>
    ${chart
      ? `<div class="night-chart-wrap">${nightChartHtml(chart)}<div class="nc-axis">${axisHtml(chart.segments, chart.hourW)}</div></div>`
      : '<div style="font-size:11px;color:var(--text3);padding:4px 0 8px">No night hours in window</div>'}
    ${scope ? `<div class="hourly-title tiles-scope">${scope}</div>` : ''}
    ${where ? `<div class="where">${where}</div>` : ''}
    <div class="weather-details">${tiles}</div>`;
  return { html, chart, multi };
}

// Scrubbing: a vertical line that follows the cursor, snapped to the nearest
// hour, reading both curves at that moment.
//
// The readout replaces the chart's own heading rather than floating near the
// cursor — a tooltip would cover the curve it describes, and on a phone your
// finger is already sitting on top of it.
function wireScrub(root, chart, multi = false) {
  const at = (label) => (multi && label ? ` ${label.toLowerCase()}` : '');
  const svg = root.querySelector('.night-chart');
  const head = root.querySelector('.hourly-title');
  const group = root.querySelector('.nc-scrub');
  if (!svg || !head || !group) return;
  const line = group.querySelector('.nc-scrub-line');
  const fogDot = group.querySelector('.nc-scrub-fog');
  const tmpDot = group.querySelector('.nc-scrub-tmp');
  const points = scrubPoints(chart);
  if (!points.length) return;
  // Restore text comes from the template, not from whatever the heading happens
  // to say when this runs — reading the DOM here would capture a live readout as
  // the resting state if the chart were ever re-wired without re-rendering.
  const resting = head.dataset.resting || head.textContent;

  const show = (clientX) => {
    const r = svg.getBoundingClientRect();
    if (!r.width) return;
    const p = nearestScrubPoint(points, ((clientX - r.left) / r.width) * chart.geom.w);
    if (!p) return;
    line.setAttribute('x1', p.x); line.setAttribute('x2', p.x);
    fogDot.setAttribute('cx', p.x); fogDot.setAttribute('cy', p.fogY);
    fogDot.setAttribute('fill', fogColor(p.risk));
    tmpDot.setAttribute('cx', p.x); tmpDot.setAttribute('cy', p.tmpY);
    group.classList.add('on');
    const night = p.night ? nightLabel(chart.segments[p.night].key, p.night).replace(' night', '') + ' ' : '';
    head.textContent = `${night}${hh(p.hour)}:00 · fog ${p.risk}%${at(p.riskAt)} · ${Math.round(p.temp)}°C${at(p.tempAt)}`;
    head.classList.add('nc-readout');
  };
  const clear = () => {
    group.classList.remove('on');
    head.textContent = resting;
    head.classList.remove('nc-readout');
  };

  svg.addEventListener('mousemove', e => show(e.clientX));
  svg.addEventListener('mouseleave', clear);
  // Touch: `touch-action: pan-y` on the chart hands vertical drags to the sheet
  // and horizontal ones to us, so scrubbing cannot swallow a scroll. The line
  // stays put after the finger lifts — on a phone the reading is the point, and
  // it was under your fingertip the whole time it was being made.
  svg.addEventListener('touchstart', e => show(e.touches[0].clientX), { passive: true });
  svg.addEventListener('touchmove', e => show(e.touches[0].clientX), { passive: true });
  svg.addEventListener('touchcancel', clear);
}

async function fillInspectorWeather(road) {
  const el = document.getElementById('inspector-weather');
  if (!el) return;
  if (!road.points?.length) { el.textContent = 'No location data.'; return; }
  try {
    const cond = await conditionsFor(road);
    if (!el.isConnected) return; // another road was opened meanwhile
    if (!cond) { el.textContent = 'Forecast unavailable.'; return; }
    const { html, chart, multi } = weatherHtml(cond, roadProfile(road));
    el.className = '';
    el.innerHTML = html;
    if (chart) wireScrub(el, chart, multi);
  } catch { if (el.isConnected) el.textContent = 'Forecast unavailable.'; }
}

// After an edit, re-open the road from the saved data: the inspector was built
// from the old copy, so its name and chips would otherwise stay stale until you
// navigated away and back.
function refreshAfterEdit(id) {
  refreshCurrentView();
  selectRoad(id);
}

function wireInspectorEdit(road) {
  document.getElementById('insp-edit-toggle')?.addEventListener('click', () => {
    const f = document.getElementById('insp-edit-form');
    if (f) f.style.display = f.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('insp-rename-btn')?.addEventListener('click', () => {
    openNameModal({
      title: 'Rename road', value: road.name,
      onSave: (name) => {
        if (writeBlockedAlert()) return;
        renameRoad(road.id, name, appState).then(() => refreshAfterEdit(road.id)).catch(failAlert('Rename failed'));
      }
    });
  });
  document.getElementById('insp-delete-btn')?.addEventListener('click', () => {
    if (writeBlockedAlert()) return;
    if (confirm(`Delete "${road.name}"? (It stays recoverable from the repo's git history.)`)) {
      deleteRoad(road.id, appState).then(() => { hideInspector(); refreshCurrentView(); }).catch(failAlert('Delete failed'));
    }
  });
  document.getElementById('insp-save-meta-btn')?.addEventListener('click', () => {
    if (writeBlockedAlert()) return;
    const btn = document.getElementById('insp-save-meta-btn');
    const patch = {
      pavement: document.getElementById('insp-pavement').value || null,
      character: document.getElementById('insp-character').value || null,
      deer: document.getElementById('insp-deer').value || null,
      notes: document.getElementById('insp-notes').value
    };
    if (btn) { btn.disabled = true; btn.textContent = 'SAVING…'; }
    editMeta(road.id, patch, appState).then(() => refreshAfterEdit(road.id)).catch(failAlert('Save failed'))
      .finally(() => { if (btn?.isConnected) { btn.disabled = false; btn.textContent = 'SAVE META'; } });
  });
}

let homeLineLayer = null;
let homeLineToken = 0; // guards against a slow route reply overwriting a newer selection
function clearHomeLine() { if (homeLineLayer) { homeLineLayer.remove(); homeLineLayer = null; } }
async function showHomeLine(road) {
  clearHomeLine();
  const home = appState.data.home;
  if (!home || !road?.points?.length) return;
  const myToken = ++homeLineToken;
  const { point } = nearestPoint(home.lat, home.lon, road.points);
  // Faint straight placeholder while the actual road route loads.
  homeLineLayer = L.polyline([[home.lat, home.lon], [point.lat, point.lon]],
    { color: '#3090e8', weight: 2, dashArray: '4,6', opacity: 0.4 }).addTo(map);
  try {
    const r = await route([home, point]); // OSRM route home → nearest point of the road (follows roads)
    if (myToken !== homeLineToken) return; // superseded by a newer selection
    clearHomeLine();
    homeLineLayer = L.polyline(r.points.map(p => [p.lat, p.lon]),
      { color: '#3090e8', weight: 3, dashArray: '6,5', opacity: 0.8 }).addTo(map);
  } catch { /* routing down — keep the straight placeholder */ }
}

function wireRoadSelection() {
  onRoadSelect((road) => {
    renderSeq++; // the inspector now owns the panel/sheet — drop pending list renders
    if (!road) { hideInspector(); clearHomeLine(); return; }
    const editable = isDesktop() && !!appState.auth.token; // editor = writer with a token
    const html = roadInspectorHtml(road, editable);
    if (isDesktop()) showInspector(html); else openSheet(road.name, html, 'half');
    // Back re-renders the list you came from. On mobile this used to call
    // closeSheet(), which only collapsed the sheet to a peek — the inspector was
    // still inside it, so the button appeared to do nothing but shrink things.
    document.getElementById('insp-back-btn')?.addEventListener('click', () => switchView(currentView));
    if (editable) wireInspectorEdit(road);
    fillInspectorWeather(road);
    showHomeLine(road);
  });
}

// ── DESKTOP-ONLY: PLANNER (draw / save / edit / home) ───────────────────────
function updateDraftUi() {
  const s = getDraftState();
  const startEl = document.getElementById('start-coords');
  const endEl = document.getElementById('end-coords');
  if (startEl) startEl.textContent = s.start ? `${s.start.lat.toFixed(4)}, ${s.start.lon.toFixed(4)}` : 'Click S then click map';
  if (endEl) endEl.textContent = s.end ? `${s.end.lat.toFixed(4)}, ${s.end.lon.toFixed(4)}` : 'Click E then click map';
  const wpList = document.getElementById('waypoint-list');
  if (wpList) {
    wpList.innerHTML = s.waypoints.map((wp, i) => `
      <div class="wp-item">
        <span class="wp-num">${i + 1}</span>
        <span class="wp-coords">${wp.lat.toFixed(4)}, ${wp.lon.toFixed(4)}</span>
        <button class="wp-del" data-idx="${i}">✕</button>
      </div>`).join('');
    wpList.querySelectorAll('.wp-del').forEach(btn =>
      btn.addEventListener('click', () => removeWaypoint(Number(btn.dataset.idx))));
  }
  const saveBtn = document.getElementById('save-road-btn');
  if (saveBtn) saveBtn.disabled = !s.ready || !!repo.writeBlock(appState.auth);
}

let lastDraftStatus = { status: 'idle' };
function applyPlannerHint() {
  const hintText = document.getElementById('planner-hint-text');
  if (!hintText) return;
  const block = repo.writeBlock(appState.auth);
  if (block) { hintText.textContent = block; return; }
  const msgs = { idle: 'Place Start and End to route', routing: 'Routing…', ready: 'Ready to save', error: lastDraftStatus.message || 'Routing failed' };
  hintText.textContent = msgs[lastDraftStatus.status] || '';
}

function wirePlannerUi() {
  document.getElementById('draw-toggle')?.addEventListener('click', () => {
    document.getElementById('draw-toggle').classList.toggle('open');
    document.getElementById('draw-body').classList.toggle('open');
  });
  document.getElementById('place-start-btn')?.addEventListener('click', () => startPlacing('start'));
  document.getElementById('place-end-btn')?.addEventListener('click', () => startPlacing('end'));
  document.getElementById('add-wp-btn')?.addEventListener('click', () => startPlacing('waypoint'));
  document.getElementById('clear-start-btn')?.addEventListener('click', () => clearRoutePoint('start'));
  document.getElementById('clear-end-btn')?.addEventListener('click', () => clearRoutePoint('end'));
  document.getElementById('clear-wp-btn')?.addEventListener('click', () => clearWaypoints());

  document.getElementById('save-road-btn')?.addEventListener('click', () => {
    const s = getDraftState();
    if (!s.ready) return;
    openNameModal({
      title: 'Name this road', value: '',
      onSave: (name) => {
        if (writeBlockedAlert()) return;
        saveRoad(name, s.points, appState).then(() => {
          if (currentView === 'library') refreshCurrentView();
        }).catch(failAlert('Could not save road'));
      }
    });
  });

  onDraftUpdate((status) => {
    lastDraftStatus = status;
    updateDraftUi();
    applyPlannerHint();
  });

  document.getElementById('place-home-btn')?.addEventListener('click', () => {
    placingHome = true;
    if (map) map.getContainer().style.cursor = 'crosshair';
  });

  window.addEventListener('online', () => { updateDraftUi(); applyPlannerHint(); });
  window.addEventListener('offline', () => { updateDraftUi(); applyPlannerHint(); });
}

function updateHomeLabel(home) {
  const el = document.getElementById('home-coords');
  if (el) el.textContent = home ? `${home.lat.toFixed(4)}, ${home.lon.toFixed(4)}` : 'Not set';
}

// Home marker + label always mirror the SAVED home: after a failed save (or a
// drag that was refused), the marker snaps back to where home really is.
function renderHome() {
  const home = appState.data.home;
  const canEdit = isDesktop() && !!appState.auth.token && repo.source === 'remote';
  renderHomeMarker(home, canEdit ? (lat, lon) => applyHome(lat, lon) : null);
  updateHomeLabel(home);
}

function applyHome(lat, lon) {
  if (writeBlockedAlert()) { renderHome(); return; }
  const label = document.getElementById('home-coords');
  if (label) label.textContent = 'Saving…';
  setHome(lat, lon, appState)
    .then(() => { renderHome(); refreshCurrentView(); })
    .catch(err => { renderHome(); failAlert('Set home failed')(err); });
}

// ── DESKTOP-ONLY: DISCOVER (curvature) ──────────────────────────────────────
let discoverCollections = [];

function selectedDiscoverTypes() {
  return [...document.querySelectorAll('#discover-type-filter .tag.active')].map(t => t.dataset.val);
}
function selectedDiscoverBbox() {
  return document.querySelector('#discover-region-filter .tag.active')?.dataset.bbox;
}

function clearDiscover() {
  discoverGroup.clearLayers();
  discoverCollections = [];
  const list = document.getElementById('discover-list');
  if (list) list.innerHTML = '';
  setDiscoverStatus('Ready — pick a region and load');
}

function renderDiscoverOnMap() {
  discoverGroup.clearLayers();
  discoverCollections.forEach(c => {
    const layer = L.polyline(c.coords.map(([lat, lon]) => [lat, lon]), {
      color: curvColor(c.curvature), weight: 4, opacity: 0.85,
      dashArray: c.surfaceClass === 'unpaved' ? '6,4' : null
    });
    layer.addTo(discoverGroup);
  });
}

function renderDiscoverList(container) {
  if (!container) return;
  if (!discoverCollections.length) {
    container.innerHTML = '<div style="font-size:11px;color:var(--text3);padding:12px 0">No results yet — pick a region and load.</div>';
    return;
  }
  // Names, refs and highway tags come straight from OpenStreetMap — third-party
  // text, escaped like everything else that goes into innerHTML.
  container.innerHTML = discoverCollections.map((c, idx) => `
    <div class="road-lib-item" data-idx="${idx}">
      <div class="road-lib-name">${escapeHtml(c.name || c.ref || 'Unnamed')} <span style="color:var(--text3);font-weight:400">(${escapeHtml(c.highway || '?')})</span></div>
      <div class="road-lib-meta"><span>${c.length.toFixed(1)} km</span><span>curv ${c.curvature}</span><span>${escapeHtml(c.surfaceClass)}</span></div>
      <div class="road-lib-actions"><button class="road-lib-btn save-discover-btn" data-idx="${idx}">SAVE</button></div>
    </div>`).join('');

  container.querySelectorAll('.road-lib-item[data-idx]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.save-discover-btn')) return;
      const idx = Number(el.dataset.idx);
      const c = discoverCollections[idx];
      zoomToPoints(c.coords.map(([lat, lon]) => ({ lat, lon })));
    });
  });
  container.querySelectorAll('.save-discover-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.idx);
      const c = discoverCollections[idx];
      openNameModal({
        title: 'Save discovered road', value: c.name || c.ref || 'Discovered road',
        onSave: (name) => {
          if (writeBlockedAlert()) return;
          const points = c.coords.map(([lat, lon]) => ({ lat, lon }));
          saveRoad(name, points, appState).then(() => {
            if (currentView === 'library') refreshCurrentView();
          }).catch(failAlert('Could not save road'));
        }
      });
    });
  });
}

async function loadDiscover() {
  const bbox = selectedDiscoverBbox();
  const types = selectedDiscoverTypes();
  if (!bbox) { setDiscoverStatus('Pick a region first', 'error'); return; }
  if (!types.length) { setDiscoverStatus('Pick at least one road type', 'error'); return; }

  const cacheKey = `${bbox}|${types.slice().sort().join(',')}`;
  setDiscoverStatus('Checking cache…', 'loading');
  let collections = await discoverCacheRead(cacheKey);
  if (!collections) {
    setDiscoverStatus('Querying Overpass…', 'loading');
    try {
      const query = buildOverpassQuery([{ bbox }], types);
      const elements = await fetchOverpass(query);
      collections = joinAndScore(elements);
      await discoverCacheWrite(cacheKey, collections);
    } catch (e) {
      setDiscoverStatus('Error: ' + (e?.message || e), 'error');
      return;
    }
  }
  discoverCollections = collections;
  renderDiscoverOnMap();
  setDiscoverStatus(`${collections.length} curvy segments`);
  if (currentView === 'discover') renderDiscoverList(document.getElementById('discover-list'));
}

function wireDiscoverUi() {
  document.querySelectorAll('#discover-type-filter .tag').forEach(t =>
    t.addEventListener('click', () => t.classList.toggle('active')));
  document.querySelectorAll('#discover-region-filter .tag').forEach(t =>
    t.addEventListener('click', () => {
      document.querySelectorAll('#discover-region-filter .tag').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
    }));
  document.getElementById('discover-load-btn')?.addEventListener('click', loadDiscover);
  document.getElementById('discover-clear-btn')?.addEventListener('click', clearDiscover);
  discoverGroup.addTo(map);
}

// ── SHARED CHROME: tabs, layers, map click dispatch ─────────────────────────
function wireTabs() {
  document.querySelectorAll('#mode-tabs .mode-tab[data-view]').forEach(btn =>
    btn.addEventListener('click', () => switchView(btn.dataset.view)));
  document.querySelectorAll('#mobile-topbar .mobile-tab[data-view]').forEach(btn =>
    btn.addEventListener('click', () => switchView(btn.dataset.view)));
}

function wireLayerToggle() {
  document.getElementById('btn-osm')?.addEventListener('click', () => setLayer('osm'));
  document.getElementById('btn-topo')?.addEventListener('click', () => setLayer('topo'));
  document.getElementById('btn-sat')?.addEventListener('click', () => setLayer('sat'));
}

function wireMapClick() {
  map.on('click', (e) => {
    if (!isDesktop()) return; // phone is view-only — no drawing, no home placement
    if (placingHome) {
      placingHome = false;
      map.getContainer().style.cursor = '';
      applyHome(e.latlng.lat, e.latlng.lng);
      return;
    }
    handleMapClick(e.latlng.lat, e.latlng.lng);
  });
  map.on('mousemove', (e) => {
    const bar = document.getElementById('coords-bar');
    if (bar) bar.textContent = `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`;
  });
}

// ── BOOT ─────────────────────────────────────────────────────────────────────
function wireChrome() {
  wireTabs();
  wireLayerToggle();
  wireMapClick();
  wireRoadSelection();

  const desktop = isDesktop();
  document.getElementById('planner-tools').style.display = desktop ? 'block' : 'none';
  document.getElementById('tab-discover').style.display = desktop ? '' : 'none';
  if (desktop) { wirePlannerUi(); wireDiscoverUi(); }

  document.getElementById('settings-btn')?.addEventListener('click', () => openSettings());
  document.getElementById('library-search')?.addEventListener('input', () => { if (currentView === 'library') refreshCurrentView(); });
  document.getElementById('library-sort')?.addEventListener('change', () => { if (currentView === 'library') refreshCurrentView(); });
}

// What the banner over the map says about where the data came from. Silent when
// everything is normal; otherwise it explains why saving is off.
function updateStatusBanner() {
  const when = (e) => (e?.message ? ` (${e.message})` : '');
  if (repo.source === 'fixture') setStatusBanner('Sample data (dev fixture) — saving is off', 'info');
  else if (repo.source === 'cache') setStatusBanner(`Offline copy — couldn’t reach GitHub${when(repo.error)}. Viewing only; saving is off until a reload succeeds.`, 'warn');
  else if (repo.source === 'none') setStatusBanner(`Couldn’t load roads from GitHub${when(repo.error)} and there’s no offline copy on this device. Saving is off — reload to retry.`, 'error');
  else if (repo.notice) setStatusBanner(repo.notice, 'warn');
  else setStatusBanner(null);
}

// Read roads (decrypting if needed) and render. Returns true on success; on a
// lock error it shows the unlock screen and returns false.
async function loadAndRender() {
  try {
    await repo.load(appState.auth);
  } catch (e) {
    if (e.code === 'BAD_PASSPHRASE') { promptUnlock('Wrong passphrase — try again'); return false; }
    if (e.code === 'ENCRYPTED_NO_PASS') { promptUnlock(); return false; }
    throw e;
  }
  hideOnboarding();
  updateStatusBanner();
  renderSavedRoads(appState);
  renderHome();
  updateDraftUi();
  applyPlannerHint();
  switchView('library');
  backfillTerrain(); // background; only runs where saving is possible
  return true;
}

// UNLOCK: only shown when the file is encrypted and we can't decrypt it. Saves
// the passphrase and re-reads. A wrong passphrase fails to decrypt → we come
// straight back here with an error. No silent encryption happens here.
function promptUnlock(message) {
  showUnlock({
    message,
    onSubmit: async ({ passphrase }) => {
      appState.auth = { ...appState.auth, passphrase: passphrase || null };
      savePassphrase(appState.auth.passphrase);
      await loadAndRender();
    }
  });
}

// SETTINGS (🔑): set the write token and/or set/change the passphrase. Setting a
// passphrase (confirmed) is the ONLY way roads get encrypted — an explicit,
// deliberate action, never a silent side effect of unlocking.
//
// With a token, a new passphrase only takes effect on this device once the
// library has been re-encrypted with it AND saved; if that save fails, nothing
// changes here, so this device and the repo can't end up on different
// passphrases. Without a token it just replaces the key this device unlocks with.
function openSettings() {
  showSettings({
    hasToken: !!appState.auth.token,
    hasPassphrase: !!appState.auth.passphrase,
    onCancel: () => {},
    onForget: async () => {
      if (!confirm('Forget this device? This removes the passphrase, the GitHub token and the offline copy of your roads from this browser.')) return;
      await forgetDevice();
      location.reload();
    },
    onSubmit: async ({ passphrase, token }) => {
      if (token) { appState.auth = { ...appState.auth, token }; saveToken(token); }
      if (passphrase && appState.auth.token) {
        const nextAuth = { ...appState.auth, passphrase };
        const block = repo.writeBlock(nextAuth);
        if (block) throw new Error(block);
        await repo.commit(nextAuth, () => {}); // same data, re-encrypted with the new passphrase
        appState.auth = nextAuth;
        savePassphrase(passphrase);
      } else if (passphrase) {
        appState.auth = { ...appState.auth, passphrase };
        savePassphrase(passphrase);
        await loadAndRender();
        return;
      }
      hideOnboarding();
      if (token) await loadAndRender(); // a token changes how the file is read (API vs raw)
      else refreshCurrentView();
    }
  });
}

async function boot() {
  initUi();
  if (!map) initMap('map');
  wireChrome();
  try {
    await loadAndRender(); // plaintext loads with no prompt; encrypted+locked shows unlock
  } catch (e) {
    setStatusBanner(`Something went wrong loading the app: ${e?.message || e}`, 'error');
  }
}

boot();
