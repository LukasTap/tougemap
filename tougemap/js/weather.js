// js/weather.js — open-meteo fetch + fog scoring (no persistence)
import { gridCellKey } from './geo.js';
import { fetchWithTimeout } from './http.js';

export function calcFogScore(d, now) {
  let max = 0;
  for (let i = 0; i < d.hourly.time.length; i++) {
    const t = new Date(d.hourly.time[i]);
    if (t <= now) continue;
    const h = t.getHours();
    if (h < 20 && h > 6) continue;
    const spread = d.hourly.temperature_2m[i] - d.hourly.dew_point_2m[i];
    const rh = d.hourly.relative_humidity_2m[i];
    const wind = d.hourly.windspeed_10m[i];
    let risk = 0;
    if (spread <= 1) risk += 40; else if (spread <= 2) risk += 30; else if (spread <= 4) risk += 15;
    if (rh > 95) risk += 25; else if (rh > 90) risk += 15; else if (rh > 85) risk += 5;
    if (wind < 5) risk += 15; else if (wind < 10) risk += 5;
    if (h >= 2 && h <= 6) risk += 10;
    max = Math.max(max, risk);
    if (i > 24) break;
  }
  return Math.min(100, max);
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
