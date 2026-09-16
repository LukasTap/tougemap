import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawUrl, encodeContent } from '../js/sync.js';
import { REPO } from '../js/config.js';

// rawUrl takes no argument any more — the repo coordinates live in config.js.
test('rawUrl composes from config REPO', () => {
  assert.equal(rawUrl(), `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}/${REPO.branch}/${REPO.path}`);
});

test('encodeContent round-trips through base64 (incl. non-ASCII)', () => {
  const b64 = encodeContent({ name: 'Muránska planina', v: 2 });
  const back = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  assert.equal(back.name, 'Muránska planina');
  assert.equal(back.v, 2);
});
