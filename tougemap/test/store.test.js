import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, normalizeRoad, emptyData, SCHEMA_VERSION, META_DEFAULT } from '../js/store.js';

const V1 = {
  version: 1,
  home: { lat: 48.7, lon: 19.1 },
  roads: [{ id: 111, name: 'Old Road', points: [{lat:48.7,lon:20.0},{lat:48.75,lon:20.1}], color:'#b000ff', km: 12.3, saved: '16. 7. 2026' }]
};

test('migrate v1 → v2 shape', () => {
  const out = migrate(V1);
  assert.equal(out.version, SCHEMA_VERSION);
  assert.deepEqual(out.home, { lat: 48.7, lon: 19.1 });
  const r = out.roads[0];
  assert.equal(r.id, 111);
  assert.equal(r.name, 'Old Road');
  assert.equal(r.created, '16. 7. 2026');      // saved → created
  assert.ok(!('color' in r));                    // color dropped
  assert.deepEqual(r.meta, META_DEFAULT);        // meta seeded
  assert.equal(r.driveTimeFromHome, null);
});

test('migrate accepts bare array', () => {
  const out = migrate(V1.roads);
  assert.equal(out.version, SCHEMA_VERSION);
  assert.equal(out.roads.length, 1);
});

test('migrate is idempotent on v2', () => {
  const once = migrate(V1);
  const twice = migrate(once);
  assert.deepEqual(twice, once);
});

test('normalizeRoad computes km when missing', () => {
  const r = normalizeRoad({ id: 1, name: 'X', points: [{lat:48.0,lon:19.0},{lat:48.1,lon:19.0}] });
  assert.ok(r.km > 10 && r.km < 12, `got ${r.km}`);
});

test('emptyData', () => {
  assert.deepEqual(emptyData(), { version: 2, home: null, roads: [] });
});
