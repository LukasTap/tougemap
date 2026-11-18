// js/map.js — Leaflet setup, layers, GPS
import { haversineKm } from './geo.js';

export const TILES = {
  osm:  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OSM' }),
  topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenTopoMap' }),
  sat:  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: '© Esri' })
};

export let map = null;
export const savedGroup = L.layerGroup();
export const discoverGroup = L.layerGroup();
export const conditionsGroup = L.layerGroup(); // Tonight view: roads coloured by conditions
export const pinsGroup = L.layerGroup();       // hazard pins (selected road, or all when zoomed in)
let curLayer = 'osm';

export function initMap(elId) {
  map = L.map(elId, { center: [48.8, 19.5], zoom: 9, layers: [TILES.osm] });
  map.zoomControl.setPosition('bottomright');
  savedGroup.addTo(map);
  pinsGroup.addTo(map);
  applyMapClasses();
  return map;
}

export function setLayer(name) {
  map.removeLayer(TILES[curLayer]);
  map.addLayer(TILES[name]);
  curLayer = name;
  ['osm','topo','sat'].forEach(k =>
    document.getElementById('btn-' + k)?.classList.toggle('active', k === name));
  applyMapClasses();
}

// ── NIGHT MODE ───────────────────────────────────────────────────────────────
// Darkens the base map only, with a CSS filter on Leaflet's tile pane (no extra
// tile service): street and topo maps are inverted into a dark map, satellite
// is dimmed instead (an inverted photo is unreadable). Roads, markers and the
// Tonight colours sit in other panes and are untouched. Remembered per device.
const NIGHT_KEY = 'tougemap_night';
let night = (() => { try { return localStorage.getItem(NIGHT_KEY) === '1'; } catch { return false; } })();
const nightListeners = new Set();

export const isNight = () => night;
export function onNightChange(cb) { nightListeners.add(cb); }

export function setNight(on) {
  night = !!on;
  try { localStorage.setItem(NIGHT_KEY, night ? '1' : '0'); } catch { /* per-device nicety */ }
  applyMapClasses();
  for (const cb of nightListeners) cb(night);
}

function applyMapClasses() {
  const wrap = document.getElementById('map-wrap');
  if (wrap) {
    wrap.classList.toggle('night', night);
    wrap.classList.toggle('base-sat', curLayer === 'sat');
  }
  document.getElementById('btn-night')?.classList.toggle('active', night);
}

export function locate() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('No geolocation'));
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lon: p.coords.longitude }),
      e => rej(e), { enableHighAccuracy: true, timeout: 10000 });
  });
}

// Roads with no geometry sort last instead of throwing.
export function sortByProximity(roads, lat, lon) {
  const dist = r => {
    const m = r.points?.[Math.floor((r.points?.length || 0) / 2)];
    return m ? haversineKm(lat, lon, m.lat, m.lon) : Infinity;
  };
  return roads.map(r => [dist(r), r]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
}
