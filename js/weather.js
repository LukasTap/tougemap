// js/weather.js — open-meteo fetch + fog scoring (no persistence)
import { gridCellKey } from './geo.js';
import { fetchWithTimeout } from './http.js';

// ── NIGHT WINDOWING ─────────────────────────────────────────────────────────
// A "night" runs 20:00 → 06:00 and is keyed by the date it STARTED on, so
// 23:00 Wed and 04:00 Thu belong to the same night.
function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function nightKeyOf(t) {
  const h = t.getHours();
  if (h >= 20) return dateKey(t);
  if (h <= 6) { const d = new Date(t); d.setDate(d.getDate() - 1); return dateKey(d); }
  return null; // daytime — not part of any night
}

// ── ROAD SURFACE (an estimate) ──────────────────────────────────────────────
// Water left on the road, hour by hour, in mm: rain adds to it (up to what a
// road holds before it runs off), evaporation takes it away. The drying figure
// is Open-Meteo's hourly reference evapotranspiration (ET0, FAO) — sun,
// temperature, humidity and wind already folded into one "drying power"
// number. In summer it is ~0.6–0.8 mm/h at midday, so a wet road is dry within
// an hour or two; in November it peaks around 0.1 mm/h and is ~0 at night, so a
// road that is wet at dusk stays wet. The series starts with yesterday
// (past_days=1), so an afternoon of rain is counted.
//
// It cannot see shade, puddles, wet leaves or which way a slope faces — the UI
// calls it an estimate.
export const ROAD_FILM_CAP_MM = 1.0; // more than this runs off
export const DRYING_FACTOR = 1.5;    // dark, warm asphalt dries faster than the reference grass
export const WET_MM = 0.2, DAMP_MM = 0.05, RAIN_MM = 0.1;

export function roadWater(d) {
  const H = d.hourly;
  const rain = H.precipitation || [], et0 = H.et0_fao_evapotranspiration || [];
  let w = 0;
  return H.time.map((_, i) => {
    w = Math.min(ROAD_FILM_CAP_MM, w + (rain[i] || 0));
    w = Math.max(0, w - DRYING_FACTOR * (et0[i] || 0));
    return Math.round(w * 1000) / 1000;
  });
}

// Upcoming night hours, each with its per-hour fog risk. This is THE single
// source that both the headline badge and the hourly strip read, so the two
// can never drift apart again.
export function nightHours(d, now) {
  const H = d.hourly;
  const water = roadWater(d);
  const out = [];
  for (let i = 0; i < H.time.length; i++) {
    const t = new Date(H.time[i]);
    if (t < now) continue;
    const key = nightKeyOf(t);
    if (!key) continue;
    out.push({
      t, key,
      hour: t.getHours(),
      temp: H.temperature_2m[i],
      wind: H.windspeed_10m[i],
      precip: H.precipitation_probability?.[i] ?? 0,
      rainMm: H.precipitation?.[i] ?? 0,
      water: water[i],
      risk: Math.round(nightFogRisk(
        H.temperature_2m[i] - H.dew_point_2m[i], H.relative_humidity_2m[i], H.windspeed_10m[i]))
    });
  }
  return out;
}

// The road over a set of hours: 'rain' if it rains in them, else 'wet' /
// 'damp' / 'dry' by the most water left on it. Black ice: water on the road and
// 3 °C or less in the SAME hour — 'likely' at or below 0 °C, 'possible' above.
export const SURFACE_RANK = { dry: 0, damp: 1, wet: 2, rain: 3 };
export function surfaceOf(hours) {
  if (!hours.length) return null;
  const water = Math.max(...hours.map(h => h.water ?? 0));
  const rainMm = hours.reduce((s, h) => s + (h.rainMm ?? 0), 0);
  const state = hours.some(h => (h.rainMm ?? 0) >= RAIN_MM) ? 'rain'
    : water >= WET_MM ? 'wet' : water >= DAMP_MM ? 'damp' : 'dry';
  const icy = hours.filter(h => ((h.water ?? 0) >= DAMP_MM || (h.rainMm ?? 0) >= RAIN_MM) && h.temp <= FROST_C);
  const coldest = icy.reduce((c, h) => (!c || h.temp < c.temp ? h : c), null);
  const ice = coldest ? { level: coldest.temp <= FREEZE_C ? 'likely' : 'possible', temp: coldest.temp, hour: coldest.hour } : null;
  return { state, water: Math.round(water * 100) / 100, rainMm: Math.round(rainMm * 10) / 10, ice };
}

// The most recent rain before `now` (within the 36 h the series covers) and the
// total over the 24 h before it — the "why" behind a wet road.
export function recentRain(d, now) {
  const H = d.hourly, rain = H.precipitation || [];
  let last = null, total = 0;
  for (let i = 0; i < H.time.length; i++) {
    const t = new Date(H.time[i]);
    if (t > now) break;
    if (now - t <= 24 * 3600 * 1000) total += rain[i] || 0;
    if ((rain[i] || 0) >= RAIN_MM) last = t;
  }
  return { last, totalMm: Math.round(total * 10) / 10 };
}

// Split the flat hour list into nights, in order. A night is keyed by the date
// it started on, so 23:00 Wed and 04:00 Thu land in the same group.
export function nightGroups(hours) {
  const groups = [];
  for (const h of hours) {
    const last = groups[groups.length - 1];
    if (last && last.key === h.key) last.hours.push(h);
    else groups.push({ key: h.key, hours: [h] });
  }
  return groups;
}

// Whatever is left of the first upcoming night, from a list of night hours.
export function firstNight(hours) {
  const first = nightGroups(hours)[0];
  return first ? first.hours : [];
}

// Per-hour risks for the first upcoming night — what the card strip draws.
// Deliberately the WHOLE night, not just the driving window: the strip's job is
// to show the shape, including the stretch you would be avoiding.
export function tonightRisks(hours) {
  return firstNight(hours).map(h => h.risk);
}

// ── SEVERAL POINTS PER ROAD ─────────────────────────────────────────────────
// One road, several forecast points (terrain.js), combined hour by hour two ways:
//   risk / temp / wind / precip — the WORST point: what the chart draws, and
//       remembered with WHERE (riskAt / tempAt) so the inspector can say
//       "fog 80% at the summit";
//   riskAvg / precipAvg — weighted by how much of the road each point speaks
//       for (its `share`). One fogged-in end of a pass is a quarter of the road,
//       not all of it; the ranking uses these.
// Only hours every point has are kept.
export function mergeNightHours(perPoint) {
  if (!perPoint.length) return [];
  const byTime = new Map();
  for (const p of perPoint) {
    const w = p.share ?? 1 / perPoint.length;
    for (const h of p.hours) {
      const k = h.t.getTime();
      const cur = byTime.get(k);
      if (!cur) {
        byTime.set(k, { ...h, riskAt: p.label, tempAt: p.label, n: 1, wsum: w, rsum: h.risk * w, psum: h.precip * w });
        continue;
      }
      cur.n++; cur.wsum += w; cur.rsum += h.risk * w; cur.psum += h.precip * w;
      if (h.risk > cur.risk) { cur.risk = h.risk; cur.riskAt = p.label; }
      if (h.temp < cur.temp) { cur.temp = h.temp; cur.tempAt = p.label; }
      cur.wind = Math.min(cur.wind, h.wind);
      cur.precip = Math.max(cur.precip, h.precip);
    }
  }
  return [...byTime.values()]
    .filter(h => h.n === perPoint.length)
    .sort((a, b) => a.t - b.t)
    .map(({ n, wsum, rsum, psum, ...h }) => ({ ...h, riskAvg: Math.round(rsum / wsum), precipAvg: Math.round(psum / wsum) }));
}

// Each point on its own over the hours that decide the night (decisionHours):
// its worst fog and lowest temperature, plus the stretch of road it covers.
// One summary feeds the inspector rows, the card rows and the Tonight map.
export function pointSummaries(conditions) {
  return conditions.points.map(p => {
    const night = firstNight(p.hours);
    const hrs = decisionHours(night);
    return {
      label: p.label, role: p.role, km: p.km, fromKm: p.fromKm, toKm: p.toKm, share: p.share,
      ele: typeof p.ele === 'number' ? Math.round(p.ele) : null,
      fog: hrs.length ? Math.max(...hrs.map(h => h.risk)) : null,
      temp: hrs.length ? Math.min(...hrs.map(h => h.temp)) : null,
      surface: surfaceOf(hrs),       // road water / black ice over the same hours
      risks: night.map(h => h.risk), // the whole night, for the card rows
      hours: night.map(h => h.hour)  // which hour each of those is (the night may be part-spent)
    };
  });
}

// points: [{ label, ele?, ... }] with forecasts in the same order (null = failed).
// → { points: [{ ...point, forecast, hours }], hours: merged } or null if no
// point has a forecast. A point's elevation falls back to the one the forecast
// was computed for.
export function roadConditions(points, forecasts, now) {
  const per = points
    .map((p, i) => ({ ...p, ele: p.ele ?? forecasts[i]?.elevation, forecast: forecasts[i] }))
    .filter(p => p.forecast)
    .map(p => ({ ...p, hours: nightHours(p.forecast, now) }));
  return per.length ? { points: per, hours: mergeNightHours(per) } : null;
}

// The coming hour at each point, and the coldest of them.
export function currentReadings(conditions, now) {
  const all = conditions.points.map(p => {
    const H = p.forecast.hourly;
    const i = H.time.findIndex(t => new Date(t) > now);
    return i < 0 ? null : { label: p.label, temp: H.temperature_2m[i], code: H.weathercode?.[i] };
  }).filter(Boolean);
  const coldest = all.reduce((c, r) => (!c || r.temp < c.temp ? r : c), null);
  return { all, coldest };
}

// The hours a decision actually rests on: the driving window if any of it is
// left, otherwise whatever remains of the night.
//
// Pictures show the whole night; NUMBERS are scoped to this. Fog at 05:00 is
// real, but a figure that lets it decide the night is misinformation when those
// hours are never driven. The fallback keeps the app useful at 03:00 — the
// numbers just widen back out, because the rest of the night is all there is
// left to say.
export function decisionHours(hours) {
  const window = hours.filter(h => inDriveWindow(h.hour));
  return window.length ? window : hours;
}

// The hour that matters for each stat, and when it lands. Which END is the
// dangerous one differs per stat: fog peaks, temperature bottoms out, and wind
// matters at its CALMEST — still air is what lets fog settle and stay.
export function nightExtremes(hours) {
  if (!hours.length) return null;
  const pick = (key, isBetter) => hours.reduce((best, h) => (isBetter(h[key], best[key]) ? h : best), hours[0]);
  return {
    coldest: pick('temp', (a, b) => a < b),
    foggiest: pick('risk', (a, b) => a > b),
    calmest: pick('wind', (a, b) => a < b),
    wettest: pick('precip', (a, b) => a > b)
  };
}

// (Ranking's fog figure is the worst hour of decisionHours() — see
// tonight-rank.js. The old calcFogScore used a second formula over a window cut
// off at array index 24, which, checked in the afternoon, missed 01:00–06:00.)

// fogBadge() lived here and turned the night's worst hour into one word. It is
// gone: a word cannot distinguish a night fogged end to end from one that is
// clear until 05:00, and those are opposite decisions. The cards draw the whole
// night as a strip instead (fogStripHtml), and the inspector draws the curve.

export function wmoDesc(c) {
  if (c === 0) return 'Clear sky';
  if (c <= 3) return 'Partly cloudy';
  if (c <= 49) return 'Fog / mist';
  if (c <= 67) return 'Rain';
  if (c <= 77) return 'Snow';
  if (c <= 82) return 'Showers';
  return 'Thunderstorm';
}

// Per-hour fog-risk (0–100) for the "tonight" hourly strip dots.
export function nightFogRisk(spread, rh, wind) {
  let fr = spread <= 1 ? 80 : spread <= 2 ? 50 : spread <= 4 ? 25 : 10;
  if (rh > 90) fr = Math.min(100, fr + 20);
  if (wind < 5) fr = Math.min(100, fr + 10);
  return fr;
}

// ── NIGHT CHART GEOMETRY ────────────────────────────────────────────────────
// Coordinate space for the stacked fog + temperature chart. Drawn at 308 wide
// (the real inspector width) and scaled by CSS, so the ratio is fixed here.
// Fog occupies the upper plot, temperature the lower one, sharing one x-axis.
export const CHART = Object.freeze({
  w: 308, h: 116, gap: 12,
  fogTop: 6, fogBase: 50,
  tmpTop: 64, tmpBase: 100,
  tickEnd: 105
});

// The fog plot deliberately has NO gridline, unlike temperature.
//
// Temperature needs one because its scale floats — it is auto-ranged to the
// night, so a height means nothing until a line says what. Fog is pinned to an
// absolute 0-100 with the baseline at zero, so a reference line only restated
// what the plot already implied — and it could not do even that legibly: the
// whole range is 44 units, so 35% sits 6.6 units under a 50% line, of which 1.75
// is the two strokes' own ink. At a glance it read as touching, right through
// the 25-50% band where most nights actually sit. Severity is carried by colour
// (absolute and calibrated) and exact values by the scrubber.

// Ice thresholds, in °C. Zero is where water freezes; +3 is where the ROAD can
// be freezing while the air is not — tarmac radiates heat to a clear sky faster
// than the air above it, and bridges and shaded valley floors go first.
export const FREEZE_C = 0;
export const FROST_C = 3;

// The hours actually driven. Fog at 05:00 is real but academic — the chart
// shades this stretch so you can see whether a peak lands inside it.
export const DRIVE_FROM = 22;
export const DRIVE_TO = 2;

// Hours since 20:00, so a night reads 0…10 and comparisons never wrap midnight.
export function nightOffset(hour) {
  return hour >= 20 ? hour - 20 : hour + 4;
}
export function inDriveWindow(hour) {
  const o = nightOffset(hour);
  return o >= nightOffset(DRIVE_FROM) && o <= nightOffset(DRIVE_TO);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Every plotted hour across both nights, in x order — the index a scrubbing
// cursor hit-tests against.
export function scrubPoints(chart) {
  return chart ? chart.segments.flatMap(s => s.points) : [];
}

// Nearest plotted hour to a position on the chart. Snaps rather than
// interpolating: the forecast IS hourly, and a reading between two hours would
// be a number the data never contained.
export function nearestScrubPoint(points, x) {
  if (!points || !points.length) return null;
  return points.reduce((best, p) => (Math.abs(p.x - x) < Math.abs(best.x - x) ? p : best), points[0]);
}

// Which hours get a label under a night, given how wide an hour is.
//
// Candidates are tried most-meaningful-first and each is placed only if it
// clears everything already placed: the driving window's edges (they bound the
// shaded band and so explain it), then the night's own start and end, then
// thirds as filler. Filler needs half again the clearance — merely not
// overlapping still reads as clutter when it lands next door to a label that
// means something.
//
// LABEL_W is a two-digit hour in chart units. Every label is centred on its own
// tick, including the first and last: hugging the ends instead made those two
// sit visibly off their dashes while the middle ones sat on theirs.
export const LABEL_W = 16;

export function axisLabelIndices(hours, hourW) {
  const n = hours.length;
  if (!n) return [];
  const centre = (k) => k * hourW;
  const edges = [];
  hours.forEach((h, k) => { if (h.hour === DRIVE_FROM || h.hour === DRIVE_TO) edges.push(k); });
  const wanted = [
    ...edges.map(k => [k, LABEL_W]), [0, LABEL_W], [n - 1, LABEL_W],
    [Math.round((n - 1) / 3), LABEL_W * 1.6], [Math.round(2 * (n - 1) / 3), LABEL_W * 1.6]
  ];
  const kept = [];
  for (const [k, gap] of wanted) {
    if (k < 0 || k >= n || kept.includes(k)) continue;
    if (kept.every(j => Math.abs(centre(k) - centre(j)) >= gap)) kept.push(k);
  }
  return kept.sort((a, b) => a - b);
}

// Lay both upcoming nights on ONE x-axis.
//
// The nights are not contiguous — 14 hours of daylight sit between them — so
// each night gets its own path and the axis is broken by a real gap between
// them. Drawing one unbroken line would invent a slope across the elided day.
// Hour spacing is constant across the whole chart, so a slope means the same
// thing wherever it appears and a part-spent first night renders as the stub
// it actually is.
export function buildNightChart(groups, geom = CHART) {
  const nights = groups.slice(0, 2).filter(g => g.hours.length);
  if (!nights.length) return null;

  // Fog is on an ABSOLUTE 0–100 scale, deliberately: normalising to the night's
  // own min/max would draw a night sitting at 100% throughout as a flat, calm-
  // looking line — the exact inverse of the warning it needs to give.
  const yFog = (r) => geom.fogBase - (clamp(r, 0, 100) / 100) * (geom.fogBase - geom.fogTop);

  // Temperature gets ONE scale across every night shown, so the two halves stay
  // comparable and 0°C sits at a single height. Padded whole degrees either
  // side, which also guarantees hi > lo.
  const temps = nights.flatMap(g => g.hours.map(h => h.temp));
  const lo = Math.floor(Math.min(...temps)) - 1;
  const hi = Math.ceil(Math.max(...temps)) + 1;
  const yTmp = (t) => geom.tmpBase - ((t - lo) / (hi - lo)) * (geom.tmpBase - geom.tmpTop);

  const gaps = (nights.length - 1) * geom.gap;
  const intervals = nights.reduce((n, g) => n + Math.max(0, g.hours.length - 1), 0);
  const hourW = intervals > 0 ? (geom.w - gaps) / intervals : 0;

  const r1 = (n) => +n.toFixed(1);
  let cursor = 0;
  const ticks = [];
  const breaks = [];
  const segments = nights.map((g, gi) => {
    const start = cursor;
    const xs = g.hours.map((_, i) => r1(start + i * hourW));
    ticks.push(...xs);
    cursor = start + Math.max(0, g.hours.length - 1) * hourW + geom.gap;
    if (gi < nights.length - 1) breaks.push(r1(cursor - geom.gap / 2));

    const path = (y, key) => 'M' + g.hours.map((h, i) => `${xs[i]} ${r1(y(h[key]))}`).join(' L');
    const fogLine = path(yFog, 'risk');
    let pi = 0;
    for (let i = 1; i < g.hours.length; i++) if (g.hours[i].risk > g.hours[pi].risk) pi = i;
    // Span of the driving window inside THIS night. Checked at 01:00 the window
    // is half spent and the band shrinks with it; checked at 03:00 it is gone.
    const flags = g.hours.map(h => inDriveWindow(h.hour));
    const wa = flags.indexOf(true), wb = flags.lastIndexOf(true);
    return {
      key: g.key,
      hours: g.hours,
      // Every plotted hour with its screen position, so hovering can hit-test
      // against real data instead of the view re-deriving the geometry.
      points: g.hours.map((h, i) => ({
        x: xs[i], night: gi, hour: h.hour,
        risk: h.risk, temp: h.temp, riskAt: h.riskAt, tempAt: h.tempAt,
        fogY: r1(yFog(h.risk)), tmpY: r1(yTmp(h.temp))
      })),
      x0: xs[0], x1: xs[xs.length - 1],
      drive: wa < 0 ? null : { x0: xs[wa], x1: xs[wb], width: r1(xs[wb] - xs[wa]) },
      fogLine,
      fogArea: `${fogLine} L${xs[xs.length - 1]} ${geom.fogBase} L${xs[0]} ${geom.fogBase} Z`,
      tempLine: path(yTmp, 'temp'),
      peak: { x: xs[pi], y: r1(yFog(g.hours[pi].risk)), hour: g.hours[pi].hour, risk: g.hours[pi].risk }
    };
  });

  // Colour the temperature line by ACTUAL degrees, not by height on the chart:
  // the gradient stops are computed from where 0 and +3 fall on this night's
  // own scale. A night that never drops below 8°C shows no cold colours at all,
  // and a night entirely below zero is ice-white end to end.
  const span = geom.tmpBase - geom.tmpTop;
  const stopAt = (t) => +clamp((geom.tmpBase - yTmp(t)) / span, 0, 1).toFixed(4);
  const freezeY = r1(clamp(yTmp(FREEZE_C), geom.tmpTop, geom.tmpBase));
  const frostY = r1(clamp(yTmp(FROST_C), geom.tmpTop, geom.tmpBase));

  // A few labelled gridlines on nice values, so the temperature curve can be
  // read as degrees rather than just "it goes down and turns white". Step is
  // picked to land 2-4 lines; 0 is skipped when the freezing line already draws
  // it in its own colour.
  const range = hi - lo;
  const step = range <= 6 ? 2 : range <= 16 ? 5 : 10;
  const showFreeze = lo < FREEZE_C && FREEZE_C < hi;
  const tempTicks = [];
  for (let v = Math.ceil(lo / step) * step; v < hi; v += step) {
    if (v <= lo || (v === FREEZE_C && showFreeze)) continue;
    tempTicks.push({ v, y: r1(yTmp(v)) });
  }

  return {
    geom, segments, ticks, breaks, hourW: r1(hourW),
    temp: {
      lo, hi, ticks: tempTicks,
      freezeY, frostY,
      iceHeight: r1(geom.tmpBase - freezeY),   // at or below 0°C
      frostHeight: r1(freezeY - frostY),        // 0°C to +3°C
      showFreeze,
      stopFreeze: stopAt(FREEZE_C),
      stopFrost: stopAt(FROST_C)
    }
  };
}

// precipitation + et0 feed the road-surface estimate; past_days=1 gives it yesterday's rain.
const HOURLY = 'temperature_2m,relative_humidity_2m,dew_point_2m,precipitation_probability,weathercode,windspeed_10m,precipitation,et0_fao_evapotranspiration';

// Forecasts per POINT (~1 km cells — the old 10 km grid would have merged a
// road's valley and summit into one forecast). Requests made close together are
// sent as one multi-location call, so a whole library costs one or two requests
// rather than one per point. Open-Meteo downscales each location to its own
// elevation, which is what makes the summit reading worth having.
export function createWeatherClient({
  fetchFn = (u, o) => fetchWithTimeout(u, o, 15000), now = () => new Date(),
  ttlMs = 30 * 60 * 1000, batchSize = 50, batchWindowMs = 25
} = {}) {
  const cache = new Map();   // cellKey -> {ts, promise}
  let queue = [];
  let timer = null;

  function flush() {
    timer = null;
    const batch = queue;
    queue = [];
    for (let i = 0; i < batch.length; i += batchSize) {
      const chunk = batch.slice(i, i + batchSize);
      const q = (key) => chunk.map(c => c[key].toFixed(4)).join(',');
      // forecast_days=3, not 2: the window starts at 00:00 TODAY, so 2 days ends
      // at 23:00 tomorrow and cuts tomorrow night (20:00→06:00) off after 4
      // hours. 3 days covers both nights in full.
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${q('lat')}&longitude=${q('lon')}&hourly=${HOURLY}&past_days=1&forecast_days=3&timezone=auto`;
      fetchFn(url)
        .then(r => { if (!r.ok) throw new Error('wx ' + r.status); return r.json(); })
        .then(json => {
          const list = Array.isArray(json) ? json : [json]; // one location → plain object
          if (list.length !== chunk.length) throw new Error('wx: unexpected response');
          chunk.forEach((c, k) => c.resolve(list[k]));
        })
        .catch(err => chunk.forEach(c => c.reject(err)));
    }
  }

  return {
    get(lat, lon) {
      const key = gridCellKey(lat, lon, 0.01);
      const hit = cache.get(key);
      if (hit && (now().getTime() - hit.ts) < ttlMs) return hit.promise;
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      cache.set(key, { ts: now().getTime(), promise });
      promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key); }); // don't cache failures
      queue.push({ lat, lon, resolve, reject });
      if (!timer) timer = setTimeout(flush, batchWindowMs);
      return promise;
    },
    clear() { cache.clear(); }
  };
}
