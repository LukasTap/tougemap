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

test('metaChipsHtml escapes tag values', async () => {
  const { metaChipsHtml } = await import('../js/library.js');
  const html = metaChipsHtml({ pavement: '"><img src=x onerror=alert(1)>', character: '<b>x</b>' });
  assert.doesNotMatch(html, /<img|<b>/);
});

test('thumbnailSvg tolerates a road with no geometry', () => {
  assert.match(thumbnailSvg([]), /<svg/);
});

test('fogStripHtml draws one row per point, one cell per hour, each row marked', async () => {
  const { fogStripHtml } = await import('../js/library.js');
  const hours = [20, 21];
  const html = fogStripHtml([
    { label: 'Start', role: 'start', risks: [10, 20], hours },
    { label: 'Summit', role: 'summit', risks: [90, 95], hours },
    { label: 'End', role: 'end', risks: [10, 10], hours }]);
  assert.equal((html.match(/class="fog-row"/g) || []).length, 3);
  assert.equal((html.match(/<i /g) || []).length, 6);
  assert.match(html, /fog-strip multi/);
  assert.deepEqual([...html.matchAll(/class="fog-mark"[^>]*>([^<]+)</g)].map(m => m[1]), ['S', '▲', 'E']);
  assert.doesNotMatch(html, /fog-window/, 'no driving-window hours in 20–21');
  assert.match(fogStripHtml(null), /no forecast/);
});

const night = [20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6];
const row = (hours) => [{ label: 'Start', role: 'start', risks: hours.map(() => 10), hours }];

test('the driving window is bracketed by two lines at 22:00 and 02:00', async () => {
  const { fogStripHtml } = await import('../js/library.js');
  const html = fogStripHtml(row(night));
  const box = html.match(/class="fog-window-box([^"]*)" style="left:([0-9.]+)%;width:([0-9.]+)%"/);
  assert.ok(box, html);
  assert.equal(box[1].trim(), 'l r');
  assert.equal(Number(box[2]), +(2 / 11 * 100).toFixed(2)); // starts at the 22:00 cell
  assert.equal(Number(box[3]), +(5 / 11 * 100).toFixed(2)); // 22, 23, 00, 01, 02
});

test('once 22:00 has passed the left line goes; after 02:00 there is no window', async () => {
  const { fogStripHtml } = await import('../js/library.js');
  const open = fogStripHtml(row(night.slice(4))).match(/class="fog-window-box([^"]*)"/);
  assert.equal(open[1].trim(), 'r');
  assert.doesNotMatch(fogStripHtml(row([3, 4, 5, 6])), /fog-window/);
});
