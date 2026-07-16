// js/library.js — road cards, thumbnails, sort/filter
import { simplifyForThumbnail } from './geo.js';
import { fogBadge } from './weather.js';

// Escapes owner-authored text before it's injected via innerHTML, so a
// stray `<` or `&` in a road name/notes can't break the surrounding markup.
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function thumbnailSvg(points) {
  const pts = simplifyForThumbnail(points, 40);
  const lats = pts.map(p => p.lat), lons = pts.map(p => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const w = 100, h = 44, pad = 4;
  const sx = (maxLon - minLon) || 1e-6, sy = (maxLat - minLat) || 1e-6;
  const d = pts.map((p, i) => {
    const x = pad + ((p.lon - minLon) / sx) * (w - 2 * pad);
    const y = h - pad - ((p.lat - minLat) / sy) * (h - 2 * pad); // invert lat
    return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="road-thumb" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${d}"/></svg>`;
}

export function metaChipsHtml(meta) {
  const chips = [];
  if (meta.character) chips.push(`<span class="meta-chip">${meta.character}</span>`);
  if (meta.pavement)  chips.push(`<span class="meta-chip">${meta.pavement}</span>`);
  if (meta.deer)      chips.push(`<span class="meta-chip deer-${meta.deer}">🦌 ${meta.deer}</span>`);
  return chips.join('');
}

export function roadCardHtml(road, { fogScore = null } = {}) {
  const dt = road.driveTimeFromHome?.minutes != null ? `${road.driveTimeFromHome.minutes} min` : '—';
  const fog = fogScore != null ? (b => `<span class="fog-badge ${b.cls}">${b.lbl}</span>`)(fogBadge(fogScore)) : '';
  return `
    <div class="road-lib-item" data-id="${road.id}">
      ${thumbnailSvg(road.points)}
      <div class="road-lib-name">${escapeHtml(road.name)}</div>
      <div class="road-lib-meta"><span>${road.km} km</span><span>${dt} from home</span>${fog}</div>
      <div class="road-lib-chips">${metaChipsHtml(road.meta)}</div>
    </div>`;
}

export function sortRoads(roads, key) {
  const by = {
    name: (a, b) => a.name.localeCompare(b.name),
    km: (a, b) => b.km - a.km,
    created: (a, b) => (b.created || '').localeCompare(a.created || ''),
    driveTime: (a, b) => (a.driveTimeFromHome?.minutes ?? Infinity) - (b.driveTimeFromHome?.minutes ?? Infinity)
  };
  return roads.slice().sort(by[key] || by.name);
}

export function filterRoads(roads, { q = '', character = null, pavement = null, deer = null, reachableMin = null } = {}) {
  const ql = q.trim().toLowerCase();
  return roads.filter(r =>
    (!ql || r.name.toLowerCase().includes(ql)) &&
    (!character || r.meta.character === character) &&
    (!pavement || r.meta.pavement === pavement) &&
    (!deer || r.meta.deer === deer) &&
    (reachableMin == null || (r.driveTimeFromHome?.minutes ?? Infinity) <= reachableMin));
}
