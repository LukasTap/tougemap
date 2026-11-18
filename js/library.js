// js/library.js — road cards, thumbnails, sort/filter
import { simplifyForThumbnail } from './geo.js';
import { fogColor } from './curvature.js';
import { inDriveWindow, DRIVE_FROM, DRIVE_TO } from './weather.js';

// One mark per kind of forecast point, shared by the card rows and the
// inspector rows so the two read the same: S start, ▲ summit (highest point),
// ▼ low point (lowest — where valley fog collects), E end, M middle (used only
// when a road has no elevation profile yet).
export const POINT_MARK = { start: 'S', summit: '▲', low: '▼', end: 'E', mid: 'M' };

// The night as colour: one cell per hour, 20:00→06:00, and one thin row per
// forecast point along the road (start → summit → end), top to bottom, each
// row marked with its point. Two thin lines bracket the driving window
// (22:00–02:00), as the shaded band does on the inspector chart; once 22:00 has
// passed the left line goes, because the window is already open.
//
// The strip replaced a single word ("EXTREME") because a word cannot tell a
// night fogged end to end from one that is clear until 05:00 — opposite
// decisions. The rows do the same for space: one row cannot tell a road fogged
// end to end from one fogged only on its far side. Gapless, because a card is a
// preview; the detail is in the inspector.
// rows: [{ label, role, risks: [...], hours: [...] }]
export function fogStripHtml(rows) {
  const live = (rows || []).filter(r => r.risks?.length);
  if (!live.length) return '<span>no forecast</span>';
  const multi = live.length > 1;
  const worst = Math.max(...live.flatMap(r => r.risks));
  const hours = live[0].hours || [];
  const what = multi ? `; rows top to bottom: ${live.map(r => `${POINT_MARK[r.role] || '·'} ${r.label}`).join(', ')}` : '';
  const body = live.map((r, i) =>
    (multi ? `<b class="fog-mark" style="grid-row:${i + 1}">${POINT_MARK[r.role] || '·'}</b>` : '') +
    `<span class="fog-row" style="grid-row:${i + 1}">${r.risks.map(v => `<i style="background:${fogColor(v)}"></i>`).join('')}</span>`).join('');

  // The driving window, as a share of the strip's width.
  const n = hours.length;
  const wa = hours.findIndex(inDriveWindow);
  let windowMark = '';
  if (n && wa >= 0) {
    let wb = wa;
    while (wb + 1 < n && inDriveWindow(hours[wb + 1])) wb++;
    const cls = `${hours[wa] === DRIVE_FROM ? ' l' : ''}${hours[wb] === DRIVE_TO ? ' r' : ''}`;
    windowMark = `<span class="fog-window" style="grid-row:1 / span ${live.length}">` +
      `<span class="fog-window-box${cls}" style="left:${((wa / n) * 100).toFixed(2)}%;width:${(((wb - wa + 1) / n) * 100).toFixed(2)}%"></span></span>`;
  }
  const title = `Fog risk by hour, 20:00–06:00${what}. Lines mark the driving window, 22:00–02:00. Peaks at ${worst}%.`;
  return `<span class="fog-strip${multi ? ' multi' : ''}" title="${escapeHtml(title)}">${body}${windowMark}</span>`;
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
  if (!points || points.length < 2) return '<svg class="road-thumb" viewBox="0 0 100 44"></svg>';
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

// Ranked hazards first, coloured, each carrying an icon so the word does not
// have to name its own dimension — "patchy" next to "flowing" used to leave you
// working out which chip was the surface. Character comes last and uncoloured:
// it is the one tag that says why you would GO, not what could go wrong, and
// dressing it like a rank implied an order it does not have.
export function metaChipsHtml(meta = {}) {
  const e = escapeHtml;
  const chips = [];
  if (meta.pavement)  chips.push(`<span class="meta-chip pave-${e(meta.pavement)}">🛣 ${e(meta.pavement)}</span>`);
  if (meta.deer)      chips.push(`<span class="meta-chip deer-${e(meta.deer)}">🦌 ${e(meta.deer)}</span>`);
  if (meta.character) chips.push(`<span class="meta-chip chip-kind">${e(meta.character)}</span>`);
  return chips.join('');
}

export function roadCardHtml(road, { fogRows = null } = {}) {
  // Distance by road (km) is the metric we trust — drive-time is unreliable on
  // the SK network, so it stays a subnote in the inspector and never appears here.
  const dh = road.driveTimeFromHome?.km != null ? `${escapeHtml(road.driveTimeFromHome.km)} km from home` : '— from home';
  const fog = fogRows ? fogStripHtml(fogRows) : '';
  return `
    <div class="road-lib-item" data-id="${escapeHtml(road.id)}">
      ${thumbnailSvg(road.points)}
      <div class="road-lib-name">${escapeHtml(road.name)}</div>
      <div class="road-lib-meta"><span>${escapeHtml(road.km)} km long</span><span>${dh}</span></div>
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
