import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWeatherClient, nightKeyOf, nightHours, firstNight, decisionHours,
  nightExtremes, tonightRisks, buildNightChart, nightGroups, inDriveWindow,
  mergeNightHours, roadConditions, currentReadings
} from '../js/weather.js';

const firstNightHours = (fc, now) => firstNight(nightHours(fc, now));

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
  assert.equal(Math.max(...tonightRisks(nightHours(fc, now))), 100);
  assert.equal(tonightRisks(nightHours(fc, now)).length, 11); // 20:00 → 06:00
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

// A fake Open-Meteo: one object for one location, an array for several —
// like the real API.
function fakeMeteo() {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    const n = new URL(url).searchParams.get('latitude').split(',').length;
    const one = () => ({ ...buildForecast(() => MILD), elevation: 500 });
    return { ok: true, json: async () => (n === 1 ? one() : Array.from({ length: n }, one)) };
  };
  return { fetchFn, urls };
}

test('weather client: points requested together go out as ONE multi-location call', async () => {
  const { fetchFn, urls } = fakeMeteo();
  const client = createWeatherClient({ fetchFn, batchWindowMs: 5 });
  const [a, b, c] = await Promise.all([client.get(48.71, 19.11), client.get(48.95, 19.6), client.get(49.5, 21.0)]);
  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0]).searchParams.get('latitude'), '48.7100,48.9500,49.5000');
  assert.ok(a.hourly && b.hourly && c.hourly);
});

test('weather client: ~1 km cells — a road\'s valley and summit are separate, a repeat is cached', async () => {
  const { fetchFn, urls } = fakeMeteo();
  const client = createWeatherClient({ fetchFn, batchWindowMs: 1, ttlMs: 60000 });
  await client.get(48.711, 19.111);
  await client.get(48.712, 19.113); // same ~1 km cell → cached
  assert.equal(urls.length, 1);
  await client.get(48.73, 19.14);   // 2–3 km away → its own forecast
  assert.equal(urls.length, 2);
});

test('weather client does not cache failures', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; return { ok: false, status: 503 }; };
  const client = createWeatherClient({ fetchFn, ttlMs: 60000, batchWindowMs: 1 });
  await assert.rejects(client.get(48.7, 19.1));
  await new Promise(r => setTimeout(r, 0));
  await assert.rejects(client.get(48.7, 19.1));
  assert.equal(calls, 2);
});

test('mergeNightHours: worst of every point, hour by hour, and where it came from', () => {
  const now = new Date('2026-09-16T14:00:00');
  const valley = { label: 'Start', hours: nightHours(buildForecast(t => (t.getHours() === 23 ? SOUPY : MILD)), now) };
  const summit = { label: 'Summit', hours: nightHours(buildForecast(t => ({ ...MILD, temp: t.getHours() === 1 ? -3 : 4 })), now) };
  const merged = mergeNightHours([valley, summit]);
  const h23 = merged.find(h => h.hour === 23), h01 = merged.find(h => h.hour === 1);
  assert.equal(h23.risk, 100); assert.equal(h23.riskAt, 'Start');
  assert.equal(h01.temp, -3);  assert.equal(h01.tempAt, 'Summit');
  assert.equal(merged.length, valley.hours.length);
});

test('roadConditions skips points whose forecast failed, and falls back to the forecast\'s elevation', () => {
  const now = new Date('2026-09-16T14:00:00');
  const fc = { ...buildForecast(() => MILD), elevation: 812 };
  const c = roadConditions([{ label: 'Start' }, { label: 'Summit', ele: 1200 }], [fc, null], now);
  assert.equal(c.points.length, 1);
  assert.equal(c.points[0].ele, 812);
  assert.equal(roadConditions([{ label: 'Start' }], [null], now), null);
});

test('currentReadings picks the coldest point right now', () => {
  const now = new Date('2026-09-16T14:30:00');
  const warm = buildForecast(() => ({ ...MILD, temp: 9 })), cold = buildForecast(() => ({ ...MILD, temp: 2 }));
  const c = roadConditions([{ label: 'Start' }, { label: 'Summit' }], [warm, cold], now);
  assert.equal(currentReadings(c, now).coldest.label, 'Summit');
});

test('mergeNightHours: riskAvg weighs each point by its share of the road', () => {
  const now = new Date('2026-09-16T14:00:00');
  const clear = nightHours(buildForecast(() => MILD), now), soup = nightHours(buildForecast(() => SOUPY), now);
  const merged = mergeNightHours([{ label: 'Start', share: 0.75, hours: clear }, { label: 'End', share: 0.25, hours: soup }]);
  assert.equal(merged[0].risk, 100);                       // worst point, for the chart
  assert.equal(merged[0].riskAvg, Math.round(0.75 * 10 + 0.25 * 100)); // share-weighted, for ranking
});

test('pointSummaries: each point\'s own worst fog and coldest hour, plus its night row', async () => {
  const { pointSummaries } = await import('../js/weather.js');
  const now = new Date('2026-09-16T14:00:00');
  const valley = buildForecast(t => (t.getHours() === 23 ? SOUPY : MILD));
  const top = buildForecast(t => ({ ...MILD, temp: t.getHours() === 1 ? -3 : 4 }));
  const s = pointSummaries(roadConditions([{ label: 'Start', share: 0.5 }, { label: 'Summit', share: 0.5 }], [valley, top], now));
  assert.deepEqual(s.map(p => [p.label, p.fog, p.temp]), [['Start', 100, 10], ['Summit', 10, -3]]);
  assert.equal(s[0].risks.length, 11);
  assert.deepEqual(s[0].hours, [20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6]);
});
