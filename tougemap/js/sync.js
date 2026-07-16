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
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (res.status === 404) return null;      // file doesn't exist yet
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

export async function writeRoads(cfg, data, { fetchFn = defaultFetch } = {}) {
  if (!cfg.token) throw new Error('No GitHub token configured');
  let sha = await currentSha(cfg, fetchFn);
  let res = await putRoads(cfg, data, sha, fetchFn);
  if (res.status === 409) {
    // Stale sha — someone else wrote the file since we fetched it. Re-fetch
    // the current sha and retry exactly once before giving up.
    sha = await currentSha(cfg, fetchFn);
    res = await putRoads(cfg, data, sha, fetchFn);
    if (res.status === 409) {
      throw new Error('Conflict — the roads file changed elsewhere; reload and try again.');
    }
  }
  if (!res.ok) throw new Error('write ' + res.status + ' — check token scope (contents: read/write)');
  await cacheWrite(data);
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
