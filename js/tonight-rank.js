// js/tonight-rank.js — pure ranking of the library by night conditions
import { firstNight, decisionHours } from './weather.js';

// Ranks on the hours actually driven (22:00–02:00, or what is left of the night
// once that is past), each component its worst hour across those.
//
// Across the ROAD (several forecast points, terrain.js) fog and rain are
// weighted by how much of the road each point covers (riskAvg / precipAvg):
// one side of a mountain fogged in leaves most of the road drivable, and the
// ranking should say "partly", not "foggy". Temperature stays the coldest
// point: an icy stretch is a hazard wherever it is, and you meet it at speed.
export function scoreRoad(conditions) {
  const hours = decisionHours(firstNight(conditions?.hours || []));
  if (!hours.length) return { fog: 0, rainPct: 0, temp: null, score: Infinity };
  const fog = Math.max(...hours.map(h => h.riskAvg ?? h.risk));
  const rainPct = Math.max(...hours.map(h => h.precipAvg ?? h.precip));
  const temp = Math.min(...hours.map(h => h.temp));
  const tempPenalty = Math.max(0, 8 - temp) * 2;
  return { fog, rainPct, temp, score: fog * 1.0 + rainPct * 0.6 + tempPenalty };
}

// entries: [{ road, conditions }] — conditions null when no forecast could be had.
export function rankRoads(entries) {
  return entries
    .map(e => ({ road: e.road, s: e.conditions ? scoreRoad(e.conditions).score : Infinity }))
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
