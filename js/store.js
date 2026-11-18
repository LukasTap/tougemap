// js/store.js — data model, migration, and (browser) IndexedDB cache
import { polylineKm } from './geo.js';

export const SCHEMA_VERSION = 2;
export const META_DEFAULT = { pavement: null, character: null, deer: null, notes: '' };

// v1 → v2 tag words, mapped by RANK rather than by dictionary meaning.
// "Rough parts" always meant *some* bad sections, which is exactly `patchy`;
// mapping it to `broken` would have libelled every decent road. `broken` is a
// genuinely new bottom tier and nothing migrates into it.
const PAVEMENT_V1 = { pristine: 'glass', good: 'smooth', rough: 'patchy' };
const DEER_V1 = { low: 'rare', medium: 'some', high: 'heavy' };

// Idempotent: a value already in the new vocabulary is not in the map and falls
// straight through, so this can run on every read.
export function migrateMeta(meta) {
  return {
    ...meta,
    pavement: meta.pavement ? (PAVEMENT_V1[meta.pavement] ?? meta.pavement) : null,
    deer: meta.deer ? (DEER_V1[meta.deer] ?? meta.deer) : null
  };
}

export function emptyData() {
  return { version: 2, home: null, roads: [] };
}

// `fallbackId` is only used for roads that arrive without one (v1 data);
// migrate() passes a distinct value per road so they can't collide.
export function normalizeRoad(r, fallbackId = Date.now()) {
  const points = Array.isArray(r.points) ? r.points.slice() : [];
  return {
    id: r.id ?? fallbackId,
    name: r.name ?? 'Unnamed road',
    points,
    km: typeof r.km === 'number' ? r.km : Math.round(polylineKm(points) * 10) / 10,
    created: r.created ?? r.saved ?? new Date().toISOString().slice(0, 10),
    driveTimeFromHome: r.driveTimeFromHome ?? null,
    meta: migrateMeta({ ...META_DEFAULT, ...(r.meta ?? {}) })
  };
}

export function migrate(raw) {
  const roadsIn = Array.isArray(raw) ? raw : (raw?.roads ?? []);
  const home = (Array.isArray(raw) ? null : raw?.home) ?? null;
  return {
    version: SCHEMA_VERSION,
    home: home && typeof home.lat === 'number' && typeof home.lon === 'number' ? { lat: home.lat, lon: home.lon } : null,
    roads: roadsIn.map((r, i) => normalizeRoad(r, Date.now() + i))
  };
}

// ── Browser-only IndexedDB helpers. Every call is best-effort: no IndexedDB
// (Node, private mode, blocked storage) reads as a miss and writes are dropped.
function openDb(name, store) {
  return new Promise((res, rej) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(store);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
export async function idbGet(name, store, key) {
  try {
    const db = await openDb(name, store);
    return await new Promise((res) => {
      const r = db.transaction(store).objectStore(store).get(key);
      r.onsuccess = () => res(r.result ?? null);
      r.onerror = () => res(null);
    });
  } catch { return null; }
}
export async function idbPut(name, store, key, value) {
  try {
    const db = await openDb(name, store);
    await new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch { /* best-effort */ }
}
function idbDrop(name) {
  return new Promise((res) => {
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = req.onerror = req.onblocked = () => res();
    } catch { res(); }
  });
}

// The last good library, for offline viewing. Note: stored DECRYPTED — it's
// what lets the app open in the field — so "Forget this device" clears it.
const DB = 'tougemap', STORE = 'roads', KEY = 'data';
export const DISCOVER_DB = 'tougemap-discover-cache', DISCOVER_STORE = 'regions';
export const cacheRead = () => idbGet(DB, STORE, KEY);
export const cacheWrite = (data) => idbPut(DB, STORE, KEY, data);
export async function cacheClear() {
  await idbDrop(DB);
  await idbDrop(DISCOVER_DB);
}
