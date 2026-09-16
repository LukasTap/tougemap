// js/tonight-rank.js — pure ranking of the library by night conditions
import { firstNightHours, decisionHours } from './weather.js';

// Ranks on the hours actually driven (22:00–02:00, or what is left of the night
// once that is past) rather than on the whole night.
//
// Every component is now the worst case across those hours. Fog used to come
// from the whole night while rain and temperature came from a single arbitrary
// hour — the next one after `now`, which in the afternoon is an hour you will
// never drive in — so the three parts of one score described three different
// stretches of time.
export function scoreRoad(road, forecast, now) {
  const hours = decisionHours(firstNightHours(forecast, now));
  if (!hours.length) return { fog: 0, rainPct: 0, temp: null, score: Infinity };
  const fog = Math.max(...hours.map(h => h.risk));
  const rainPct = Math.max(...hours.map(h => h.precip));
  const temp = Math.min(...hours.map(h => h.temp));
  const tempPenalty = Math.max(0, 8 - temp) * 2;
  return { fog, rainPct, temp, score: fog * 1.0 + rainPct * 0.6 + tempPenalty };
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
