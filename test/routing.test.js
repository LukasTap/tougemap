import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOsrmUrl, parseOsrmRoute, airFallback, nearestPoint } from '../js/routing.js';

test('buildOsrmUrl orders lon,lat and joins with ;', () => {
  const url = buildOsrmUrl([{lat:48.1,lon:17.1},{lat:48.7,lon:21.2}]);
  assert.match(url, /driving\/17\.1,48\.1;21\.2,48\.7/);
});

test('parseOsrmRoute extracts km, minutes, points', () => {
  const json = { code:'Ok', routes:[{ distance: 61000, duration: 3120, geometry:{ coordinates:[[17.1,48.1],[21.2,48.7]] } }] };
  const r = parseOsrmRoute(json);
  assert.equal(r.km, 61);
  assert.equal(r.minutes, 52);
  assert.deepEqual(r.points[0], { lat: 48.1, lon: 17.1 });
});

test('parseOsrmRoute returns null on non-Ok', () => {
  assert.equal(parseOsrmRoute({ code: 'NoRoute', routes: [] }), null);
});

test('nearestPoint finds closest vertex', () => {
  const { point } = nearestPoint(48.70, 19.10, [{lat:49.0,lon:20.0},{lat:48.71,lon:19.11}]);
  assert.deepEqual(point, { lat: 48.71, lon: 19.11 });
});
