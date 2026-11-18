import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRepo } from '../js/repo.js';

const AUTH = { token: 't', passphrase: 'p' };
const lib = (...names) => ({ version: 2, home: null, roads: names.map((name, i) => ({ id: i + 1, name })) });

function makeRepo({ source = 'remote', sha = 'sha0', data = lib('A', 'B'), write, online = () => true } = {}) {
  const writes = [];
  const repo = createRepo({
    read: async () => ({ data, sha, source }),
    write: write || (async (auth, next, baseSha) => { writes.push({ next: structuredClone(next), baseSha }); return `sha${writes.length}`; }),
    online
  });
  return { repo, writes };
}

test('commit writes a copy, then adopts it', async () => {
  const { repo, writes } = makeRepo();
  await repo.load(AUTH);
  const before = repo.data;
  await repo.commit(AUTH, next => { next.roads[0].name = 'A2'; });
  assert.equal(repo.data.roads[0].name, 'A2');
  assert.equal(before.roads[0].name, 'A', 'the previous object was never mutated');
  assert.equal(writes[0].baseSha, 'sha0');
});

test('a failed write leaves the library exactly as it was', async () => {
  const { repo } = makeRepo({ write: async () => { throw new Error('write 500'); } });
  await repo.load(AUTH);
  await assert.rejects(repo.commit(AUTH, next => { next.roads.splice(0, 1); }), /500/);
  assert.deepEqual(repo.data.roads.map(r => r.name), ['A', 'B']);
});

test('queued commits apply in order, each pinned to the previous write\'s sha', async () => {
  const { repo, writes } = makeRepo();
  await repo.load(AUTH);
  await Promise.all([
    repo.commit(AUTH, next => { next.roads.push({ id: 3, name: 'C' }); }),
    repo.commit(AUTH, next => { next.roads.push({ id: 4, name: 'D' }); })
  ]);
  assert.deepEqual(writes.map(w => w.baseSha), ['sha0', 'sha1']);
  assert.deepEqual(repo.data.roads.map(r => r.name), ['A', 'B', 'C', 'D']);
});

test('one failed commit does not jam the queue', async () => {
  let n = 0;
  const { repo } = makeRepo({ write: async () => { if (n++ === 0) throw new Error('boom'); return 'ok'; } });
  await repo.load(AUTH);
  await assert.rejects(repo.commit(AUTH, next => { next.roads.push({ id: 9, name: 'X' }); }));
  await repo.commit(AUTH, next => { next.roads.push({ id: 10, name: 'Y' }); });
  assert.deepEqual(repo.data.roads.map(r => r.name), ['A', 'B', 'Y']);
});

for (const [label, opts, auth] of [
  ['offline copy (cache)', { source: 'cache' }, AUTH],
  ['failed load (none)', { source: 'none', data: lib() }, AUTH],
  ['dev fixture', { source: 'fixture' }, AUTH],
  ['no token', {}, { passphrase: 'p' }],
  ['offline', { online: () => false }, AUTH]
]) {
  test(`writes are refused: ${label}`, async () => {
    const { repo, writes } = makeRepo(opts);
    await repo.load(auth);
    assert.ok(repo.writeBlock(auth));
    await assert.rejects(repo.commit(auth, next => { next.roads = []; }));
    assert.equal(writes.length, 0, 'nothing reached GitHub');
  });
}

test('a lock error on load leaves the previous state in place', async () => {
  let calls = 0;
  const repo = createRepo({
    read: async () => {
      if (calls++ === 0) return { data: lib('A'), sha: 's', source: 'remote' };
      const e = new Error('Wrong passphrase'); e.code = 'BAD_PASSPHRASE'; throw e;
    },
    write: async () => 'x', online: () => true
  });
  await repo.load(AUTH);
  await assert.rejects(repo.load(AUTH), { code: 'BAD_PASSPHRASE' });
  assert.equal(repo.data.roads[0].name, 'A');
  assert.equal(repo.source, 'remote');
});
