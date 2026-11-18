// The service worker's precache list must name every module the app loads, or
// a first visit followed by going offline can't boot (js/http.js was missing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const shell = [...sw.matchAll(/'\.\/(js\/[\w-]+\.js)'/g)].map(m => m[1]);

test('every js/ module is in the service worker SHELL', () => {
  const modules = readdirSync(new URL('../js/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => `js/${f}`);
  assert.deepEqual([...modules].sort(), [...new Set(shell)].sort());
});

test('index.html loads the same Leaflet build the worker precaches, with SRI', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const url of [...sw.matchAll(/'(https:\/\/cdn\.jsdelivr\.net[^']+)'/g)].map(m => m[1])) {
    const tag = html.split('\n').join(' ').match(new RegExp(`[^<]*${url.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[^>]*>`));
    assert.ok(tag, `index.html should reference ${url}`);
    assert.match(tag[0], /integrity="sha256-/);
    assert.match(tag[0], /crossorigin="anonymous"/);
  }
});
