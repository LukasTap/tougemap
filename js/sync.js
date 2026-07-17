// js/sync.js — GitHub read (public raw) + write (token), with the roads library
// encrypted at rest (see crypto.js) so the public repo holds only gibberish.
// Repo coordinates come from config.js (baked in, not asked on every visit).
import { migrate, emptyData, cacheRead, cacheWrite } from './store.js';
import { fetchWithTimeout } from './http.js';
import { REPO } from './config.js';
import { isEncrypted, encryptData, decryptData } from './crypto.js';

const defaultFetch = (u, o) => fetchWithTimeout(u, o, 15000);
const API = 'https://api.github.com';
const TOKEN_KEY = 'tougemap_token';
const PASS_KEY = 'tougemap_pass';

// ── Local auth: token = write credential (PC only), passphrase = decrypt key.
// Both live only in this device's localStorage — never committed or in a URL.
export function loadAuth() {
  return { token: localStorage.getItem(TOKEN_KEY) || null, passphrase: localStorage.getItem(PASS_KEY) || null };
}
export function saveToken(t) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }
export function savePassphrase(p) { p ? localStorage.setItem(PASS_KEY, p) : localStorage.removeItem(PASS_KEY); }
export function clearToken() { localStorage.removeItem(TOKEN_KEY); }
export function clearPassphrase() { localStorage.removeItem(PASS_KEY); }

export function rawUrl() {
  return `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}/${REPO.branch}/${REPO.path}`;
}

export function encodeContent(obj) {
  const json = JSON.stringify(obj, null, 2);
  if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(json)));
  return Buffer.from(json, 'utf8').toString('base64'); // Node/test path
}

// Fetch + parse the raw file (encrypted envelope OR plaintext). Throws on network/HTTP error.
async function fetchRaw(fetchFn) {
  const res = await fetchFn(rawUrl() + '?t=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error('read ' + res.status);
  return res.json();
}

// Parsed file → plain v2 data, decrypting when needed. Throws Error with a `code`
// of 'ENCRYPTED_NO_PASS' (locked, no passphrase) or 'BAD_PASSPHRASE' (wrong one)
// so the UI can prompt. Plaintext files pass straight through (transition state).
async function toPlain(raw, passphrase) {
  if (isEncrypted(raw)) {
    if (!passphrase) { const e = new Error('Locked — passphrase required'); e.code = 'ENCRYPTED_NO_PASS'; throw e; }
    let plain;
    try { plain = await decryptData(raw, passphrase); }
    catch { const e = new Error('Wrong passphrase'); e.code = 'BAD_PASSPHRASE'; throw e; }
    return migrate(plain);
  }
  return migrate(raw);
}

export async function readRoads(auth = {}, { fetchFn = defaultFetch } = {}) {
  let raw;
  try { raw = await fetchRaw(fetchFn); }
  catch { return (await cacheRead()) || emptyData(); } // offline/HTTP error → last good cache
  const data = await toPlain(raw, auth.passphrase); // lock errors bubble up to the caller
  await cacheWrite(data);
  return data;
}

async function currentSha(token, fetchFn) {
  const url = `${API}/repos/${REPO.owner}/${REPO.repo}/contents/${REPO.path}?ref=${REPO.branch}`;
  // cache: 'no-store' is essential — a browser-cached GET returns a STALE sha,
  // making every PUT 409 forever ("does not match").
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (res.status === 404) return null; // file doesn't exist yet
  if (!res.ok) throw new Error('sha ' + res.status);
  return (await res.json()).sha;
}

async function putContent(token, payload, sha, fetchFn) {
  const url = `${API}/repos/${REPO.owner}/${REPO.repo}/contents/${REPO.path}`;
  // Generic commit message — deliberately does NOT include the road count, to
  // avoid leaking metadata about an otherwise-encrypted file.
  const body = { message: 'Update roads', content: encodeContent(payload), branch: REPO.branch, ...(sha ? { sha } : {}) };
  return fetchFn(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Does the remote already hold exactly our data? (Decrypts the remote first, so
// it works despite each encryption using a random iv/salt.) Turns a lost sha-race
// into a success instead of a false error.
async function remoteMatches(auth, data, fetchFn) {
  try {
    const plain = await toPlain(await fetchRaw(fetchFn), auth.passphrase);
    return JSON.stringify(plain) === JSON.stringify(migrate(data));
  } catch { return false; }
}

// Serialize writes so two rapid saves never race the same sha.
let writeChain = Promise.resolve();

export function writeRoads(auth, data, opts = {}) {
  const run = writeChain.then(() => doWriteRoads(auth, data, opts));
  writeChain = run.then(() => {}, () => {});
  return run;
}

async function doWriteRoads(auth = {}, data, { fetchFn = defaultFetch } = {}) {
  if (!auth.token) throw new Error('No GitHub token configured');
  // Encrypt once (if a passphrase is set); the same envelope is PUT on every retry.
  const payload = auth.passphrase ? await encryptData(data, auth.passphrase) : data;
  for (let attempt = 0; attempt < 3; attempt++) {
    const sha = await currentSha(auth.token, fetchFn);
    const res = await putContent(auth.token, payload, sha, fetchFn);
    if (res.ok) { await cacheWrite(data); return; }
    if (res.status === 409 || res.status === 422) {
      if (attempt < 2) { await delay(400 * (attempt + 1)); continue; }
      if (await remoteMatches(auth, data, fetchFn)) { await cacheWrite(data); return; }
      throw new Error('Conflict — the roads file changed elsewhere; reload and try again.');
    }
    throw new Error('write ' + res.status + ' — check token scope (contents: read/write)');
  }
}

export async function testConnection(auth = {}, { fetchFn = defaultFetch } = {}) {
  try {
    const res = await fetchFn(`${API}/repos/${REPO.owner}/${REPO.repo}`, {
      headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : {}, cache: 'no-store'
    });
    if (res.ok) return { ok: true, message: 'Connected' };
    if (res.status === 404) return { ok: false, message: `Repo ${REPO.owner}/${REPO.repo} not found — check config.js` };
    return { ok: false, message: `GitHub returned ${res.status}` };
  } catch (e) { return { ok: false, message: e.message }; }
}
