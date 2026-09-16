// js/tonight-rank.js — pure ranking of the library by night conditions
import { calcFogScore } from './weather.js';

function nextNightIndex(d, now) {
  return d.hourly.time.findIndex(t => new Date(t) > now);
}

// First forecast index that is both after `now` AND within the night window
// (20:00–06:00), matching calcFogScore's window. Falls back to the plain
// next-hour index if no night hour is present in the data.
function nextNightHourIndex(d, now) {
  const idx = d.hourly.time.findIndex(t => {
    const dt = new Date(t);
    if (dt <= now) return false;
    const h = dt.getHours();
    return h >= 20 || h <= 6;
  });
  return idx >= 0 ? idx : nextNightIndex(d, now);
}

export function scoreRoad(road, forecast, now) {
  const ni = nextNightHourIndex(forecast, now);
  const fog = calcFogScore(forecast, now);
  const rainPct = ni >= 0 ? (forecast.hourly.precipitation_probability?.[ni] ?? 0) : 0;
  const temp = ni >= 0 ? forecast.hourly.temperature_2m[ni] : 15;
  const tempPenalty = Math.max(0, 8 - temp) * 2;
  const score = fog * 1.0 + rainPct * 0.6 + tempPenalty;
  return { fog, rainPct, temp, score };
}

export function rankRoads(entries, now) {
  return entries
    .map(e => ({ road: e.road, s: e.forecast ? scoreRoad(e.road, e.forecast, now).score : Infinity }))
    .sort((a, b) => a.s - b.s)
    .map(x => x.road);
}

// Reachable within maxKm by ROAD distance from home. Distance is the metric we
// trust; the old version filtered on drive-time and, failing that, guessed
// minutes from km at ~50 km/h — exactly the unreliable estimate we dropped.
export function reachable(road, maxKm) {
  const km = road.driveTimeFromHome?.km;
  return typeof km === 'number' && km <= maxKm;
}
