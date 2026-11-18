import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapToRoad, sanitizePins, PIN_TYPES, MAX_PIN_OFFSET_KM, PIN_NOTE_MAX } from '../js/pins.js';
import { migrate } from '../js/store.js';
import { sampleAlong } from '../js/terrain.js';
import { haversineKm } from '../js/geo.js';

// ~11 km due north, with one bend.
const road = [
  ...Array.from({ length: 6 }, (_, i) => ({ lat: 48 + i * 0.01, lon: 19 })),
  ...Array.from({ length: 5 }, (_, i) => ({ lat: 48.05 + (i + 1) * 0.01, lon: 19 + (i + 1) * 0.01 }))
];

test('a click on the road snaps onto it with its distance along the road', () => {
  const s = snapToRoad(road, 48.03, 19);
  assert.deepEqual([s.lat, s.lon], [48.03, 19]);
  assert.ok(Math.abs(s.km - haversineKm(48, 19, 48.03, 19)) < 0.01);
  assert.ok(s.offKm < 0.001);
});

test('a click beside the road lands on the nearest point of the line, and says how far off it was', () => {
  const s = snapToRoad(road, 48.03, 19.002); // ~150 m east
  assert.equal(s.lon, 19);
  assert.ok(s.offKm > 0.1 && s.offKm < MAX_PIN_OFFSET_KM, `${s.offKm}`);
  assert.ok(snapToRoad(road, 48.03, 19.03).offKm > MAX_PIN_OFFSET_KM, 'a click 2 km away is not on the road');
});

test('pin km uses the same measure as the elevation strip', () => {
  const total = sampleAlong(road, 2).at(-1).km;
  assert.ok(Math.abs(snapToRoad(road, road.at(-1).lat, road.at(-1).lon).km - total) < 0.001);
});

test('sanitizePins: unknown types and broken positions are dropped; road order; note capped', () => {
  const pins = sanitizePins([
    { id: 'b', type: 'corner', km: 5, lat: 48.04, lon: 19, note: '  tightens  ' },
    { id: 'a', type: 'surface', km: 1, lat: 48.01, lon: 19, note: 'x'.repeat(500) },
    { id: 'c', type: 'speedtrap', km: 2, lat: 48.02, lon: 19 },
    { id: 'd', type: 'note', km: NaN, lat: 48, lon: 19 }
  ]);
  assert.deepEqual(pins.map(p => p.id), ['a', 'b']);
  assert.equal(pins[1].note, 'tightens');
  assert.equal(pins[0].note.length, PIN_NOTE_MAX);
});

test('the four pin types', () => {
  assert.deepEqual(Object.keys(PIN_TYPES), ['surface', 'wildlife', 'corner', 'note']);
});

test('pins survive a load (migrate), roads without pins gain no field', () => {
  const data = migrate({ version: 2, home: null, roads: [
    { id: 1, name: 'a', points: road, pins: [{ id: 'p', type: 'wildlife', km: 3, lat: 48.03, lon: 19, note: 'deer' }] },
    { id: 2, name: 'b', points: road }
  ] });
  assert.equal(data.roads[0].pins[0].note, 'deer');
  assert.ok(!('pins' in data.roads[1]));
});
