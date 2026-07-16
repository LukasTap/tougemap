// js/http.js — fetch with a hard timeout, used as the DEFAULT fetch implementation
// wherever routing.js/weather.js/sync.js/curvature.js call out to the network.
// Node unit tests inject their own fetchFn (see each module's `fetchFn = fetch`
// default parameter) and never go through here — this only guards real network
// calls made by the browser app itself.
export async function fetchWithTimeout(url, opts = {}, ms = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`Request timed out after ${ms}ms: ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
