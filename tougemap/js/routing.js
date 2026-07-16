// js/routing.js — OSRM helpers with air-distance fallback
import { haversineKm } from './geo.js';
import { fetchWithTimeout } from './http.js';

const OSRM = 'https://router.project-osrm.org/route/v1';

export function buildOsrmUrl(points, { overview = 'full' } = {}) {
  const coords = points.map(p => `${p.lon},${p.lat}`).join(';');
  return `${OSRM}/driving/${coords}?overview=${overview}&geometries=geojson&steps=false`;
}

export function parseOsrmRoute(json) {
  if (json?.code !== 'Ok' || !json.routes?.length) return null;
  const r = json.routes[0];
  return {
    points: (r.geometry?.coordinates ?? []).map(c => ({ lat: c[1], lon: c[0] })),
    km: Math.round(r.distance / 100) / 10,
    minutes: Math.round(r.duration / 60)
  };
}

export async function route(points, { fetchFn = (u, o) => fetchWithTimeout(u, o, 15000) } = {}) {
  const res = await fetchFn(buildOsrmUrl(points));
  const parsed = parseOsrmRoute(await res.json());
  if (!parsed) throw new Error('No route');
  return parsed;
}

export function airFallback(fromLat, fromLon, toLat, toLon) {
  return { km: Math.round(haversineKm(fromLat, fromLon, toLat, toLon)), minutes: null, approx: true };
}

export function nearestPoint(fromLat, fromLon, points) {
  let best = points[0], bestKm = Infinity;
  for (const p of points) {
    const d = haversineKm(fromLat, fromLon, p.lat, p.lon);
    if (d < bestKm) { bestKm = d; best = p; }
  }
  return { point: best, km: bestKm };
}
