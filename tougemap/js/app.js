// js/app.js — bootstrap + wiring. Builds the single appState, boots the
// onboarding flow (or loads roads.json + renders Library), and wires the
// Library / Tonight / Discover-or-Near-me views plus the desktop-only
// planner (draw/save/edit/home) and Discover curvature UI.

import { initMap, setLayer, locate, sortByProximity, map, savedGroup, discoverGroup } from './map.js';
import { loadConfig, readRoads } from './sync.js';
import { createWeatherClient, fogBadge, calcFogScore, wmoDesc } from './weather.js';
import { rankRoads, reachable, scoreRoad } from './tonight-rank.js';
import { roadCardHtml, thumbnailSvg, metaChipsHtml, sortRoads, filterRoads, escapeHtml } from './library.js';
import {
  onDraftUpdate, getDraftState, startPlacing, handleMapClick, clearRoutePoint,
  addWaypoint, removeWaypoint, clearWaypoints, saveRoad, editMeta, renameRoad,
  deleteRoad, setHome, renderSavedRoads, selectRoad, onRoadSelect, renderHomeMarker,
  onHomeChange
} from './planner.js';
import { buildOverpassQuery, fetchOverpass, joinAndScore, curvColor } from './curvature.js';
import {
  isDesktop, showView, showInspector, hideInspector, openSheet, closeSheet,
  openNameModal, showOnboarding, setDiscoverStatus, initUi
} from './ui.js';

export const appState = {
  data: { version: 2, home: null, roads: [] },
  cfg: loadConfig(),
  weatherClient: createWeatherClient(),
  now: () => new Date()
};

let currentView = 'library';
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
  // Per-card fog badge, fetched lazily (grid-deduped/cached by weatherClient).
  for (const r of roads) {
    const mid = midpoint(r);
    if (!mid) continue;
    appState.weatherClient.get(mid.lat, mid.lon).then(fc => {
      const cardEl = container.querySelector(`.road-lib-item[data-id="${r.id}"] .road-lib-meta`);
      if (!cardEl || cardEl.querySelector('.fog-badge')) return;
      const score = calcFogScore(fc, appState.now());
      const badge = fogBadge(score);
      cardEl.insertAdjacentHTML('beforeend', `<span class="fog-badge ${badge.cls}">${badge.lbl}</span>`);
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
  const minMinutes = Number(document.getElementById('tonight-reachable-min')?.value) || 90;
  if (reachableOn) ranked = ranked.filter(r => reachable(r, minMinutes));

  if (!ranked.length) {
    container.innerHTML = '<div style="font-size:11px;color:var(--text3);padding:12px 0">No roads match.</div>';
  } else {
    container.innerHTML = ranked.map(road => {
      const entry = entries.find(e => e.road.id === road.id);
      const s = entry?.forecast ? scoreRoad(road, entry.forecast, appState.now()) : null;
      const badge = s ? fogBadge(s.fog) : null;
      return `<div class="road-lib-item" data-id="${road.id}">
        ${thumbnailSvg(road.points)}
        <div class="road-lib-name">${escapeHtml(road.name)}</div>
        <div class="road-lib-meta"><span>${road.km} km</span>${badge ? `<span class="fog-badge ${badge.cls}">${badge.lbl}</span>` : '<span>no forecast</span>'}</div>
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
  const dt = road.driveTimeFromHome?.minutes != null
    ? `${road.driveTimeFromHome.minutes} min`
    : (road.driveTimeFromHome?.approx ? `~${road.driveTimeFromHome.km} km (air)` : '—');
  const meta = road.meta || {};
  return `
    <div class="road-name">${escapeHtml(road.name)}</div>
    <div class="road-ref">${road.km} km · ${dt} from home</div>
    <div class="road-lib-chips" style="margin-bottom:12px">${metaChipsHtml(meta)}</div>
    <div id="inspector-weather" class="weather-loading">Loading forecast…</div>
    ${editable ? `
    <div class="section-title" style="margin-top:14px">Edit</div>
    <div style="display:flex;gap:6px;margin-bottom:8px">
      <button class="pt-btn" id="insp-rename-btn">Rename</button>
      <button class="pt-btn danger" id="insp-delete-btn">Delete</button>
    </div>
    <select class="search-input" id="insp-pavement" style="margin-bottom:6px">
      <option value="">Pavement quality…</option>
      <option value="pristine" ${meta.pavement === 'pristine' ? 'selected' : ''}>Pristine (rare)</option>
      <option value="good" ${meta.pavement === 'good' ? 'selected' : ''}>Good</option>
      <option value="rough" ${meta.pavement === 'rough' ? 'selected' : ''}>Rough parts</option>
    </select>
    <select class="search-input" id="insp-character" style="margin-bottom:6px">
      <option value="">Character…</option>
      <option value="flowing" ${meta.character === 'flowing' ? 'selected' : ''}>Flowing</option>
      <option value="technical" ${meta.character === 'technical' ? 'selected' : ''}>Technical</option>
      <option value="mixed" ${meta.character === 'mixed' ? 'selected' : ''}>Mixed</option>
    </select>
    <select class="search-input" id="insp-deer" style="margin-bottom:6px">
      <option value="">Deer risk…</option>
      <option value="low" ${meta.deer === 'low' ? 'selected' : ''}>Low</option>
      <option value="medium" ${meta.deer === 'medium' ? 'selected' : ''}>Medium</option>
      <option value="high" ${meta.deer === 'high' ? 'selected' : ''}>High</option>
    </select>
    <textarea class="search-input" id="insp-notes" placeholder="Notes" style="margin-bottom:6px;min-height:50px">${escapeHtml(meta.notes)}</textarea>
    <button class="btn-planner primary" id="insp-save-meta-btn">SAVE META</button>
    <button class="pt-btn" id="insp-back-btn" style="margin-top:10px;width:100%">← Back to Library</button>
    ` : ''}
  `;
}

async function fillInspectorWeather(road) {
  const el = document.getElementById('inspector-weather');
  if (!el) return;
  const mid = midpoint(road);
  if (!mid) { el.textContent = 'No location data.'; return; }
  try {
    const fc = await appState.weatherClient.get(mid.lat, mid.lon);
    const score = calcFogScore(fc, appState.now());
    const badge = fogBadge(score);
    const wcode = fc.hourly.weathercode?.[0];
    const temp = fc.hourly.temperature_2m?.[0];
    el.className = '';
    el.innerHTML = `
      <div class="weather-now">
        <div class="weather-main">
          <div class="temp-big">${temp != null ? Math.round(temp) + '°' : '—'}</div>
          <div class="weather-desc">${wcode != null ? wmoDesc(wcode) : ''}</div>
        </div>
        <span class="fog-badge ${badge.cls}">${badge.lbl} FOG RISK</span>
      </div>`;
  } catch {
    el.textContent = 'Forecast unavailable.';
  }
}

function wireInspectorEdit(road) {
  document.getElementById('insp-back-btn')?.addEventListener('click', () => switchView('library'));
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

function wireRoadSelection() {
  onRoadSelect((road) => {
    if (!road) { hideInspector(); return; }
    const editable = isDesktop();
    const html = roadInspectorHtml(road, editable);
    if (editable) showInspector(html);
    else openSheet(road.name, html, 'half');
    if (editable) wireInspectorEdit(road);
    fillInspectorWeather(road);
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
async function boot() {
  initUi();
  if (!map) initMap('map');

  if (!appState.cfg) {
    showOnboarding(appState, boot);
    return;
  }

  wireTabs();
  wireLayerToggle();
  wireMapClick();
  wireRoadSelection();
  onHomeChange(() => refreshCurrentView());

  const desktop = isDesktop();
  document.getElementById('planner-tools').style.display = desktop ? 'block' : 'none';
  document.getElementById('tab-discover').style.display = desktop ? '' : 'none';
  if (desktop) {
    wirePlannerUi();
    wireDiscoverUi();
  }

  document.getElementById('library-search')?.addEventListener('input', () => {
    if (currentView === 'library') refreshCurrentView();
  });
  document.getElementById('library-sort')?.addEventListener('change', () => {
    if (currentView === 'library') refreshCurrentView();
  });
  document.getElementById('tonight-refresh')?.addEventListener('click', () => {
    appState.weatherClient.clear();
    if (currentView === 'tonight') refreshCurrentView();
  });
  document.getElementById('tonight-reachable-toggle')?.addEventListener('change', () => {
    if (currentView === 'tonight') refreshCurrentView();
  });
  document.getElementById('tonight-reachable-min')?.addEventListener('change', () => {
    if (currentView === 'tonight') refreshCurrentView();
  });

  appState.data = await readRoads(appState.cfg);
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
}

boot();
