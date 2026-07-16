import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcFogScore, fogBadge, createWeatherClient } from '../js/weather.js';

function fakeForecast() {
  // build a forecast whose next night hour has tiny dew spread + high RH + calm wind
  const times = [], temp = [], dew = [], rh = [], wind = [];
  const base = new Date('2026-07-16T18:00:00');
  for (let i = 0; i < 24; i++) {
    const t = new Date(base.getTime() + i * 3600000);
    times.push(t.toISOString().slice(0,16));
    const night = t.getHours() >= 20 || t.getHours() <= 6;
    temp.push(10); dew.push(night ? 9.5 : 4); rh.push(night ? 97 : 60); wind.push(night ? 2 : 15);
  }
  return { hourly: { time: times, temperature_2m: temp, dew_point_2m: dew, relative_humidity_2m: rh, windspeed_10m: wind } };
}

test('calcFogScore high for calm humid night', () => {
  const score = calcFogScore(fakeForecast(), new Date('2026-07-16T18:30:00'));
  assert.ok(score >= 60, `got ${score}`);
});

test('fogBadge thresholds', () => {
  assert.equal(fogBadge(10).lbl, 'LOW');
  assert.equal(fogBadge(45).lbl, 'MEDIUM');
  assert.equal(fogBadge(70).lbl, 'HIGH');
  assert.equal(fogBadge(90).lbl, 'EXTREME');
});

test('weather client caches within TTL and dedups grid cells', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; return { ok: true, json: async () => fakeForecast() }; };
  const client = createWeatherClient({ fetchFn, now: () => new Date('2026-07-16T18:30:00'), ttlMs: 60000 });
  await client.get(48.71, 19.11);
  await client.get(48.73, 19.14); // same ~10km cell → no new call
  assert.equal(calls, 1);
  await client.get(49.5, 21.0);   // far → new call
  assert.equal(calls, 2);
});
