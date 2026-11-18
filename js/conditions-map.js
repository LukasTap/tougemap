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
// The outline blues are deliberately darker than the chart's ice bands: the
// chart sits on the dark panel, the map on light tiles, where the chart's
// near-white ice colour simply vanished.
import { map, conditionsGroup } from './map.js';
import { fogColor } from './curvature.js';
import { splitRoadSections } from './terrain.js';
import { pointSummaries, FREEZE_C, FROST_C } from './weather.js';
import { setSavedRoadsMuted } from './planner.js';

export const MAP_FROST = '#3d9be0', MAP_ICE = '#1450b8';
const EDGE = '#0a0c0e', NO_DATA = '#5a6a80';
const line = (latlngs, color, weight, opacity = 1) =>
  L.polyline(latlngs, { color, weight, opacity, interactive: false, lineCap: 'round', lineJoin: 'round' });

// entries: [{ road, conditions }] (conditions null = no forecast).
export function showConditionsOnMap(entries) {
  conditionsGroup.clearLayers();
  const outlines = [], edges = [], lines = [];
  for (const { road, conditions } of entries) {
    if (!conditions || !road.points?.length) continue;
    for (const { point, latlngs } of splitRoadSections(road.points, pointSummaries(conditions))) {
      if (point.temp != null && point.temp <= FROST_C)
        outlines.push(line(latlngs, point.temp <= FREEZE_C ? MAP_ICE : MAP_FROST, 15, 0.95));
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
  conditionsGroup.clearLayers();
  conditionsGroup.remove();
  setSavedRoadsMuted(false);
  document.getElementById('map-legend')?.classList.remove('on');
}
