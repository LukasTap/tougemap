// js/library.js — road cards, thumbnails, sort/filter
import { simplifyForThumbnail } from './geo.js';
import { fogColor } from './curvature.js';

// The night as a strip of colour: one segment per hour, 20:00→06:00.
//
// This replaced a single word ("EXTREME"). A word cannot tell a night that is
// fogged end to end from one that is clear until 05:00 and then shuts — those
// are opposite decisions. Gapless, because a card is a preview: the shape of
// the night is the point here, the detail is in the inspector.
export function fogStripHtml(risks) {
  if (!risks || !risks.length) return '<span>no forecast</span>';
  const worst = Math.max(...risks);
  const cells = risks.map(r => `<i style="background:${fogColor(r)}"></i>`).join('');
  return `<span class="fog-strip" title="Fog risk by hour, 20:00–06:00 — peaks at ${worst}%">${cells}</span>`;
}

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

export function roadCardHtml(road, { risks = null } = {}) {
  // Distance by road (km) is the metric we trust — drive-time is unreliable on
  // the SK network, so it stays a subnote in the inspector and never appears here.
  const dh = road.driveTimeFromHome?.km != null ? `${road.driveTimeFromHome.km} km from home` : '— from home';
  const fog = risks ? fogStripHtml(risks) : '';
  return `
    <div class="road-lib-item" data-id="${road.id}">
      ${thumbnailSvg(road.points)}
      <div class="road-lib-name">${escapeHtml(road.name)}</div>
      <div class="road-lib-meta"><span>${road.km} km long</span><span>${dh}</span></div>
      ${fog}
      <div class="road-lib-chips">${metaChipsHtml(road.meta)}</div>
    </div>`;
}

export function sortRoads(roads, key) {
  const by = {
    name: (a, b) => a.name.localeCompare(b.name),
    km: (a, b) => b.km - a.km,
    created: (a, b) => (b.created || '').localeCompare(a.created || ''),
    distance: (a, b) => (a.driveTimeFromHome?.km ?? Infinity) - (b.driveTimeFromHome?.km ?? Infinity)
  };
  return roads.slice().sort(by[key] || by.name);
}

export function filterRoads(roads, { q = '', character = null, pavement = null, deer = null, reachableKm = null } = {}) {
  const ql = q.trim().toLowerCase();
  return roads.filter(r =>
    (!ql || r.name.toLowerCase().includes(ql)) &&
    (!character || r.meta.character === character) &&
    (!pavement || r.meta.pavement === pavement) &&
    (!deer || r.meta.deer === deer) &&
    (reachableKm == null || (r.driveTimeFromHome?.km ?? Infinity) <= reachableKm));
}
