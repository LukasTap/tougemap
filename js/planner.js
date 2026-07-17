// js/planner.js — PC-only road creation/editing: draw via OSRM, save/edit/delete,
// set home, cache drive-time-from-home. Browser module (Leaflet global `L` + DOM
// via callbacks) — not unit-tested, verified live (Task 14). Ported from v1
// tryRouting (L1815–1855), setRoutePoint/waypoints (L1743–1810), calcRoadDistance
// (L2031–2069), with all localStorage persistence replaced by writeRoads().

import { map, savedGroup } from './map.js';
import { route, nearestPoint, airFallback } from './routing.js';
import { polylineKm } from './geo.js';
import { writeRoads, loadAuth } from './sync.js';
import { normalizeRoad } from './store.js';

const SAVED_COLOR = '#b000ff'; // saved roads always render deep purple (no per-road color in v2)

// Auth for writes: { token, passphrase } — token authorizes the commit,
// passphrase encrypts the payload (both handled inside writeRoads).
function getCfg(appState) {
  return appState.auth || loadAuth();
}

// Guards every write path against a doomed network attempt while offline (spec §3.3).
// Thrown before any appState.data mutation so callers' in-memory state stays consistent.
function assertOnline() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error("You're offline — changes can't be saved right now");
  }
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

export function clearDraft() {
  draftPoints = [];
  if (draftPolyline) { draftPolyline.remove(); draftPolyline = null; }
}

async function tryRouting() {
  const { start, end } = routePoints;
  if (!start || !end) { clearDraft(); notifyDraft({ status: 'idle' }); return; }

  notifyDraft({ status: 'routing' });
  try {
    const pts = [start, ...routeWaypoints, end];
    const result = await route(pts);
    if (draftPolyline) { draftPolyline.remove(); draftPolyline = null; }
    draftPolyline = L.polyline(result.points.map(p => [p.lat, p.lon]), {
      color: '#e8a020', weight: 5, opacity: 0.95, lineJoin: 'round', lineCap: 'round', dashArray: '10,5'
    }).addTo(map);
    draftPoints = result.points;
    notifyDraft({ status: 'ready', km: result.km, minutes: result.minutes, points: draftPoints.slice() });
  } catch (e) {
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

/** (Re)draws every road in appState.data.roads onto savedGroup, purple, click-to-select. */
export function renderSavedRoads(appState) {
  savedGroup.clearLayers();
  savedLayers.clear();
  lastRoads = appState.data.roads;
  for (const road of lastRoads) {
    const isSelected = road.id === selectedRoadId;
    const layer = L.polyline(road.points.map(p => [p.lat, p.lon]), {
      color: SAVED_COLOR,
      weight: isSelected ? 6 : 4,
      opacity: isSelected ? 1 : 0.75,
      lineJoin: 'round', lineCap: 'round'
    });
    layer.on('click', () => selectRoad(road.id));
    layer.addTo(savedGroup);
    savedLayers.set(road.id, layer);
  }
}

/** Marks a road selected (restyles its layer) and notifies onRoadSelect listeners. Returns the road or null. */
export function selectRoad(id) {
  selectedRoadId = id;
  for (const [rid, layer] of savedLayers) {
    layer.setStyle({ weight: rid === id ? 6 : 4, opacity: rid === id ? 1 : 0.75 });
  }
  const road = lastRoads.find(r => r.id === id) || null;
  if (selectListener) selectListener(road);
  return road;
}

// ── HOME MARKER ──────────────────────────────────────────────────────────────
let homeMarker = null;
let homeChangeListener = null; // () => void, see onHomeChange()

/**
 * Register a listener invoked (no args) after the home-marker drag's self-wired
 * setHome() call settles, on both success and failure — mirrors onRoadSelect's
 * seam, giving app.js a hook to refresh the visible view/labels since this
 * internal call bypasses app.js's own .then/.catch UI wiring.
 */
export function onHomeChange(cb) { homeChangeListener = cb; }

/**
 * (Re)draws the draggable home marker. onDragEnd(lat,lon), if given, fires on drag —
 * app.js/setHome wires this to persist the new position (see setHome below, which
 * self-wires this so dragging Home recomputes + saves automatically).
 */
export function renderHomeMarker(home, onDragEnd) {
  if (homeMarker) { homeMarker.remove(); homeMarker = null; }
  if (!home) return null;
  homeMarker = L.marker([home.lat, home.lon], {
    icon: L.divIcon({
      className: '',
      html: `<div style="width:22px;height:22px;border-radius:50%;background:var(--blue);border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:#000;box-shadow:0 2px 6px rgba(0,0,0,.5)">⌂</div>`,
      iconSize: [22, 22], iconAnchor: [11, 11]
    }),
    draggable: true, zIndexOffset: 2000
  }).addTo(map);
  homeMarker.on('dragend', e => {
    const p = e.target.getLatLng();
    if (onDragEnd) onDragEnd(p.lat, p.lng);
  });
  return homeMarker;
}

// ── PERSISTENCE: SAVE / EDIT / RENAME / DELETE ──────────────────────────────

/**
 * Builds a normalized v2 road from the given draft points, pushes it into
 * appState.data.roads, computes its drive-time-from-home (if home is set),
 * writes to GitHub, re-renders saved roads, and selects the new road.
 * Returns the saved road.
 */
export async function saveRoad(name, points, appState) {
  if (!points || points.length < 2) throw new Error('Route needs at least 2 points');
  assertOnline();
  const road = normalizeRoad({
    id: Date.now(),
    name: (name || '').trim() || 'Unnamed road',
    points: points.map(p => ({ lat: p.lat, lon: p.lon })),
    created: new Date().toISOString().slice(0, 10)
  });
  appState.data.roads.push(road);
  if (appState.data.home) {
    await recomputeDriveTime(road, appState.data.home, appState);
  }
  await writeRoads(getCfg(appState), appState.data);
  resetRouteUI();
  renderSavedRoads(appState);
  selectRoad(road.id);
  return road;
}

/** Shallow-merges `patch` into road.meta, writes, re-renders. Returns the road or null if not found. */
export async function editMeta(id, patch, appState) {
  const road = appState.data.roads.find(r => r.id === id);
  if (!road) return null;
  assertOnline();
  road.meta = { ...road.meta, ...patch };
  await writeRoads(getCfg(appState), appState.data);
  renderSavedRoads(appState);
  return road;
}

/** Renames a road (ignored if name is blank after trim). Returns the road or null if not found. */
export async function renameRoad(id, name, appState) {
  const road = appState.data.roads.find(r => r.id === id);
  if (!road) return null;
  assertOnline();
  const trimmed = (name || '').trim();
  if (trimmed) road.name = trimmed;
  await writeRoads(getCfg(appState), appState.data);
  renderSavedRoads(appState);
  return road;
}

/** Removes a road from appState.data.roads, writes, re-renders. Returns true if a road was removed. */
export async function deleteRoad(id, appState) {
  const idx = appState.data.roads.findIndex(r => r.id === id);
  if (idx < 0) return false;
  assertOnline();
  appState.data.roads.splice(idx, 1);
  if (selectedRoadId === id) {
    selectedRoadId = null;
    if (selectListener) selectListener(null);
  }
  await writeRoads(getCfg(appState), appState.data);
  renderSavedRoads(appState);
  return true;
}

// ── DRIVE-TIME-FROM-HOME CACHE ───────────────────────────────────────────────
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

/**
 * Sets appState.data.home, recomputes drive-time for every saved road, writes to
 * GitHub, and (re)draws the draggable home marker (which self-wires further drags
 * back into setHome). Returns the new home point.
 */
export async function setHome(lat, lon, appState) {
  assertOnline();
  const home = { lat, lon };
  appState.data.home = home;
  for (const road of appState.data.roads) {
    await recomputeDriveTime(road, home, appState);
  }
  await writeRoads(getCfg(appState), appState.data);
  renderHomeMarker(home, (dragLat, dragLon) => {
    // Self-rewired drag handler (see doc comment on renderHomeMarker) — this call
    // bypasses app.js's UI-level guard/catch, so mirror the same alert style here
    // to keep dragging Home just as safe as the app.js-driven write paths. Also
    // notify onHomeChange listeners on both outcomes: setHome mutates
    // appState.data.home + every road's driveTimeFromHome before the awaited
    // writeRoads that can fail, so a failed write leaves the view stale without
    // this refresh hook (success needs the same refresh for consistency).
    setHome(dragLat, dragLon, appState)
      .then(() => { if (homeChangeListener) homeChangeListener(); })
      .catch(err => {
        alert('Set home failed — NOT saved: ' + (err?.message || err));
        if (homeChangeListener) homeChangeListener();
      });
  });
  renderSavedRoads(appState);
  return home;
}
