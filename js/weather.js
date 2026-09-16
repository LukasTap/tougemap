// js/weather.js — open-meteo fetch + fog scoring (no persistence)
import { gridCellKey } from './geo.js';
import { fetchWithTimeout } from './http.js';

// ── NIGHT WINDOWING ─────────────────────────────────────────────────────────
// A "night" runs 20:00 → 06:00 and is keyed by the date it STARTED on, so
// 23:00 Wed and 04:00 Thu belong to the same night.
function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function nightKeyOf(t) {
  const h = t.getHours();
  if (h >= 20) return dateKey(t);
  if (h <= 6) { const d = new Date(t); d.setDate(d.getDate() - 1); return dateKey(d); }
  return null; // daytime — not part of any night
}

// Upcoming night hours, each with its per-hour fog risk. This is THE single
// source that both the headline badge and the hourly strip read, so the two
// can never drift apart again.
export function nightHours(d, now) {
  const H = d.hourly;
  const out = [];
  for (let i = 0; i < H.time.length; i++) {
    const t = new Date(H.time[i]);
    if (t < now) continue;
    const key = nightKeyOf(t);
    if (!key) continue;
    out.push({
      t, key,
      hour: t.getHours(),
      temp: H.temperature_2m[i],
      risk: Math.round(nightFogRisk(
        H.temperature_2m[i] - H.dew_point_2m[i], H.relative_humidity_2m[i], H.windspeed_10m[i]))
    });
  }
  return out;
}

// Headline fog score = the WORST hour of the first upcoming night, using the
// exact same per-hour formula as the strip dots.
//
// It previously used a second, unrelated scoring formula (additive buckets) over
// a window truncated at array index 24 — so the badge routinely disagreed with
// the dots, and when checked during the day it missed 01:00–06:00 entirely,
// which is exactly when fog actually forms.
export function calcFogScore(d, now) {
  const hours = nightHours(d, now);
  if (!hours.length) return 0;
  const firstNight = hours[0].key;
  return hours.reduce((max, h) => (h.key === firstNight ? Math.max(max, h.risk) : max), 0);
}

export function fogBadge(s) {
  if (s < 30) return { lbl: 'LOW', cls: 'fog-low' };
  if (s < 60) return { lbl: 'MEDIUM', cls: 'fog-med' };
  if (s < 80) return { lbl: 'HIGH', cls: 'fog-high' };
  return { lbl: 'EXTREME', cls: 'fog-extreme' };
}

export function wmoDesc(c) {
  if (c === 0) return 'Clear sky';
  if (c <= 3) return 'Partly cloudy';
  if (c <= 49) return 'Fog / mist';
  if (c <= 67) return 'Rain';
  if (c <= 77) return 'Snow';
  if (c <= 82) return 'Showers';
  return 'Thunderstorm';
}

// Per-hour fog-risk (0–100) for the "tonight" hourly strip dots.
export function nightFogRisk(spread, rh, wind) {
  let fr = spread <= 1 ? 80 : spread <= 2 ? 50 : spread <= 4 ? 25 : 10;
  if (rh > 90) fr = Math.min(100, fr + 20);
  if (wind < 5) fr = Math.min(100, fr + 10);
  return fr;
}

const HOURLY = 'temperature_2m,relative_humidity_2m,dew_point_2m,precipitation_probability,weathercode,windspeed_10m';

export function createWeatherClient({ fetchFn = (u, o) => fetchWithTimeout(u, o, 12000), now = () => new Date(), ttlMs = 30 * 60 * 1000 } = {}) {
  const cache = new Map();   // cellKey -> {ts, promise}
  return {
    async get(lat, lon) {
      const key = gridCellKey(lat, lon);
      const hit = cache.get(key);
      if (hit && (now().getTime() - hit.ts) < ttlMs) return hit.promise;
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${HOURLY}&forecast_days=2&timezone=auto`;
      const promise = fetchFn(url).then(r => { if (!r.ok) throw new Error('wx ' + r.status); return r.json(); });
      cache.set(key, { ts: now().getTime(), promise });
      promise.catch(() => cache.delete(key)); // don't cache failures
      return promise;
    },
    clear() { cache.clear(); }
  };
}
