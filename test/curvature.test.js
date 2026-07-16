import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distOnEarth, circumCircleRadius, segmentWeight, buildSegments, totalCurvatureFromSegs, curvColor } from '../js/curvature.js';

test('distOnEarth ~111km per degree latitude', () => {
  assert.ok(Math.abs(distOnEarth(48, 19, 49, 19) - 111000) < 2000);
});

test('segmentWeight buckets match adamfranco levels', () => {
  assert.deepEqual(segmentWeight(20), { level: 4, weight: 2.0 });
  assert.deepEqual(segmentWeight(50), { level: 3, weight: 1.6 });
  assert.deepEqual(segmentWeight(80), { level: 2, weight: 1.3 });
  assert.deepEqual(segmentWeight(150), { level: 1, weight: 1.0 });
  assert.deepEqual(segmentWeight(400), { level: 0, weight: 0 });
});

test('circumCircleRadius of near-straight is large', () => {
  // NOTE: brief's step-1 spec used circumCircleRadius(100,100,199), but against
  // the verbatim v1 formula (L568-575) that yields ~500.6, not >1000 (c=199 is
  // not "near-straight" enough — a=100,b=100 triangle degenerates only as c->200).
  // Corrected to c=199.99 (still near-straight, matches the intended property)
  // after confirming the verbatim-ported formula itself is unchanged from v1.
  assert.ok(circumCircleRadius(100, 100, 199.99) > 1000);
});

test('a tightly curved chain scores curvature > 0; a straight chain scores 0', () => {
  const straight = [];
  for (let i = 0; i < 10; i++) straight.push([48 + i * 0.001, 19]);
  assert.equal(Math.round(totalCurvatureFromSegs(buildSegments(straight))), 0);

  const curvy = [];
  for (let i = 0; i < 20; i++) {
    const a = i * 0.4;
    curvy.push([48 + 0.0009 * Math.sin(a), 19 + 0.0009 * Math.cos(a)]);
  }
  assert.ok(totalCurvatureFromSegs(buildSegments(curvy)) > 0);
});

test('curvColor clamps low curvature to yellow', () => {
  assert.equal(curvColor(300), '#ffff00');
  assert.match(curvColor(20000), /^rgb\(/);
});
