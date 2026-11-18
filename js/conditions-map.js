// js/conditions-map.js — the Tonight view's map.
//
// Every saved road is drawn in sections, one per forecast point (terrain.js
// withShares / splitRoadSections), each in the colour of THAT point's worst fog
// over the driving window. One side of a mountain fogged in shows as exactly
// that, instead of the whole road turning purple. Where a section gets near or
// below freezing it gets a pale outline, in the same two ice colours the night
// chart uses for its frost and ice bands.
//
// Fog is the line, ice the outline: the two never compete for the same channel.
//
// The outline colours depend on the base map. On the light map the chart's
// near-white ice colour vanished, so day mode uses two strong blues; on the
// night map those deep blues would sink into the dark instead, so night mode
// goes back to the chart's own pale frost/ice colours. (The legend swatches
// follow via CSS — see .lg-frost / .lg-ice.)
import { map, conditionsGroup, isNight, onNightChange } from './map.js';
import { fogColor } from './curvature.js';
import { splitRoadSections } from './terrain.js';
import { pointSummaries, FREEZE_C, FROST_C } from './weather.js';
import { setSavedRoadsMuted } from './planner.js';

export const OUTLINE = {
  day:   { frost: '#3d9be0', ice: '#1450b8' },
  night: { frost: '#7fc8e8', ice: '#d8f0fa' }
};
const EDGE = '#0a0c0e', NO_DATA = '#5a6a80';
const line = (latlngs, color, weight, opacity = 1) =>
  L.polyline(latlngs, { color, weight, opacity, interactive: false, lineCap: 'round', lineJoin: 'round' });

let shown = null; // the entries on the map right now, so a mode switch can redraw them
onNightChange(() => { if (shown) showConditionsOnMap(shown); });

// entries: [{ road, conditions }] (conditions null = no forecast).
export function showConditionsOnMap(entries) {
  shown = entries;
  conditionsGroup.clearLayers();
  const ring = OUTLINE[isNight() ? 'night' : 'day'];
  const outlines = [], edges = [], lines = [];
  for (const { road, conditions } of entries) {
    if (!conditions || !road.points?.length) continue;
    for (const { point, latlngs } of splitRoadSections(road.points, pointSummaries(conditions))) {
      if (point.temp != null && point.temp <= FROST_C)
        outlines.push(line(latlngs, point.temp <= FREEZE_C ? ring.ice : ring.frost, 15, 0.95));
      // A thin dark edge, so the pale fog colours (yellow, lavender) hold up on light tiles.
      edges.push(line(latlngs, EDGE, 7.5, 0.55));
      lines.push(line(latlngs, point.fog != null ? fogColor(point.fog) : NO_DATA, 5));
    }
  }
  // All outlines, then all edges, then all colours, so one road's outline never
  // paints over another road's colour where they cross.
  for (const l of [...outlines, ...edges, ...lines]) l.addTo(conditionsGroup);
  if (!map.hasLayer(conditionsGroup)) conditionsGroup.addTo(map);
  setSavedRoadsMuted(true);
  document.getElementById('map-legend')?.classList.add('on');
}

export function hideConditionsOnMap() {
  shown = null;
  conditionsGroup.clearLayers();
  conditionsGroup.remove();
  setSavedRoadsMuted(false);
  document.getElementById('map-legend')?.classList.remove('on');
}
