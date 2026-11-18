import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawUrl, apiUrl, encodeContent, gitBlobSha, readRoads, writeRoads } from '../js/sync.js';
import { encryptData, decryptData } from '../js/crypto.js';
import { REPO } from '../js/config.js';

const DATA = { version: 2, home: null, roads: [{ id: 7, name: 'Test', points: [{ lat: 48, lon: 19 }, { lat: 48.1, lon: 19.1 }], km: 13.4, created: '2026-01-01', driveTimeFromHome: null, meta: { pavement: null, character: null, deer: null, notes: '' } }] };
const bytesOf = (obj) => new TextEncoder().encode(JSON.stringify(obj, null, 2));

// A fetch that serves `routes` by URL prefix and records every call.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    for (const [prefix, handler] of routes) if (url.startsWith(prefix)) return handler(url, opts);
    throw new Error('network down: ' + url);
  };
  fn.calls = calls;
  return fn;
}
const fileResponse = (bytes) => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
const status = (code) => ({ ok: false, status: code });

test('rawUrl / apiUrl compose from config REPO', () => {
  assert.equal(rawUrl(), `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}/${REPO.branch}/${REPO.path}`);
  assert.equal(apiUrl(), `https://api.github.com/repos/${REPO.owner}/${REPO.repo}/contents/${REPO.path}`);
});

test('encodeContent round-trips through base64 (incl. non-ASCII)', () => {
  const back = JSON.parse(Buffer.from(encodeContent({ name: 'Muránska planina' }), 'base64').toString('utf8'));
  assert.equal(back.name, 'Muránska planina');
});

test('gitBlobSha matches `git hash-object`', async () => {
  // printf 'hello\n' | git hash-object --stdin
  assert.equal(await gitBlobSha(new TextEncoder().encode('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('without a token: reads through the API anonymously (fresh within ~60 s) and records the sha', async () => {
  const bytes = bytesOf(DATA);
  const fetchFn = fakeFetch([[apiUrl(), () => fileResponse(bytes)]]);
  const res = await readRoads({}, { fetchFn });
  assert.equal(res.source, 'remote');
  assert.equal(res.sha, await gitBlobSha(bytes));
  assert.equal(res.data.roads[0].name, 'Test');
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(fetchFn.calls[0].opts.headers.Authorization, undefined);
  assert.equal(fetchFn.calls[0].opts.headers.Accept, 'application/vnd.github.raw+json');
});

test('without a token: anonymous API allowance used up (403) → public raw file, no notice', async () => {
  const bytes = bytesOf(DATA);
  const fetchFn = fakeFetch([[apiUrl(), () => status(403)], [rawUrl(), () => fileResponse(bytes)]]);
  const res = await readRoads({}, { fetchFn });
  assert.equal(res.source, 'remote');
  assert.equal(res.sha, await gitBlobSha(bytes));
  assert.equal(res.notice, null);
});

test('with a token: reads through the API (raw media type), not the CDN', async () => {
  const bytes = bytesOf(DATA);
  const fetchFn = fakeFetch([[apiUrl(), () => fileResponse(bytes)]]);
  const res = await readRoads({ token: 't0k' }, { fetchFn });
  assert.equal(res.source, 'remote');
  const { opts } = fetchFn.calls[0];
  assert.equal(opts.headers.Authorization, 'Bearer t0k');
  assert.equal(opts.headers.Accept, 'application/vnd.github.raw+json');
});

test('a rejected token falls back to the public file, with a notice', async () => {
  const bytes = bytesOf(DATA);
  const fetchFn = fakeFetch([[apiUrl(), () => status(401)], [rawUrl(), () => fileResponse(bytes)]]);
  const res = await readRoads({ token: 'expired' }, { fetchFn });
  assert.equal(res.source, 'remote');
  assert.match(res.notice, /token/i);
});

test('GitHub unreachable and nothing cached → source "none", NOT a writable empty library', async () => {
  const res = await readRoads({}, { fetchFn: fakeFetch([]) });
  assert.equal(res.source, 'none');
  assert.deepEqual(res.data.roads, []);
  assert.ok(res.error);
});

test('HTTP error → source "none" too', async () => {
  const res = await readRoads({}, { fetchFn: fakeFetch([[apiUrl(), () => status(503)], [rawUrl(), () => status(503)]]) });
  assert.equal(res.source, 'none');
});

test('file does not exist yet (404) → empty but remote, so the first save can create it', async () => {
  const res = await readRoads({}, { fetchFn: fakeFetch([[apiUrl(), () => status(404)], [rawUrl(), () => status(404)]]) });
  assert.equal(res.source, 'remote');
  assert.equal(res.sha, null);
});

test('encrypted file: no passphrase / wrong passphrase / right passphrase', async () => {
  const bytes = bytesOf(await encryptData(DATA, 'pw'));
  const fetchFn = () => fakeFetch([[apiUrl(), () => fileResponse(bytes)]]);
  await assert.rejects(readRoads({}, { fetchFn: fetchFn() }), { code: 'ENCRYPTED_NO_PASS' });
  await assert.rejects(readRoads({ passphrase: 'nope' }, { fetchFn: fetchFn() }), { code: 'BAD_PASSPHRASE' });
  const res = await readRoads({ passphrase: 'pw' }, { fetchFn: fetchFn() });
  assert.equal(res.data.roads[0].name, 'Test');
});

test('write: PUTs the encrypted envelope pinned to the loaded sha, returns the new sha', async () => {
  let sent;
  const fetchFn = fakeFetch([[apiUrl(), (url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ content: { sha: 'newsha' } }) };
  }]]);
  const sha = await writeRoads({ token: 't', passphrase: 'pw' }, DATA, 'basesha', { fetchFn });
  assert.equal(sha, 'newsha');
  assert.equal(fetchFn.calls[0].opts.method, 'PUT');
  assert.equal(sent.sha, 'basesha');
  const envelope = JSON.parse(Buffer.from(sent.content, 'base64').toString('utf8'));
  assert.equal(envelope.z, 'gzip');
  assert.deepEqual(await decryptData(envelope, 'pw'), DATA);
});

test('write: a stale sha (409) is a CONFLICT — no retry with a fresher sha', async () => {
  const fetchFn = fakeFetch([[apiUrl(), () => status(409)]]);
  await assert.rejects(writeRoads({ token: 't' }, DATA, 'stale', { fetchFn }), { code: 'CONFLICT' });
  assert.equal(fetchFn.calls.length, 1);
});

test('write: no token → refused before any network call', async () => {
  const fetchFn = fakeFetch([]);
  await assert.rejects(writeRoads({}, DATA, 'x', { fetchFn }), /token/i);
  assert.equal(fetchFn.calls.length, 0);
});
