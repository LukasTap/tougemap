// js/sync.js — GitHub read + write of roads.json, with the library encrypted at
// rest (see crypto.js) so the public repo holds only gibberish. Repo coordinates
// come from config.js.
//
// Reads return { data, sha, source }:
//   source 'remote'  — fresh from GitHub; `sha` is the git id of the exact file read
//   source 'cache'   — GitHub unreachable, last good copy from IndexedDB (read-only)
//   source 'none'    — GitHub unreachable and nothing cached (read-only, empty)
//   source 'fixture' — local dev sample data (read-only), see config.js
// Writes are pinned to the sha the data was loaded at (see repo.js), so a stale
// copy can never silently overwrite a newer file: GitHub answers 409 instead.
import { migrate, emptyData, cacheRead, cacheWrite, cacheClear } from './store.js';
import { fetchWithTimeout } from './http.js';
import { REPO, DEV_FIXTURE, DEV_FAKE_SAVE } from './config.js';
import { isEncrypted, encryptData, decryptData } from './crypto.js';

const defaultFetch = (u, o) => fetchWithTimeout(u, o, 15000);
const API = 'https://api.github.com';
const TOKEN_KEY = 'tougemap_token';
const PASS_KEY = 'tougemap_pass';

// ── Local auth: token = write credential, passphrase = decrypt key. Both live
// only in this device's localStorage — never committed or put in a URL.
function store() { try { return globalThis.localStorage ?? null; } catch { return null; } }
export function loadAuth() {
  const ls = store();
  return { token: ls?.getItem(TOKEN_KEY) || null, passphrase: ls?.getItem(PASS_KEY) || null };
}
export function saveToken(t) { const ls = store(); if (ls) t ? ls.setItem(TOKEN_KEY, t) : ls.removeItem(TOKEN_KEY); }
export function savePassphrase(p) { const ls = store(); if (ls) p ? ls.setItem(PASS_KEY, p) : ls.removeItem(PASS_KEY); }

// "Forget this device": token, passphrase and the decrypted offline copy.
export async function forgetDevice() {
  saveToken(null);
  savePassphrase(null);
  await cacheClear();
}

export function rawUrl() {
  return `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}/${REPO.branch}/${REPO.path}`;
}
export function apiUrl() {
  return `${API}/repos/${REPO.owner}/${REPO.repo}/contents/${REPO.path}`;
}

export function encodeContent(obj) {
  const json = JSON.stringify(obj, null, 2);
  if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(json)));
  return Buffer.from(json, 'utf8').toString('base64'); // Node/test path
}

// Git's object id for a file's bytes — the same `sha` GitHub reports for it, so
// a file read from the public raw URL can still be written back safely.
export async function gitBlobSha(bytes) {
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const buf = new Uint8Array(head.length + bytes.length);
  buf.set(head);
  buf.set(bytes, head.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', buf));
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getBytes(fetchFn, url, opts) {
  const res = await fetchFn(url, opts);
  if (res.status === 404) return null; // file doesn't exist yet
  if (!res.ok) throw new Error('read ' + res.status);
  return new Uint8Array(await res.arrayBuffer());
}

// The file's exact bytes, through the GitHub API first:
//   with a token   — always fresh, so a reload right after a save shows it;
//   without one    — at most ~60 s behind (the API's own cache), within GitHub's
//                    60-requests-per-hour allowance for anonymous use per IP.
// If the API says no (anonymous allowance used up, token rejected), the public
// raw URL instead. Its CDN can be up to 5 minutes stale — fine for viewing, and
// still safe for writing, because a write is pinned to the sha of what was read.
async function fetchFile(auth, fetchFn) {
  let notice = null;
  const headers = { Accept: 'application/vnd.github.raw+json' };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  try {
    const bytes = await getBytes(fetchFn, `${apiUrl()}?ref=${encodeURIComponent(REPO.branch)}`, { headers, cache: 'no-store' });
    if (bytes) return { bytes, notice };
  } catch (e) {
    if (auth.token) notice = `GitHub rejected the token (${e.message}) — update it in 🔑 settings to save changes`;
  }
  return { bytes: await getBytes(fetchFn, rawUrl(), { cache: 'no-store' }), notice };
}

// Parsed file → plain v2 data, decrypting when needed. Throws Error with a `code`
// of 'ENCRYPTED_NO_PASS' (locked, no passphrase) or 'BAD_PASSPHRASE' (wrong one)
// so the UI can prompt. Plaintext files pass straight through.
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

async function fromCache(error) {
  const cached = await cacheRead();
  return cached
    ? { data: migrate(cached), sha: null, source: 'cache', error }
    : { data: emptyData(), sha: null, source: 'none', error };
}

export async function readRoads(auth = {}, { fetchFn = defaultFetch } = {}) {
  if (DEV_FIXTURE) {
    const res = await fetchFn(DEV_FIXTURE, { cache: 'no-store' });
    return { data: migrate(await res.json()), sha: null, source: 'fixture' };
  }
  let file;
  try { file = await fetchFile(auth, fetchFn); }
  catch (error) { return fromCache(error); }
  // No file yet: a brand-new repo. Empty is the truth here, and the first save creates it.
  if (!file.bytes) return { data: emptyData(), sha: null, source: 'remote', notice: file.notice };
  let raw;
  try { raw = JSON.parse(new TextDecoder().decode(file.bytes)); }
  catch { return fromCache(new Error('roads.json on GitHub is not valid JSON')); }
  const data = await toPlain(raw, auth.passphrase); // lock errors bubble up to the caller
  await cacheWrite(data);
  return { data, sha: await gitBlobSha(file.bytes), source: 'remote', notice: file.notice };
}

// Writes `data` as the new roads.json, replacing exactly the version `baseSha`
// names (null = the file must not exist yet). Returns the new file's sha.
export async function writeRoads(auth = {}, data, baseSha, { fetchFn = defaultFetch } = {}) {
  if (DEV_FAKE_SAVE) return 'dev-fake-' + Date.now(); // localhost ?fixture&fakesave only
  if (!auth.token) throw new Error('No GitHub token on this device — add one in 🔑 settings');
  let payload = data;
  if (auth.passphrase) {
    payload = await encryptData(data, auth.passphrase);
    // Prove the envelope opens before it replaces the only live copy.
    const check = await decryptData(payload, auth.passphrase);
    if (JSON.stringify(check) !== JSON.stringify(data)) throw new Error('Encryption self-check failed — NOT saved');
  }
  // Generic commit message — deliberately says nothing about the contents.
  const body = { message: 'Update roads', content: encodeContent(payload), branch: REPO.branch, ...(baseSha ? { sha: baseSha } : {}) };
  const res = await fetchFn(apiUrl(), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' },
    body: JSON.stringify(body)
  });
  if (res.status === 409 || res.status === 422) {
    const e = new Error(`The roads file changed since this page loaded it (${res.status}). Reload to get the latest, then redo the change — NOT saved.`);
    e.code = 'CONFLICT';
    throw e;
  }
  if (!res.ok) throw new Error(`write ${res.status} — check the token (needs Contents: read & write on this repo) — NOT saved`);
  const json = await res.json();
  await cacheWrite(data);
  return json?.content?.sha ?? null;
}
