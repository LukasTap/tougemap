// test/tonight-rank.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRoad, rankRoads, reachable } from '../js/tonight-rank.js';
import { roadConditions } from '../js/weather.js';

const now = new Date('2026-07-16T18:30:00');
const clearFc = { hourly: mkHourly(15, 15, 30, 20, 0) };  // dry, warm, breezy → low fog
const foggyFc = { hourly: mkHourly(10, 9.6, 97, 2, 0) };  // fog-prone

function mkHourly(temp, dew, rh, wind, precip) {
  const time = [], T = [], D = [], R = [], W = [], P = [], C = [];
  const base = new Date('2026-07-16T18:00:00');
  const p = (n) => String(n).padStart(2, '0');
  for (let i = 0; i < 24; i++) {
    const t = new Date(base.getTime() + i * 3600000);
    time.push(`${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:00`);
    T.push(temp); D.push(dew); R.push(rh); W.push(wind); P.push(precip); C.push(0);
  }
  return { time, temperature_2m: T, dew_point_2m: D, relative_humidity_2m: R, windspeed_10m: W, precipitation_probability: P, weathercode: C };
}
const cond = (...fcs) => roadConditions(fcs.map((_, i) => ({ label: `P${i}` })), fcs, now);

test('clear night scores better (lower) than foggy night', () => {
  assert.ok(scoreRoad(cond(clearFc)).score < scoreRoad(cond(foggyFc)).score);
});

test('a road is scored on its WORST point: clear valley + fogged summit = foggy', () => {
  assert.equal(scoreRoad(cond(clearFc, foggyFc)).fog, scoreRoad(cond(foggyFc)).fog);
});

test('rankRoads puts clear-night road first, forecastless road last', () => {
  const a = { id: 1, name: 'Clear' }, b = { id: 2, name: 'Foggy' }, c = { id: 3, name: 'Unknown' };
  const ranked = rankRoads([{ road: b, conditions: cond(foggyFc) }, { road: a, conditions: cond(clearFc) }, { road: c, conditions: null }]);
  assert.deepEqual(ranked.map(r => r.id), [1, 2, 3]);
});

test('reachable filters by road distance (km) from home', () => {
  assert.equal(reachable({ driveTimeFromHome: { km: 40 } }, 100), true);
  assert.equal(reachable({ driveTimeFromHome: { km: 180 } }, 100), false);
  assert.equal(reachable({ driveTimeFromHome: { km: 100 } }, 100), true); // boundary inclusive
  assert.equal(reachable({ driveTimeFromHome: null }, 100), false);
  // drive-time alone is no longer enough — km is the metric
  assert.equal(reachable({ driveTimeFromHome: { minutes: 30 } }, 100), false);
});
