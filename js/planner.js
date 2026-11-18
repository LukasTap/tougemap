// js/planner.js — PC-only road creation/editing: draw via OSRM, save/edit/delete,
// set home, cache drive-time-from-home. Browser module (Leaflet global `L` + DOM
// via callbacks). Persistence goes through appState.repo.commit() (repo.js):
// nothing here mutates appState.data directly.

import { map, savedGroup } from './map.js';
import { route, nearestPoint, airFallback } from './routing.js';
import { polylineKm } from './geo.js';
import { normalizeRoad } from './store.js';
import { computeTerrain } from './terrain.js';
import { sanitizePins } from './pins.js';

const SAVED_COLOR = '#b000ff'; // saved roads always render deep purple (no per-road color in v2)

// Width of the invisible tap target drawn along each saved road. A fingertip
// needs far more tolerance than a mouse, so coarse pointers get a wider one;
// ~30px means you only have to land within ~15px either side of the line.
// Read at render time, not module load — the pointer type can change (tablet
// with a stylus, desktop browser toggled to device emulation).
function hitWeight() {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return coarse ? 30 : 12;
}

// Fail fast, before any slow OSRM work, when a save could not go through anyway
// (offline, no token, library not loaded from GitHub). commit() re-checks.
function assertWritable(appState) {
  const block = appState.repo.writeBlock(appState.auth);
  if (block) throw new Error(block);
}

function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── DRAFT / ROUTE-DRAWING STATE ─────────────────────────────────────────────
let placingType = null;                       // 'start' | 'end' | 'waypoint' | null
const routePoints = { start: null, end: null };
const routeMarkers = { start: null, end: null };
let routeWaypoints = [];
let routeWpMarkers = [];
let draftPoints = [];
let draftPolyline = null;
let draftListener = null;                     // (status) => void, see onDraftUpdate()

function notifyDraft(status) { if (draftListener) draftListener(status); }

function makeRouteIcon(type) {
  const label = type === 'start' ? 'S' : 'E';
  const bg = type === 'start' ? 'var(--green)' : 'var(--red)';
  return L.divIcon({
    className: '',
    html: `<div style="width:22px;height:22px;border-radius:4px;background:${bg};border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-family:'Space Mono',monospace;font-size:10px;font-weight:700;color:#000;box-shadow:0 2px 6px rgba(0,0,0,.5)">${label}</div>`,
    iconSize: [22, 22], iconAnchor: [11, 11]
  });
}

function makeWaypointIcon(num) {
  return L.divIcon({
    className: '',
    html: `<div style="width:16px;height:16px;border-radius:50%;background:var(--accent);border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-family:'Space Mono',monospace;font-size:8px;font-weight:700;color:#000;box-shadow:0 2px 4px rgba(0,0,0,.5)">${num}</div>`,
    iconSize: [16, 16], iconAnchor: [8, 8]
  });
}

/** Register a listener for draft/routing status changes: {status:'idle'|'routing'|'ready'|'error', km, minutes, points, message}. */
export function onDraftUpdate(cb) { draftListener = cb; }

/** Snapshot of the current draw-in-progress state, for rendering waypoint lists / stats. */
export function getDraftState() {
  return {
    start: routePoints.start,
    end: routePoints.end,
    waypoints: routeWaypoints.slice(),
    points: draftPoints.slice(),
    km: draftPoints.length ? Math.round(polylineKm(draftPoints) * 10) / 10 : 0,
    ready: draftPoints.length >= 2
  };
}

/** Arm click-to-place mode for the next map click. type: 'start' | 'end' | 'waypoint'. */
export function startPlacing(type) {
  placingType = type;
  if (map) map.getContainer().style.cursor = 'crosshair';
}

/**
 * Dispatches a map click to the currently-armed placement mode (start/end/waypoint).
 * Not in the brief's produce-list verbatim, but required wiring: v1 registered a single
 * global map.on('click', …) that inspected `placingType`. app.js (Task 13) should call
 * this from its own map click handler when in planner mode on desktop. Returns
 * 'route-point' | 'waypoint' | null (null = click was not consumed by placement mode).
 */
export function handleMapClick(lat, lon) {
  if (placingType === 'start' || placingType === 'end') {
    const type = placingType;
    placingType = null;
    if (map) map.getContainer().style.cursor = '';
    setRoutePoint(type, lat, lon);
    return 'route-point';
  }
  if (placingType === 'waypoint') {
    placingType = null;
    if (map) map.getContainer().style.cursor = '';
    addWaypoint(lat, lon);
    return 'waypoint';
  }
  return null;
}

export function setRoutePoint(type, lat, lon) {
  routePoints[type] = { lat, lon };
  if (routeMarkers[type]) routeMarkers[type].remove();
  routeMarkers[type] = L.marker([lat, lon], {
    icon: makeRouteIcon(type), draggable: true, zIndexOffset: 600
  }).addTo(map);
  routeMarkers[type].on('dragend', e => {
    const p = e.target.getLatLng();
    setRoutePoint(type, p.lat, p.lng);
  });
  tryRouting();
}

export function clearRoutePoint(type) {
  routePoints[type] = null;
  if (routeMarkers[type]) { routeMarkers[type].remove(); routeMarkers[type] = null; }
  clearDraft();
  notifyDraft({ status: 'idle' });
}

function rebuildWaypointMarkers() {
  routeWpMarkers.forEach(m => m.remove());
  routeWpMarkers = routeWaypoints.map((wp, i) => {
    const m = L.marker([wp.lat, wp.lon], { icon: makeWaypointIcon(i + 1), draggable: true, zIndexOffset: 500 }).addTo(map);
    m._wpIdx = i;
    m.on('dragend', e => {
      const p = e.target.getLatLng();
      routeWaypoints[m._wpIdx] = { lat: p.lat, lon: p.lng };
      tryRouting();
    });
    return m;
  });
}

export function addWaypoint(lat, lon) {
  routeWaypoints.push({ lat, lon });
  rebuildWaypointMarkers();
  tryRouting();
}

export function removeWaypoint(idx) {
  routeWaypoints.splice(idx, 1);
  rebuildWaypointMarkers();
  tryRouting();
}

export function clearWaypoints() {
  routeWaypoints = [];
  rebuildWaypointMarkers();
  tryRouting();
}

// Bumped on every new routing request and every clear, so a slow OSRM reply for
// an older set of points can't land on top of a newer route (or a cleared one) —
// and become what gets saved.
let routeSeq = 0;

export function clearDraft() {
  routeSeq++;
  draftPoints = [];
  if (draftPolyline) { draftPolyline.remove(); draftPolyline = null; }
}

async function tryRouting() {
  const { start, end } = routePoints;
  if (!start || !end) { clearDraft(); notifyDraft({ status: 'idle' }); return; }

  const seq = ++routeSeq;
  notifyDraft({ status: 'routing' });
  try {
    const pts = [start, ...routeWaypoints, end];
    const result = await route(pts);
    if (seq !== routeSeq) return; // superseded while in flight
    if (draftPolyline) { draftPolyline.remove(); draftPolyline = null; }
    draftPolyline = L.polyline(result.points.map(p => [p.lat, p.lon]), {
      color: '#e8a020', weight: 5, opacity: 0.95, lineJoin: 'round', lineCap: 'round', dashArray: '10,5'
    }).addTo(map);
    draftPoints = result.points;
    notifyDraft({ status: 'ready', km: result.km, minutes: result.minutes, points: draftPoints.slice() });
  } catch (e) {
    if (seq !== routeSeq) return;
    notifyDraft({ status: 'error', message: e?.message || 'Routing failed' });
  }
}

function resetRouteUI() {
  ['start', 'end'].forEach(type => {
    if (routeMarkers[type]) { routeMarkers[type].remove(); routeMarkers[type] = null; }
    routePoints[type] = null;
  });
  routeWpMarkers.forEach(m => m.remove());
  routeWpMarkers = [];
  routeWaypoints = [];
  clearDraft();
  notifyDraft({ status: 'idle' });
}

// ── SAVED ROADS: RENDER + SELECT ────────────────────────────────────────────
let lastRoads = [];
const savedLayers = new Map(); // id -> L.polyline
let selectedRoadId = null;
let selectListener = null;     // (road|null) => void, see onRoadSelect()

/** Register a listener invoked with the road object (or null) when selection changes. */
export function onRoadSelect(cb) { selectListener = cb; }

// While the Tonight map colours the roads by conditions, the purple lines step
// aside (opacity 0) — but stay on the map, so the invisible tap targets still
// select roads.
let savedMuted = false;
const savedStyle = (selected) => ({ weight: selected ? 6 : 4, opacity: savedMuted ? 0 : (selected ? 1 : 0.75) });

export function setSavedRoadsMuted(muted) {
  savedMuted = muted;
  for (const [rid, layer] of savedLayers) layer.setStyle(savedStyle(rid === selectedRoadId));
}

/** (Re)draws every road in appState.data.roads onto savedGroup, purple, click-to-select. */
export function renderSavedRoads(appState) {
  savedGroup.clearLayers();
  savedLayers.clear();
  lastRoads = appState.data.roads;
  for (const road of lastRoads) {
    const isSelected = road.id === selectedRoadId;
    const latlngs = road.points.map(p => [p.lat, p.lon]);
    const layer = L.polyline(latlngs, {
      color: SAVED_COLOR,
      ...savedStyle(isSelected),
      lineJoin: 'round', lineCap: 'round'
    });
    layer.on('click', () => selectRoad(road.id));
    layer.addTo(savedGroup);
    savedLayers.set(road.id, layer);

    // A 4px stroke is far too thin to hit with a fingertip, so every road also
    // gets an invisible, much fatter line along the SAME geometry that carries
    // the tap. Added last so it sits on top and wins the hit-test; the visible
    // stroke is unchanged. (A bounding box would be wrong here — a long diagonal
    // road's box covers huge areas of map nowhere near the road itself.)
    L.polyline(latlngs, {
      color: SAVED_COLOR, weight: hitWeight(), opacity: 0,
      lineJoin: 'round', lineCap: 'round'
    }).on('click', () => selectRoad(road.id)).addTo(savedGroup);
  }
}

/** Marks a road selected (restyles its layer) and notifies onRoadSelect listeners. Returns the road or null. */
export function selectRoad(id) {
  selectedRoadId = id;
  for (const [rid, layer] of savedLayers) {
    layer.setStyle(savedStyle(rid === id));
  }
  const road = lastRoads.find(r => r.id === id) || null;
  if (selectListener) selectListener(road);
  return road;
}

// ── HOME MARKER ──────────────────────────────────────────────────────────────
let homeMarker = null;

/** (Re)draws the draggable home marker. onDragEnd(lat, lon) fires when it's dropped. */
export function renderHomeMarker(home, onDragEnd) {
  if (homeMarker) { homeMarker.remove(); homeMarker = null; }
  if (!home) return null;
  homeMarker = L.marker([home.lat, home.lon], {
    icon: L.divIcon({
      className: '',
      html: `<div style="width:22px;height:22px;border-radius:50%;background:var(--blue);border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:#000;box-shadow:0 2px 6px rgba(0,0,0,.5)">⌂</div>`,
      iconSize: [22, 22], iconAnchor: [11, 11]
    }),
    draggable: !!onDragEnd, zIndexOffset: 2000
  }).addTo(map);
  if (onDragEnd) {
    homeMarker.on('dragend', e => {
      const p = e.target.getLatLng();
      onDragEnd(p.lat, p.lng);
    });
  }
  return homeMarker;
}

// ── PERSISTENCE: SAVE / EDIT / RENAME / DELETE ──────────────────────────────
// Each function describes its change to a COPY of the library; repo.commit()
// writes the copy and only adopts it once GitHub has accepted it.

function findRoad(data, id) {
  const road = data.roads.find(r => r.id === id);
  if (!road) throw new Error('Road not found — it may have been deleted');
  return road;
}

/**
 * Saves a new road built from `points`, with its drive-time from home (if home
 * is set), then re-renders and selects it. Returns the saved road.
 */
export async function saveRoad(name, points, appState) {
  if (!points || points.length < 2) throw new Error('Route needs at least 2 points');
  assertWritable(appState);
  const road = normalizeRoad({
    id: Date.now(),
    name: (name || '').trim() || 'Unnamed road',
    points: points.map(p => ({ lat: p.lat, lon: p.lon })),
    created: localDate()
  });
  const home = appState.data.home;
  if (home) road.driveTimeFromHome = await driveTimeFrom(home, road.points);
  // Elevation profile for multi-point weather (terrain.js). If the service is
  // down the road is saved without it; the next load's backfill adds it.
  try { const t = await computeTerrain(road.points); if (t) road.terrain = t; } catch { /* later */ }
  await appState.repo.commit(appState.auth, next => { next.roads.push(road); });
  resetRouteUI();
  renderSavedRoads(appState);
  selectRoad(road.id);
  return road;
}

/** Shallow-merges `patch` into the road's meta. */
export async function editMeta(id, patch, appState) {
  await appState.repo.commit(appState.auth, next => {
    const road = findRoad(next, id);
    road.meta = { ...road.meta, ...patch };
  });
  renderSavedRoads(appState);
}

/** Renames a road; a blank name is ignored (nothing is written). */
export async function renameRoad(id, name, appState) {
  const trimmed = (name || '').trim();
  if (!trimmed) return;
  await appState.repo.commit(appState.auth, next => { findRoad(next, id).name = trimmed; });
  renderSavedRoads(appState);
}

export async function deleteRoad(id, appState) {
  await appState.repo.commit(appState.auth, next => {
    next.roads.splice(next.roads.indexOf(findRoad(next, id)), 1);
  });
  if (selectedRoadId === id) {
    selectedRoadId = null;
    if (selectListener) selectListener(null);
  }
  renderSavedRoads(appState);
}

// ── HAZARD PINS (pins.js) ───────────────────────────────────────────────────
/** Adds the pin, or replaces the one with the same id (edit / move). */
// Both re-render the saved roads afterwards, like every other edit: that also
// refreshes the road list selectRoad() reads, so re-opening the road shows the
// change.
export async function savePin(roadId, pin, appState) {
  await appState.repo.commit(appState.auth, next => {
    const road = findRoad(next, roadId);
    road.pins = sanitizePins([...(road.pins || []).filter(p => p.id !== pin.id), pin]);
  });
  renderSavedRoads(appState);
}

export async function deletePin(roadId, pinId, appState) {
  await appState.repo.commit(appState.auth, next => {
    const road = findRoad(next, roadId);
    const pins = (road.pins || []).filter(p => p.id !== pinId);
    if (pins.length) road.pins = pins; else delete road.pins;
  });
  renderSavedRoads(appState);
}

// ── DRIVE-TIME FROM HOME ─────────────────────────────────────────────────────
// Road distance home → the road's nearest point; air distance when OSRM is down.
async function driveTimeFrom(home, points) {
  const { point } = nearestPoint(home.lat, home.lon, points);
  try {
    const r = await route([home, point]);
    return { minutes: r.minutes, km: r.km, computedForHome: { ...home } };
  } catch {
    const air = airFallback(home.lat, home.lon, point.lat, point.lon);
    return { minutes: null, km: air.km, computedForHome: { ...home }, approx: true };
  }
}

/**
 * Moves home and recomputes every road's distance from it. The OSRM calls run
 * first (one at a time — it's a shared public server); the library only
 * changes once the whole result has been saved. Returns the new home.
 */
export async function setHome(lat, lon, appState) {
  assertWritable(appState);
  const home = { lat, lon };
  const times = new Map();
  for (const road of appState.data.roads) {
    if (road.points?.length) times.set(road.id, await driveTimeFrom(home, road.points));
  }
  await appState.repo.commit(appState.auth, next => {
    next.home = home;
    for (const road of next.roads) if (times.has(road.id)) road.driveTimeFromHome = times.get(road.id);
  });
  renderSavedRoads(appState);
  return home;
}
