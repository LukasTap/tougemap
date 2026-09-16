// js/app.js — bootstrap + wiring. Builds the single appState, boots the
// onboarding flow (or loads roads.json + renders Library), and wires the
// Library / Tonight / Discover-or-Near-me views plus the desktop-only
// planner (draw/save/edit/home) and Discover curvature UI.

import { initMap, setLayer, locate, sortByProximity, map, savedGroup, discoverGroup } from './map.js';
import { loadAuth, saveToken, savePassphrase, readRoads, writeRoads } from './sync.js';
import {
  createWeatherClient, wmoDesc, nightHours, nightGroups, nightExtremes, decisionHours,
  tonightRisks, buildNightChart, axisLabelIndices, LABEL_W, DRIVE_FROM, DRIVE_TO
} from './weather.js';
import { rankRoads, reachable } from './tonight-rank.js';
import { roadCardHtml, thumbnailSvg, metaChipsHtml, sortRoads, filterRoads, escapeHtml, fogStripHtml } from './library.js';
import {
  onDraftUpdate, getDraftState, startPlacing, handleMapClick, clearRoutePoint,
  addWaypoint, removeWaypoint, clearWaypoints, saveRoad, editMeta, renameRoad,
  deleteRoad, setHome, renderSavedRoads, selectRoad, onRoadSelect, renderHomeMarker,
  onHomeChange
} from './planner.js';
import { nearestPoint, route } from './routing.js';
import { buildOverpassQuery, fetchOverpass, joinAndScore, curvColor, fogColor } from './curvature.js';
import {
  isDesktop, showView, showInspector, hideInspector, openSheet, closeSheet,
  openNameModal, showUnlock, showSettings, hideOnboarding, setDiscoverStatus, initUi
} from './ui.js';

export const appState = {
  data: { version: 2, home: null, roads: [] },
  auth: loadAuth(),      // { token, passphrase } — token=write, passphrase=decrypt
  weatherClient: createWeatherClient(),
  now: () => new Date()
};

let currentView = 'library';
const VIEW_NAMES = { library: 'Library', tonight: 'Tonight', nearme: 'Near Me', discover: 'Discover' };
let placingHome = false;

// ── DISCOVER IN-MEMORY + INDEXEDDB CACHE (separate DB from store.js's roads
// cache — keeps this module self-contained, no changes to store.js needed) ──
const DISCOVER_DB = 'tougemap-discover-cache';
const DISCOVER_STORE = 'regions';
const DISCOVER_TTL_MS = 24 * 60 * 60 * 1000;

function openDiscoverDb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DISCOVER_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DISCOVER_STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function discoverCacheRead(key) {
  try {
    const db = await openDiscoverDb();
    const hit = await new Promise((res) => {
      const r = db.transaction(DISCOVER_STORE).objectStore(DISCOVER_STORE).get(key);
      r.onsuccess = () => res(r.result ?? null);
      r.onerror = () => res(null);
    });
    if (hit && (Date.now() - hit.ts) < DISCOVER_TTL_MS) return hit.collections;
    return null;
  } catch { return null; }
}
async function discoverCacheWrite(key, collections) {
  try {
    const db = await openDiscoverDb();
    await new Promise((res, rej) => {
      const tx = db.transaction(DISCOVER_STORE, 'readwrite');
      tx.objectStore(DISCOVER_STORE).put({ ts: Date.now(), collections }, key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch { /* best-effort */ }
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
function midpoint(road) { return road.points[Math.floor(road.points.length / 2)]; }

// ── OFFLINE-WRITE GUARD (spec §3.3) ──────────────────────────────────────────
// planner.js's mutators already refuse to run while offline (belt-and-braces —
// covers the self-rewired home-drag handler too), but checking here first means
// the user gets the clear message immediately instead of via a rejected promise.
function isOffline() { return typeof navigator !== 'undefined' && navigator.onLine === false; }
function offlineGuardAlert() {
  if (isOffline()) { alert("You're offline — changes can't be saved right now"); return true; }
  return false;
}

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
  const container = showView(name);
  renderView(name, container);
}

function renderView(name, container) {
  if (name === 'library') renderLibrary(container);
  else if (name === 'tonight') renderTonight(container);
  else if (name === 'discover') renderDiscoverList(container);
  else if (name === 'nearme') renderNearMe(container);
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

function renderLibrary(container) {
  if (!container) return;
  updateRoadCount();
  const q = document.getElementById('library-search')?.value || '';
  const sortKey = document.getElementById('library-sort')?.value || 'name';
  const roads = sortRoads(filterRoads(appState.data.roads, { q }), sortKey);
  if (!roads.length) {
    container.innerHTML = '<div style="font-size:11px;color:var(--text3);padding:12px 0">No roads saved yet.<br>Draw a road on the map and save it.</div>';
    return;
  }
  container.innerHTML = roads.map(r => roadCardHtml(r)).join('');
  wireCardClicks(container, roads);
  // Per-card fog strip, fetched lazily (grid-deduped/cached by weatherClient).
  for (const r of roads) {
    const mid = midpoint(r);
    if (!mid) continue;
    appState.weatherClient.get(mid.lat, mid.lon).then(fc => {
      const metaEl = container.querySelector(`.road-lib-item[data-id="${r.id}"] .road-lib-meta`);
      if (!metaEl || metaEl.parentElement.querySelector('.fog-strip')) return;
      metaEl.insertAdjacentHTML('afterend', fogStripHtml(tonightRisks(fc, appState.now())));
    }).catch(() => {});
  }
}

// ── TONIGHT VIEW ─────────────────────────────────────────────────────────────
async function renderTonight(container) {
  if (!container) return;
  container.innerHTML = '<div class="weather-loading">Loading forecasts…</div>';
  const roads = appState.data.roads;
  const entries = await Promise.all(roads.map(async road => {
    const mid = midpoint(road);
    if (!mid) return { road, forecast: null };
    try { return { road, forecast: await appState.weatherClient.get(mid.lat, mid.lon) }; }
    catch { return { road, forecast: null }; }
  }));
  let ranked = rankRoads(entries, appState.now());
  const reachableOn = document.getElementById('tonight-reachable-toggle')?.checked;
  const maxKm = Number(document.getElementById('tonight-reachable-km')?.value) || 100;
  if (reachableOn) ranked = ranked.filter(r => reachable(r, maxKm));

  if (!ranked.length) {
    container.innerHTML = '<div style="font-size:11px;color:var(--text3);padding:12px 0">No roads match.</div>';
  } else {
    container.innerHTML = ranked.map(road => {
      const entry = entries.find(e => e.road.id === road.id);
      const risks = entry?.forecast ? tonightRisks(entry.forecast, appState.now()) : null;
      return `<div class="road-lib-item" data-id="${road.id}">
        ${thumbnailSvg(road.points)}
        <div class="road-lib-name">${escapeHtml(road.name)}</div>
        <div class="road-lib-meta"><span>${road.km} km</span></div>
        ${fogStripHtml(risks)}
        <div class="road-lib-chips">${metaChipsHtml(road.meta)}</div>
      </div>`;
    }).join('');
    wireCardClicks(container, ranked);
  }
  const stamp = document.getElementById('tonight-updated');
  if (stamp) stamp.textContent = 'Updated ' + appState.now().toTimeString().slice(0, 5);
}

// ── NEAR ME VIEW (mobile only) ───────────────────────────────────────────────
async function renderNearMe(container) {
  if (!container) return;
  container.innerHTML = '<div class="weather-loading">Getting your location…</div>';
  try {
    const { lat, lon } = await locate();
    const sorted = sortByProximity(appState.data.roads, lat, lon);
    container.innerHTML = sorted.length
      ? sorted.map(r => roadCardHtml(r)).join('')
      : '<div style="font-size:11px;color:var(--text3);padding:12px 0">No roads saved yet.</div>';
    wireCardClicks(container, sorted);
  } catch (e) {
    container.innerHTML = `<div style="font-size:11px;color:var(--text3);padding:12px 0">Location unavailable: ${e?.message || e}</div>`;
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
  const tmpGrid = temp.ticks.map(t =>
    `<line class="nc-tmp-grid" x1="0" y1="${t.y}" x2="${geom.w}" y2="${t.y}"/>` +
    `<text class="nc-tmp-lbl" x="${geom.w}" y="${t.y - 2}" text-anchor="end">${t.v}°</text>`).join('');
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
      <title>Fog and temperature by hour, 20:00–06:00; the shaded stretch is ${DRIVE_FROM}:00–0${DRIVE_TO}:00, the hours actually driven. Tonight's fog peaks at ${first.peak.risk}% around ${hh(first.peak.hour)}:00.</title>
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

// Full weather panel: current conditions, the night chart, and four night-scoped
// tiles. Humidity / dew point / dew spread used to sit here as current-hour
// readings — they are the ingredients calcFogScore is cooked from, so printing
// them beside the score was the recipe next to the dish.
function weatherHtml(fc) {
  const now = appState.now();
  const H = fc.hourly;
  const ni = H.time.findIndex(t => new Date(t) > now);
  if (ni < 0) return '<div style="font-size:11px;color:var(--text3)">No forecast.</div>';
  const temp = H.temperature_2m[ni], wcode = H.weathercode?.[ni];
  const groups = nightGroups(nightHours(fc, now));
  const chart = buildNightChart(groups);
  // The chart draws the whole night; the tiles are scoped to the hours actually
  // driven. A worst-hour figure taken from 05:00 is true and useless.
  const decide = groups.length ? decisionHours(groups[0].hours) : [];
  const ext = nightExtremes(decide);
  const scope = decide.length
    ? `Worst of ${hh(decide[0].hour)}:00–${hh(decide[decide.length - 1].hour)}:00`
    : '';
  const tile = (k, v, at, cls) =>
    `<div class="w-detail"><div class="wlbl">${k}</div><div class="wval ${cls || ''}">${v}${at ? `<span class="wat"> at ${at}</span>` : ''}</div></div>`;
  const tiles = ext ? [
    tile('Coldest', `${Math.round(ext.coldest.temp)}°C`, `${hh(ext.coldest.hour)}h`, ext.coldest.temp <= 3 ? 'w-ice' : ''),
    tile('Fog peak', `${ext.foggiest.risk}%`, `${hh(ext.foggiest.hour)}h`, 'w-fog'),
    tile('Calmest wind', `${Math.round(ext.calmest.wind)} km/h`, `${hh(ext.calmest.hour)}h`),
    tile('Rain peak', `${Math.round(ext.wettest.precip)}%`, ext.wettest.precip > 0 ? `${hh(ext.wettest.hour)}h` : '')
  ].join('') : '';
  return `
    <div class="weather-now">
      <div class="weather-main"><div class="temp-big">${Math.round(temp)}°C</div><div class="weather-desc">${wmoDesc(wcode)}</div></div>
    </div>
    <div class="hourly-title">Fog above · temperature below</div>
    ${chart
      ? `<div class="night-chart-wrap">${nightChartHtml(chart)}<div class="nc-axis">${axisHtml(chart.segments, chart.hourW)}</div></div>`
      : '<div style="font-size:11px;color:var(--text3);padding:4px 0 8px">No night hours in window</div>'}
    ${scope ? `<div class="hourly-title tiles-scope">${scope}</div>` : ''}
    <div class="weather-details">${tiles}</div>`;
}

async function fillInspectorWeather(road) {
  const el = document.getElementById('inspector-weather');
  if (!el) return;
  const mid = midpoint(road);
  if (!mid) { el.textContent = 'No location data.'; return; }
  try {
    const fc = await appState.weatherClient.get(mid.lat, mid.lon);
    el.className = '';
    el.innerHTML = weatherHtml(fc);
  } catch { el.textContent = 'Forecast unavailable.'; }
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
        if (offlineGuardAlert()) return;
        renameRoad(road.id, name, appState).then(refreshCurrentView)
          .catch(err => { alert('Rename failed — NOT saved: ' + (err?.message || err)); refreshCurrentView(); });
      }
    });
  });
  document.getElementById('insp-delete-btn')?.addEventListener('click', () => {
    if (confirm(`Delete "${road.name}"? This cannot be undone.`)) {
      if (offlineGuardAlert()) return;
      deleteRoad(road.id, appState).then(() => { hideInspector(); refreshCurrentView(); })
        .catch(err => { alert('Delete failed — NOT saved: ' + (err?.message || err)); refreshCurrentView(); });
    }
  });
  document.getElementById('insp-save-meta-btn')?.addEventListener('click', () => {
    if (offlineGuardAlert()) return;
    const patch = {
      pavement: document.getElementById('insp-pavement').value || null,
      character: document.getElementById('insp-character').value || null,
      deer: document.getElementById('insp-deer').value || null,
      notes: document.getElementById('insp-notes').value
    };
    editMeta(road.id, patch, appState).then(refreshCurrentView)
      .catch(err => { alert('Save failed — NOT saved: ' + (err?.message || err)); refreshCurrentView(); });
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
  if (saveBtn) saveBtn.disabled = !s.ready || isOffline();
}

let lastDraftStatus = { status: 'idle' };
function applyPlannerHint() {
  const hintText = document.getElementById('planner-hint-text');
  if (!hintText) return;
  if (isOffline()) { hintText.textContent = "You're offline — changes can't be saved right now"; return; }
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
        if (offlineGuardAlert()) return;
        saveRoad(name, s.points, appState).then(() => {
          if (currentView === 'library') refreshCurrentView();
        }).catch(err => alert(err.message || 'Could not save road'));
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
  container.innerHTML = discoverCollections.map((c, idx) => `
    <div class="road-lib-item" data-idx="${idx}">
      <div class="road-lib-name">${c.name || c.ref || 'Unnamed'} <span style="color:var(--text3);font-weight:400">(${c.highway || '?'})</span></div>
      <div class="road-lib-meta"><span>${c.length.toFixed(1)} km</span><span>curv ${c.curvature}</span><span>${c.surfaceClass}</span></div>
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
          if (offlineGuardAlert()) return;
          const points = c.coords.map(([lat, lon]) => ({ lat, lon }));
          saveRoad(name, points, appState).then(() => {
            if (currentView === 'library') refreshCurrentView();
          }).catch(err => alert(err.message || 'Could not save road'));
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
      if (offlineGuardAlert()) return;
      setHome(e.latlng.lat, e.latlng.lng, appState).then(updateHomeLabel)
        .catch(err => { alert('Set home failed — NOT saved: ' + (err?.message || err)); refreshCurrentView(); });
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
  onHomeChange(() => refreshCurrentView());

  const desktop = isDesktop();
  document.getElementById('planner-tools').style.display = desktop ? 'block' : 'none';
  document.getElementById('tab-discover').style.display = desktop ? '' : 'none';
  if (desktop) { wirePlannerUi(); wireDiscoverUi(); }

  document.getElementById('settings-btn')?.addEventListener('click', () => openSettings());
  document.getElementById('library-search')?.addEventListener('input', () => { if (currentView === 'library') refreshCurrentView(); });
  document.getElementById('library-sort')?.addEventListener('change', () => { if (currentView === 'library') refreshCurrentView(); });
  document.getElementById('tonight-refresh')?.addEventListener('click', () => { appState.weatherClient.clear(); if (currentView === 'tonight') refreshCurrentView(); });
  document.getElementById('tonight-reachable-toggle')?.addEventListener('change', () => { if (currentView === 'tonight') refreshCurrentView(); });
  document.getElementById('tonight-reachable-km')?.addEventListener('change', () => { if (currentView === 'tonight') refreshCurrentView(); });
}

// Read roads (decrypting if needed) and render. Returns true on success; on a
// lock error it shows the unlock screen and returns false.
async function loadAndRender() {
  try {
    appState.data = await readRoads(appState.auth);
  } catch (e) {
    if (e.code === 'BAD_PASSPHRASE') { promptUnlock('Wrong passphrase — try again'); return false; }
    if (e.code === 'ENCRYPTED_NO_PASS') { promptUnlock(); return false; }
    appState.data = { version: 2, home: null, roads: [] }; // unknown error → empty, let them proceed
  }
  hideOnboarding();
  renderSavedRoads(appState);
  if (appState.data.home) {
    renderHomeMarker(appState.data.home, (lat, lon) => {
      if (offlineGuardAlert()) return;
      setHome(lat, lon, appState).then(updateHomeLabel)
        .catch(err => { alert('Set home failed — NOT saved: ' + (err?.message || err)); refreshCurrentView(); });
    });
    updateHomeLabel(appState.data.home);
  }
  switchView('library');
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
// deliberate action, never a silent side effect of unlocking. Changing it
// re-encrypts the in-memory (already-decrypted) data with the new passphrase.
function openSettings() {
  showSettings({
    hasToken: !!appState.auth.token,
    hasPassphrase: !!appState.auth.passphrase,
    onCancel: () => {},
    onSubmit: async ({ passphrase, token }) => {
      if (token) { appState.auth = { ...appState.auth, token }; saveToken(token); }
      const changingPass = !!passphrase;
      if (changingPass) { appState.auth = { ...appState.auth, passphrase }; savePassphrase(passphrase); }
      hideOnboarding();
      // If a passphrase was set/changed and we can write, (re)encrypt now so the
      // repo reflects it immediately — with confirmation already done, no surprise.
      if (changingPass && appState.auth.token) {
        try { await writeRoads(appState.auth, appState.data); }
        catch (err) { alert('Could not save encrypted roads: ' + (err?.message || err)); }
      }
      refreshCurrentView();
    }
  });
}

async function boot() {
  initUi();
  if (!map) initMap('map');
  wireChrome();
  await loadAndRender(); // plaintext loads with no prompt; encrypted+locked shows unlock
}

boot();
