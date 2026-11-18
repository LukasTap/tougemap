// js/pins.js — hazard pins: marked spots ON a saved road (pure logic, no DOM).
//
// A pin is { id, type, km, lat, lon, note }, stored in road.pins inside the
// encrypted roads.json. Its position is snapped onto the road line, so `km`
// (distance along the road, same measure as terrain.js) places it on the
// elevation strip and orders the list in road order.
import { haversineKm } from './geo.js';

// Deliberately few: the owner should never have to decide between two types.
// "Bad surface" covers potholes, patches and gravel alike — the note says which.
export const PIN_TYPES = {
  surface:  { icon: '🕳', label: 'Bad surface',       hint: 'potholes, patches, gravel' },
  wildlife: { icon: '🦌', label: 'Wildlife crossing', hint: 'where they actually cross' },
  corner:   { icon: '⚠', label: 'Tricky corner',     hint: 'tightens, blind, off-camber' },
  note:     { icon: '✎', label: 'Note',              hint: 'anything else' }
};
export const PIN_NOTE_MAX = 160;
// A click further than this from the road isn't "on" it — the pin would end up
// somewhere the user didn't mean.
export const MAX_PIN_OFFSET_KM = 0.3;

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON = (lat) => 111.32 * Math.cos(lat * Math.PI / 180);

// The point on the road line nearest to (lat, lon): projected onto each segment
// in a local flat frame (fine at road scale), with its distance along the road
// and how far the click was from it.
export function snapToRoad(points, lat, lon) {
  if (!points?.length) return null;
  if (points.length === 1) return { lat: points[0].lat, lon: points[0].lon, km: 0, offKm: haversineKm(lat, lon, points[0].lat, points[0].lon) };
  let best = null, cum = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const kx = KM_PER_DEG_LON(a.lat);
    const bx = (b.lon - a.lon) * kx, by = (b.lat - a.lat) * KM_PER_DEG_LAT;
    const px = (lon - a.lon) * kx, py = (lat - a.lat) * KM_PER_DEG_LAT;
    const len2 = bx * bx + by * by;
    const t = len2 > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
    const off = Math.hypot(px - t * bx, py - t * by);
    const seg = haversineKm(a.lat, a.lon, b.lat, b.lon);
    if (!best || off < best.offKm)
      best = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, km: cum + t * seg, offKm: off };
    cum += seg;
  }
  return {
    lat: Math.round(best.lat * 1e6) / 1e6, lon: Math.round(best.lon * 1e6) / 1e6,
    km: Math.round(best.km * 1000) / 1000, offKm: best.offKm
  };
}

export function newPinId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Whatever comes out of roads.json (or a form) → clean pins in road order.
// Unknown types and broken positions are dropped rather than trusted.
export function sanitizePins(pins) {
  return (Array.isArray(pins) ? pins : [])
    .filter(p => p && PIN_TYPES[p.type] && [p.lat, p.lon, p.km].every(Number.isFinite))
    .map(p => ({
      id: String(p.id ?? newPinId()),
      type: p.type,
      km: Math.round(p.km * 1000) / 1000,
      lat: Math.round(p.lat * 1e6) / 1e6,
      lon: Math.round(p.lon * 1e6) / 1e6,
      note: String(p.note ?? '').trim().slice(0, PIN_NOTE_MAX)
    }))
    .sort((a, b) => a.km - b.km);
}
