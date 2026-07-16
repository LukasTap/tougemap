// test/tonight-rank.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRoad, rankRoads, reachable } from '../js/tonight-rank.js';

const now = new Date('2026-07-16T18:30:00');
const clearFc = { hourly: mkHourly(15, 15, 30, 20, 0) };  // dry, warm, breezy → low fog
const foggyFc = { hourly: mkHourly(10, 9.6, 97, 2, 0) };  // fog-prone

function mkHourly(temp, dew, rh, wind, precip) {
  const time = [], T = [], D = [], R = [], W = [], P = [], C = [];
  const base = new Date('2026-07-16T18:00:00');
  for (let i = 0; i < 24; i++) {
    const t = new Date(base.getTime() + i * 3600000);
    time.push(t.toISOString().slice(0,16));
    T.push(temp); D.push(dew); R.push(rh); W.push(wind); P.push(precip); C.push(0);
  }
  return { time, temperature_2m: T, dew_point_2m: D, relative_humidity_2m: R, windspeed_10m: W, precipitation_probability: P, weathercode: C };
}

test('clear night scores better (lower) than foggy night', () => {
  const clear = scoreRoad({}, clearFc, now).score;
  const foggy = scoreRoad({}, foggyFc, now).score;
  assert.ok(clear < foggy, `clear ${clear} !< foggy ${foggy}`);
});

test('rankRoads puts clear-night road first, forecastless road last', () => {
  const a = { id: 1, name: 'Clear' }, b = { id: 2, name: 'Foggy' }, c = { id: 3, name: 'Unknown' };
  const ranked = rankRoads([{road:b,forecast:foggyFc},{road:a,forecast:clearFc},{road:c,forecast:null}], now);
  assert.deepEqual(ranked.map(r => r.id), [1, 2, 3]);
});

test('reachable respects cached drive-time', () => {
  assert.equal(reachable({ driveTimeFromHome: { minutes: 40 } }, 60), true);
  assert.equal(reachable({ driveTimeFromHome: { minutes: 80 } }, 60), false);
  assert.equal(reachable({ driveTimeFromHome: null }, 60), false);
});
