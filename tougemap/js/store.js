// js/store.js — data model, migration, and (browser) IndexedDB cache
import { polylineKm } from './geo.js';

export const SCHEMA_VERSION = 2;
export const META_DEFAULT = { pavement: null, character: null, deer: null, notes: '' };

export function emptyData() {
  return { version: 2, home: null, roads: [] };
}

export function normalizeRoad(r) {
  const points = Array.isArray(r.points) ? r.points.slice() : [];
  return {
    id: r.id ?? Date.now(),
    name: r.name ?? 'Unnamed road',
    points,
    km: typeof r.km === 'number' ? r.km : Math.round(polylineKm(points) * 10) / 10,
    created: r.created ?? r.saved ?? new Date().toISOString().slice(0, 10),
    driveTimeFromHome: r.driveTimeFromHome ?? null,
    meta: { ...META_DEFAULT, ...(r.meta ?? {}) }
  };
}

export function migrate(raw) {
  const roadsIn = Array.isArray(raw) ? raw : (raw?.roads ?? []);
  const home = (Array.isArray(raw) ? null : raw?.home) ?? null;
  return {
    version: SCHEMA_VERSION,
    home: home && typeof home.lat === 'number' && typeof home.lon === 'number' ? { lat: home.lat, lon: home.lon } : null,
    roads: roadsIn.map(normalizeRoad)
  };
}

// ── Browser-only IndexedDB cache (verified manually in Task 12) ────────────
const DB = 'tougemap', STORE = 'roads', KEY = 'data';
function openDb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
export async function cacheRead() {
  try {
    const db = await openDb();
    return await new Promise((res) => {
      const r = db.transaction(STORE).objectStore(STORE).get(KEY);
      r.onsuccess = () => res(r.result ?? null);
      r.onerror = () => res(null);
    });
  } catch { return null; }
}
export async function cacheWrite(data) {
  try {
    const db = await openDb();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(data, KEY);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch { /* cache is best-effort */ }
}
