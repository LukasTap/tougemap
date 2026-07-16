// test/geo.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, polylineKm, bearingLabel, gridCellKey, simplifyForThumbnail } from '../js/geo.js';

test('haversineKm ~ known distance (Bratislava→Košice ≈ 315 km)', () => {
  const d = haversineKm(48.1486, 17.1077, 48.7164, 21.2611);
  assert.ok(Math.abs(d - 315) < 15, `got ${d}`);
});

test('polylineKm sums segments', () => {
  const pts = [{lat:48.0,lon:19.0},{lat:48.1,lon:19.0},{lat:48.2,lon:19.0}];
  const d = polylineKm(pts);
  assert.ok(Math.abs(d - haversineKm(48.0,19.0,48.2,19.0)) < 0.5, `got ${d}`);
});

test('bearingLabel east', () => {
  assert.equal(bearingLabel(48.0, 19.0, 48.0, 20.0), 'E');
});

test('gridCellKey buckets nearby points together, far points apart', () => {
  assert.equal(gridCellKey(48.71, 19.11), gridCellKey(48.73, 19.14)); // <11km
  assert.notEqual(gridCellKey(48.7, 19.1), gridCellKey(49.5, 19.1));
});

test('simplifyForThumbnail caps point count and keeps ends', () => {
  const pts = Array.from({length: 500}, (_, i) => ({lat: 48 + i/1000, lon: 19}));
  const out = simplifyForThumbnail(pts, 40);
  assert.ok(out.length <= 40);
  assert.deepEqual(out[0], pts[0]);
  assert.deepEqual(out[out.length - 1], pts[pts.length - 1]);
});
