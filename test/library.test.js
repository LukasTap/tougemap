import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thumbnailSvg, sortRoads, filterRoads } from '../js/library.js';

const roads = [
  { id:1, name:'Alpha', km:10, created:'2026-01-01', driveTimeFromHome:{km:150}, points:[{lat:48,lon:19},{lat:48.1,lon:19.1}], meta:{character:'technical',pavement:'good',deer:'low',notes:''} },
  { id:2, name:'Bravo', km:30, created:'2026-02-01', driveTimeFromHome:{km:40}, points:[{lat:49,lon:20},{lat:49.1,lon:20.1}], meta:{character:'flowing',pavement:'rough',deer:'high',notes:''} }
];

test('thumbnailSvg emits a polyline path', () => {
  const svg = thumbnailSvg(roads[0].points);
  assert.match(svg, /<svg/);
  assert.match(svg, /<path/);
});

test('sortRoads by distance-from-home ascending', () => {
  assert.deepEqual(sortRoads(roads, 'distance').map(r => r.id), [2, 1]);
});

test('filterRoads by character + reachableKm', () => {
  const out = filterRoads(roads, { character: 'flowing', reachableKm: 100 });
  assert.deepEqual(out.map(r => r.id), [2]);
});

test('filterRoads text query matches name', () => {
  assert.deepEqual(filterRoads(roads, { q: 'alph' }).map(r => r.id), [1]);
});
