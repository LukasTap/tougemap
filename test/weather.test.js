import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcFogScore, fogBadge, createWeatherClient, nightKeyOf, nightHours } from '../js/weather.js';

// Build a 48h forecast with per-hour conditions chosen by `at(t)`.
// Local-time stamps (no Z) so hour-of-day is unambiguous.
const MILD = { spread: 6, rh: 50, wind: 15 };     // → risk 10
const SOUPY = { spread: 0.5, rh: 95, wind: 2 };   // → 80 +20 +10 → 100
function buildForecast(at, startDay = '2026-09-16', hours = 48) {
  const time = [], temp = [], dew = [], rh = [], wind = [], precip = [], code = [];
  const base = new Date(`${startDay}T00:00:00`);
  const p = (n) => String(n).padStart(2, '0');
  for (let i = 0; i < hours; i++) {
    const t = new Date(base.getTime() + i * 3600000);
    const v = at(t);
    time.push(`${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:00`);
    temp.push(10); dew.push(10 - v.spread); rh.push(v.rh); wind.push(v.wind);
    precip.push(0); code.push(0);
  }
  return { hourly: { time, temperature_2m: temp, dew_point_2m: dew, relative_humidity_2m: rh, windspeed_10m: wind, precipitation_probability: precip, weathercode: code } };
}

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

test('a night spans midnight: 23:00 Wed and 04:00 Thu share one night key', () => {
  assert.equal(nightKeyOf(new Date('2026-09-16T23:00:00')), '2026-09-16');
  assert.equal(nightKeyOf(new Date('2026-09-17T04:00:00')), '2026-09-16');
  assert.equal(nightKeyOf(new Date('2026-09-17T12:00:00')), null); // daytime
});

// The contract that keeps badge and strip in sync: the headline IS the worst dot
// of the first night. If these ever drift apart again, this fails.
test('calcFogScore equals the worst dot of the first night', () => {
  const fc = buildForecast(() => MILD);
  const now = new Date('2026-09-16T14:00:00');
  const hrs = nightHours(fc, now);
  const firstKey = hrs[0].key;
  const worstTonight = Math.max(...hrs.filter(h => h.key === firstKey).map(h => h.risk));
  assert.equal(calcFogScore(fc, now), worstTonight);
});

// Regression: the old scorer broke out of its loop at array index 24, so a
// checked-in-the-afternoon forecast never saw tonight's 01:00–06:00 — the hours
// fog actually forms in. 03:00 tomorrow sits at index 27.
test('counts deep-night hours past the old 24-index cutoff', () => {
  const fc = buildForecast((t) => (t.getDate() === 17 && t.getHours() === 3) ? SOUPY : MILD);
  const now = new Date('2026-09-16T14:00:00');
  const hrs = nightHours(fc, now);
  assert.ok(hrs.some(h => h.hour === 3 && h.risk === 100), 'the 03:00 soup hour must be in range');
  assert.equal(calcFogScore(fc, now), 100);
});

test('scores only the first night, not the one after it', () => {
  // tonight mild; TOMORROW night soupy → the badge must still read mild.
  const fc = buildForecast((t) => (t.getDate() === 17 && t.getHours() >= 20) ? SOUPY : MILD);
  const now = new Date('2026-09-16T14:00:00');
  assert.equal(calcFogScore(fc, now), 10);
  // ...but the strip still carries that second night, for the separator to split.
  const keys = [...new Set(nightHours(fc, now).map(h => h.key))];
  assert.deepEqual(keys, ['2026-09-16', '2026-09-17']);
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
