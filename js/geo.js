// js/geo.js — pure geometry helpers, no browser deps
const R_KM = 6371;
const d2r = Math.PI / 180;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * d2r, dLon = (lon2 - lon1) * d2r;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dLon / 2) ** 2;
  return R_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function polylineKm(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++)
    d += haversineKm(points[i-1].lat, points[i-1].lon, points[i].lat, points[i].lon);
  return d;
}

export function bearingLabel(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * d2r;
  const y = Math.sin(dLon) * Math.cos(lat2 * d2r);
  const x = Math.cos(lat1 * d2r) * Math.sin(lat2 * d2r) -
            Math.sin(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.cos(dLon);
  const b = (Math.atan2(y, x) / d2r + 360) % 360;
  return ['N','NE','E','SE','S','SW','W','NW'][Math.round(b / 45) % 8];
}

export function gridCellKey(lat, lon, cellDeg = 0.1) {
  const q = (v) => (Math.round(v / cellDeg) * cellDeg).toFixed(2);
  return `${q(lat)},${q(lon)}`;
}

export function simplifyForThumbnail(points, maxPoints = 40) {
  if (points.length <= maxPoints) return points.slice();
  if (maxPoints <= 1) return [points[points.length - 1]];
  const stride = (points.length - 1) / (maxPoints - 1);
  const out = [];
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.round(i * stride)]);
  out[out.length - 1] = points[points.length - 1];
  return out;
}
