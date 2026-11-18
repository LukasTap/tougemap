import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWeatherClient, nightKeyOf, nightHours, firstNightHours, decisionHours,
  nightExtremes, tonightRisks, buildNightChart, nightGroups, inDriveWindow
} from '../js/weather.js';

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
    temp.push(v.temp ?? 10); dew.push((v.temp ?? 10) - v.spread); rh.push(v.rh); wind.push(v.wind);
    precip.push(v.precip ?? 0); code.push(0);
  }
  return { hourly: { time, temperature_2m: temp, dew_point_2m: dew, relative_humidity_2m: rh, windspeed_10m: wind, precipitation_probability: precip, weathercode: code } };
}
const worst = (hours) => Math.max(...hours.map(h => h.risk));

test('a night spans midnight: 23:00 Wed and 04:00 Thu share one night key', () => {
  assert.equal(nightKeyOf(new Date('2026-09-16T23:00:00')), '2026-09-16');
  assert.equal(nightKeyOf(new Date('2026-09-17T04:00:00')), '2026-09-16');
  assert.equal(nightKeyOf(new Date('2026-09-17T12:00:00')), null); // daytime
});

test('drive window is 22:00–02:00 inclusive', () => {
  assert.deepEqual([20, 21, 22, 23, 0, 1, 2, 3, 6].map(inDriveWindow),
    [false, false, true, true, true, true, true, false, false]);
});

// Regression: the old scorer broke out of its loop at array index 24, so a
// checked-in-the-afternoon forecast never saw tonight's 01:00–06:00 — the hours
// fog actually forms in. 03:00 tomorrow sits at index 27.
test('sees deep-night hours past the old 24-index cutoff', () => {
  const fc = buildForecast((t) => (t.getDate() === 17 && t.getHours() === 3) ? SOUPY : MILD);
  const now = new Date('2026-09-16T14:00:00');
  const hrs = firstNightHours(fc, now);
  assert.ok(hrs.some(h => h.hour === 3 && h.risk === 100), 'the 03:00 soup hour must be in range');
  assert.equal(worst(hrs), 100);
});

test('decision numbers use the driving window, the strip uses the whole night', () => {
  // Soup only at 05:00: real, but outside 22–02 → the decision stays mild.
  const fc = buildForecast((t) => (t.getDate() === 17 && t.getHours() === 5) ? SOUPY : MILD);
  const now = new Date('2026-09-16T14:00:00');
  assert.equal(worst(decisionHours(firstNightHours(fc, now))), 10);
  assert.equal(Math.max(...tonightRisks(fc, now)), 100);
  assert.equal(tonightRisks(fc, now).length, 11); // 20:00 → 06:00
});

test('after the window has passed, decisions fall back to what is left of the night', () => {
  const fc = buildForecast((t) => (t.getDate() === 17 && t.getHours() === 4) ? SOUPY : MILD);
  const now = new Date('2026-09-17T03:30:00');
  const hours = decisionHours(firstNightHours(fc, now));
  assert.deepEqual(hours.map(h => h.hour), [4, 5, 6]);
  assert.equal(worst(hours), 100);
});

test('scores only the first night; the second is kept for the chart', () => {
  const fc = buildForecast((t) => (t.getDate() === 17 && t.getHours() >= 20) ? SOUPY : MILD);
  const now = new Date('2026-09-16T14:00:00');
  assert.equal(worst(firstNightHours(fc, now)), 10);
  assert.deepEqual(nightGroups(nightHours(fc, now)).map(g => g.key), ['2026-09-16', '2026-09-17']);
});

test('nightExtremes picks the dangerous end of each stat', () => {
  const fc = buildForecast((t) => ({ ...MILD, temp: t.getHours() === 1 ? -2 : 6, wind: t.getHours() === 23 ? 1 : 15 }));
  const ext = nightExtremes(firstNightHours(fc, new Date('2026-09-16T14:00:00')));
  assert.equal(ext.coldest.hour, 1);
  assert.equal(ext.calmest.hour, 23);
});

test('night chart: one temperature scale, freezing line shown when 0°C is in range', () => {
  const fc = buildForecast((t) => ({ ...MILD, temp: t.getHours() >= 23 || t.getHours() <= 6 ? -1 : 4 }));
  const chart = buildNightChart(nightGroups(nightHours(fc, new Date('2026-09-16T14:00:00'))));
  assert.equal(chart.segments.length, 2);
  assert.ok(chart.temp.showFreeze);
  assert.ok(chart.temp.lo < 0 && chart.temp.hi > 0);
});

test('weather client caches within TTL and dedups grid cells', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; return { ok: true, json: async () => buildForecast(() => MILD) }; };
  const client = createWeatherClient({ fetchFn, now: () => new Date('2026-07-16T18:30:00'), ttlMs: 60000 });
  await client.get(48.71, 19.11);
  await client.get(48.73, 19.14); // same ~10km cell → no new call
  assert.equal(calls, 1);
  await client.get(49.5, 21.0);   // far → new call
  assert.equal(calls, 2);
});

test('weather client does not cache failures', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; return { ok: false, status: 503 }; };
  const client = createWeatherClient({ fetchFn, ttlMs: 60000 });
  await assert.rejects(client.get(48.7, 19.1));
  await new Promise(r => setTimeout(r, 0));
  await assert.rejects(client.get(48.7, 19.1));
  assert.equal(calls, 2);
});
