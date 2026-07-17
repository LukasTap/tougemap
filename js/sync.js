// js/sync.js — GitHub read (public) + write (token)
import { migrate, emptyData, cacheRead, cacheWrite } from './store.js';
import { fetchWithTimeout } from './http.js';

const defaultFetch = (u, o) => fetchWithTimeout(u, o, 15000);

const LS_KEY = 'tougemap_gh';
const API = 'https://api.github.com';

export function loadConfig() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || null; } catch { return null; }
}
export function saveConfig(cfg) { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); }
export function clearToken() {
  const c = loadConfig(); if (c) { delete c.token; saveConfig(c); }
}

export function rawUrl(cfg) {
  return `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${cfg.branch}/${cfg.path}`;
}

export function encodeContent(obj) {
  const json = JSON.stringify(obj, null, 2);
  if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(json)));
  return Buffer.from(json, 'utf8').toString('base64'); // Node/test path
}

export async function readRoads(cfg, { fetchFn = defaultFetch } = {}) {
  try {
    const res = await fetchFn(rawUrl(cfg) + '?t=' + Date.now()); // cache-bust
    if (!res.ok) throw new Error('read ' + res.status);
    const data = migrate(await res.json());
    await cacheWrite(data);
    return data;
  } catch {
    return (await cacheRead()) || emptyData();
  }
}

async function currentSha(cfg, fetchFn) {
  const url = `${API}/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.path}?ref=${cfg.branch}`;
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${cfg.token}` }, cache: 'no-store' });  if (res.status === 404) return null;
  if (!res.ok) throw new Error('sha ' + res.status);
  return (await res.json()).sha;
}

async function putRoads(cfg, data, sha, fetchFn) {
  const url = `${API}/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.path}`;
  const body = {
    message: `Update roads (${data.roads.length} saved)`,
    content: encodeContent(data),
    branch: cfg.branch,
    ...(sha ? { sha } : {})
  };
  return fetchFn(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Does the file already on GitHub match exactly what we're about to write?
// Used to turn a lost sha-race into a success: if a concurrent/previous write
// already persisted our exact data, there's nothing left to do.
async function remoteMatches(cfg, data, fetchFn) {
  try {
    const res = await fetchFn(rawUrl(cfg) + '?t=' + Date.now());
    if (!res.ok) return false;
    return JSON.stringify(migrate(await res.json())) === JSON.stringify(migrate(data));
  } catch { return false; }
}

// Serialize writes: chain every writeRoads so two rapid saves can never race the
// same sha (the second waits, then fetches a fresh sha). This is the common
// cause of a self-inflicted 409 in a single-writer app.
let writeChain = Promise.resolve();

export function writeRoads(cfg, data, opts = {}) {
  const run = writeChain.then(() => doWriteRoads(cfg, data, opts));
  writeChain = run.then(() => {}, () => {}); // keep the chain alive on either outcome
  return run;
}

async function doWriteRoads(cfg, data, { fetchFn = defaultFetch } = {}) {
  if (!cfg.token) throw new Error('No GitHub token configured');
  // Fetch fresh sha then PUT; on a stale-sha conflict (409/422) back off and
  // retry with a re-fetched sha (handles GitHub replication lag), up to 3 tries.
  for (let attempt = 0; attempt < 3; attempt++) {
    const sha = await currentSha(cfg, fetchFn);
    const res = await putRoads(cfg, data, sha, fetchFn);
    if (res.ok) { await cacheWrite(data); return; }
    if (res.status === 409 || res.status === 422) {
      if (attempt < 2) { await delay(400 * (attempt + 1)); continue; }
      // Retries exhausted — but our exact data may already be live (a racing
      // write won the sha). If so, treat as success rather than a false error.
      if (await remoteMatches(cfg, data, fetchFn)) { await cacheWrite(data); return; }
      throw new Error('Conflict — the roads file changed elsewhere; reload and try again.');
    }
    throw new Error('write ' + res.status + ' — check token scope (contents: read/write)');
  }
}

export async function testConnection(cfg, { fetchFn = defaultFetch } = {}) {
  try {
    const res = await fetchFn(`${API}/repos/${cfg.owner}/${cfg.repo}`, {
      headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}
    });
    if (res.ok) return { ok: true, message: 'Connected' };
    return { ok: false, message: `GitHub returned ${res.status}` };
  } catch (e) { return { ok: false, message: e.message }; }
}