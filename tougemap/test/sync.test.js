import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawUrl, encodeContent } from '../js/sync.js';

test('rawUrl composes correctly', () => {
  const cfg = { owner: 'lt', repo: 'tougemap', branch: 'main', path: 'roads.json' };
  assert.equal(rawUrl(cfg), 'https://raw.githubusercontent.com/lt/tougemap/main/roads.json');
});

test('encodeContent round-trips through base64 (incl. non-ASCII)', () => {
  const b64 = encodeContent({ name: 'Muránska planina', v: 2 });
  const back = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  assert.equal(back.name, 'Muránska planina');
  assert.equal(back.v, 2);
});
