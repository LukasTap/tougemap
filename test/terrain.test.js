import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleAlong, pickWeatherPoints, roadProfile, needsTerrain, computeTerrain, PROFILE_SAMPLES } from '../js/terrain.js';
import { haversineKm } from '../js/geo.js';

// A straight ~11 km line north, with points bunched at the start (like OSRM
// packing vertices into curves).
const line = [
  ...Array.from({ length: 50 }, (_, i) => ({ lat: 48 + i * 0.0002, lon: 19 })),
  { lat: 48.05, lon: 19 }, { lat: 48.1, lon: 19 }
];

test('sampleAlong spaces samples evenly by distance, keeping both ends', () => {
  const s = sampleAlong(line, 11);
  assert.equal(s.length, 11);
  assert.deepEqual([s[0].lat, s[0].lon], [48, 19]);
  assert.deepEqual([s[10].lat, s[10].lon], [48.1, 19]);
  const gaps = s.slice(1).map((p, i) => haversineKm(s[i].lat, s[i].lon, p.lat, p.lon));
  for (const g of gaps) assert.ok(Math.abs(g - gaps[0]) < 0.01, `uneven gap ${g} vs ${gaps[0]}`);
});

test('sampleAlong defaults to PROFILE_SAMPLES (50), well under the API limit of 100', () => {
  assert.equal(sampleAlong(line).length, PROFILE_SAMPLES);
});

const prof = (eles) => eles.map((ele, i) => ({ lat: 48 + i * 0.02, lon: 19, km: i * 2.2, ele }));

test('a pass: start, summit, end — in road order', () => {
  const pts = pickWeatherPoints(prof([400, 600, 900, 1200, 800, 500]));
  assert.deepEqual(pts.map(p => p.label), ['Start', 'Summit', 'End']);
  assert.equal(pts[1].ele, 1200);
});

test('a road dipping through a valley also gets its low point', () => {
  const pts = pickWeatherPoints(prof([700, 500, 300, 550, 800, 900]));
  assert.deepEqual(pts.map(p => p.label), ['Start', 'Low point', 'Summit']);
});

test('a road that starts at the top calls that point the summit', () => {
  const pts = pickWeatherPoints(prof([1300, 1100, 900, 700, 500]));
  assert.deepEqual(pts.map(p => p.label), ['Summit', 'End']);
});

test('points within ~1 km of each other collapse into one', () => {
  const tiny = [{ lat: 48, lon: 19, km: 0, ele: 500 }, { lat: 48.003, lon: 19, km: 0.3, ele: 520 }, { lat: 48.006, lon: 19, km: 0.6, ele: 510 }];
  assert.equal(pickWeatherPoints(tiny).length, 1);
});

test('without elevations: start, middle, end', () => {
  const pts = pickWeatherPoints(prof([1, 2, 3, 4, 5]).map(({ ele, ...p }) => p));
  assert.deepEqual(pts.map(p => p.label), ['Start', 'Middle', 'End']);
});

test('computeTerrain: one request of PROFILE_SAMPLES coordinates → { ele }', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    const n = new URL(url).searchParams.get('latitude').split(',').length;
    return { ok: true, json: async () => ({ elevation: Array.from({ length: n }, (_, i) => 300.4 + i) }) };
  };
  const t = await computeTerrain(line, { fetchFn });
  assert.equal(urls.length, 1);
  assert.equal(t.ele.length, PROFILE_SAMPLES);
  assert.equal(t.ele[0], 300);
});

test('computeTerrain: service down → throws (caller saves without it)', async () => {
  await assert.rejects(computeTerrain(line, { fetchFn: async () => ({ ok: false, status: 429 }) }), /429/);
});

test('roadProfile lines stored elevations up with the same samples on every device', () => {
  const ele = Array.from({ length: PROFILE_SAMPLES }, (_, i) => 400 + (i === 30 ? 900 : i));
  const road = { id: 1, points: line, terrain: { ele } };
  const prof = roadProfile(road);
  assert.equal(prof.length, PROFILE_SAMPLES);
  assert.deepEqual(prof.map(p => p.ele), ele);
  assert.deepEqual(prof.map(({ ele, ...p }) => p), sampleAlong(line, PROFILE_SAMPLES));
  assert.equal(pickWeatherPoints(prof).find(p => p.role === 'summit').ele, 1300);
  assert.equal(needsTerrain(road), false);
});

test('a road without terrain: bare samples, start/middle/end, flagged for backfill', () => {
  const road = { id: 2, points: line };
  assert.ok(roadProfile(road).every(p => p.ele === undefined));
  assert.deepEqual(pickWeatherPoints(roadProfile(road)).map(p => p.role), ['start', 'mid', 'end']);
  assert.equal(needsTerrain(road), true);
  assert.equal(needsTerrain({ id: 3, points: [] }), false);
});

test('withShares: each point covers the stretch closer to it; shares sum to 1', async () => {
  const { withShares } = await import('../js/terrain.js');
  const pts = withShares([{ km: 0, label: 'Start' }, { km: 6, label: 'Summit' }, { km: 16, label: 'End' }], 16);
  assert.deepEqual(pts.map(p => [p.fromKm, p.toKm]), [[0, 3], [3, 11], [11, 16]]);
  assert.ok(Math.abs(pts.reduce((s, p) => s + p.share, 0) - 1) < 1e-9);
  assert.equal(withShares([{ km: 4 }], 9)[0].share, 1);
});

test('splitRoadSections cuts the geometry at the share boundaries, without gaps', async () => {
  const { withShares, splitRoadSections } = await import('../js/terrain.js');
  const road = Array.from({ length: 101 }, (_, i) => ({ lat: 48 + i * 0.001, lon: 19 })); // ~11.1 km north
  const total = haversineKm(48, 19, 48.1, 19);
  const pts = withShares([{ km: 0, label: 'Start' }, { km: total / 2, label: 'Summit' }, { km: total, label: 'End' }], total);
  const secs = splitRoadSections(road, pts);
  assert.deepEqual(secs.map(s => s.point.label), ['Start', 'Summit', 'End']);
  for (let i = 1; i < secs.length; i++) assert.deepEqual(secs[i].latlngs[0], secs[i - 1].latlngs.at(-1), 'sections meet');
  assert.deepEqual(secs[0].latlngs[0], [48, 19]);
  assert.deepEqual(secs.at(-1).latlngs.at(-1), [48.1, 19]);
  const n = secs.map(s => s.latlngs.length);
  assert.ok(n[1] > n[0] && n[1] > n[2], `summit covers the middle half: ${n}`);
});
