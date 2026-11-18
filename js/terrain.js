// js/terrain.js — where on a road the weather should be read.
//
// One forecast at the middle of a road misses what matters on a pass: fog sits
// in the valley while the top is clear (or the top is in cloud while the valley
// is fine), and ice starts at the summit. So each road carries an elevation
// profile, and forecasts are read at both ends, the summit, and the low point
// when that's elsewhere.
//
// The profile is stored IN the road (`road.terrain = { ele: [...] }`, one
// elevation per sample from sampleAlong), computed once by the device that can
// save — terrain doesn't change. Open-Meteo counts every coordinate as one API
// call (600 a minute), so having every phone sample every road on every first
// visit would hit that limit immediately.
import { haversineKm } from './geo.js';
import { fetchWithTimeout } from './http.js';

const ELEVATION_API = 'https://api.open-meteo.com/v1/elevation';
export const PROFILE_SAMPLES = 50; // one every ~300 m on a 15 km road
const MIN_GAP_KM = 1;              // closer than this, a second point adds nothing

const r5 = (v) => Math.round(v * 1e5) / 1e5;

// `n` points evenly spaced by DISTANCE along the road, each with `km` from the
// start. (OSRM packs vertices into the curves, so sampling by index would
// over-sample the twisty bits and miss a summit on a long straight climb.)
// Deterministic, so stored elevations line up with it on every device.
export function sampleAlong(points, n = PROFILE_SAMPLES) {
  if (!points?.length) return [];
  const cum = [0];
  for (let i = 1; i < points.length; i++)
    cum.push(cum[i - 1] + haversineKm(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon));
  const total = cum[cum.length - 1];
  if (points.length === 1 || total === 0) return [{ lat: points[0].lat, lon: points[0].lon, km: 0 }];
  const out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1);
    while (j < points.length - 2 && cum[j + 1] < target) j++;
    const seg = cum[j + 1] - cum[j];
    const f = seg > 0 ? Math.min(1, Math.max(0, (target - cum[j]) / seg)) : 0;
    const a = points[j], b = points[j + 1];
    out.push({ lat: r5(a.lat + (b.lat - a.lat) * f), lon: r5(a.lon + (b.lon - a.lon) * f), km: Math.round(target * 1000) / 1000 });
  }
  return out;
}

// The road's samples, with elevations when the road carries them.
export function roadProfile(road) {
  const ele = road.terrain?.ele;
  const samples = sampleAlong(road.points, Array.isArray(ele) && ele.length >= 2 ? ele.length : PROFILE_SAMPLES);
  return Array.isArray(ele) && ele.length === samples.length
    ? samples.map((p, i) => ({ ...p, ele: ele[i] }))
    : samples;
}

export function needsTerrain(road) {
  return (road.points?.length ?? 0) >= 2 && !(Array.isArray(road.terrain?.ele) && road.terrain.ele.length >= 2);
}

// The points worth a forecast, in order along the road. Summit first in line so
// that a road starting at the top calls that point "Summit", not "Start".
// Without elevations it falls back to start / middle / end.
export function pickWeatherPoints(profile) {
  if (!profile?.length) return [];
  const start = profile[0], end = profile[profile.length - 1];
  const hasEle = profile.every(p => typeof p.ele === 'number');
  const by = (better) => profile.reduce((best, p) => (better(p.ele, best.ele) ? p : best), profile[0]);
  const candidates = hasEle
    ? [{ ...by((a, b) => a > b), role: 'summit', label: 'Summit' },
       { ...start, role: 'start', label: 'Start' },
       { ...end, role: 'end', label: 'End' },
       { ...by((a, b) => a < b), role: 'low', label: 'Low point' }]
    : [{ ...start, role: 'start', label: 'Start' },
       { ...end, role: 'end', label: 'End' },
       { ...profile[Math.floor(profile.length / 2)], role: 'mid', label: 'Middle' }];
  const picked = [];
  for (const c of candidates)
    if (picked.every(p => haversineKm(p.lat, p.lon, c.lat, c.lon) >= MIN_GAP_KM)) picked.push(c);
  return picked.sort((a, b) => a.km - b.km);
}

export async function fetchElevations(samples, fetchFn) {
  const q = (key) => samples.map(p => p[key].toFixed(5)).join(',');
  const res = await fetchFn(`${ELEVATION_API}?latitude=${q('lat')}&longitude=${q('lon')}`);
  if (!res.ok) throw new Error('elevation ' + res.status);
  const json = await res.json();
  if (!Array.isArray(json.elevation) || json.elevation.length !== samples.length) throw new Error('elevation: unexpected response');
  return json.elevation.map(e => Math.round(e));
}

// → { ele: [n elevations in metres] } to store as road.terrain. Costs one API
// request worth PROFILE_SAMPLES calls against Open-Meteo's per-minute allowance.
export async function computeTerrain(points, { fetchFn = (u, o) => fetchWithTimeout(u, o, 12000) } = {}) {
  const samples = sampleAlong(points, PROFILE_SAMPLES);
  if (samples.length < 2) return null;
  return { ele: await fetchElevations(samples, fetchFn) };
}
