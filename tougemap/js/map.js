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
