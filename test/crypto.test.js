import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptData, decryptData, isEncrypted, PBKDF2_ITERATIONS, LEGACY_ITERATIONS } from '../js/crypto.js';

const SAMPLE = { version: 2, home: { lat: 48.1, lon: 19.1 }, roads: [{ id: 1, name: 'Muránska planina', points: [{ lat: 48.7, lon: 20.0 }] }] };

test('round-trips, with gzip and the current iteration count recorded', async () => {
  const env = await encryptData(SAMPLE, 'correct horse');
  assert.ok(isEncrypted(env));
  assert.equal(env.z, 'gzip');
  assert.equal(env.iter, PBKDF2_ITERATIONS);
  assert.deepEqual(await decryptData(env, 'correct horse'), SAMPLE);
});

test('wrong passphrase throws', async () => {
  const env = await encryptData(SAMPLE, 'correct horse');
  await assert.rejects(decryptData(env, 'wrong horse'));
});

test('fresh salt and iv every time', async () => {
  const a = await encryptData(SAMPLE, 'p'), b = await encryptData(SAMPLE, 'p');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
});

// The file on GitHub today was written by the old code: 150k iterations, no
// gzip, and no `iter`/`z` fields. It must keep opening.
test('decrypts the legacy envelope format', async () => {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', enc.encode('old pass'), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: LEGACY_ITERATIONS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(SAMPLE)));
  const b64 = (u8) => Buffer.from(u8).toString('base64');
  const legacy = { tougemap_encrypted: 1, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) };
  assert.deepEqual(await decryptData(legacy, 'old pass'), SAMPLE);
});

test('gzip keeps road geometry small', async () => {
  const points = Array.from({ length: 5000 }, (_, i) => ({ lat: 48 + Math.sin(i / 50) * 0.1, lon: 19 + i / 10000 }));
  const data = { version: 2, home: null, roads: [{ id: 1, name: 'Long', points }] };
  const env = await encryptData(data, 'p');
  const plainSize = JSON.stringify(data).length;
  assert.ok(env.ct.length < plainSize / 2, `ct ${env.ct.length} vs plain ${plainSize}`);
});
