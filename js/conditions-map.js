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
import { map, conditionsGroup } from './map.js';
import { fogColor } from './curvature.js';
import { splitRoadSections } from './terrain.js';
import { pointSummaries, FREEZE_C, FROST_C } from './weather.js';
import { setSavedRoadsMuted } from './planner.js';

const ICE = '#d8f0fa', FROST = '#7fc8e8', NO_DATA = '#5a6a80';

// entries: [{ road, conditions }] (conditions null = no forecast).
export function showConditionsOnMap(entries) {
  conditionsGroup.clearLayers();
  const casings = [], lines = [];
  for (const { road, conditions } of entries) {
    if (!conditions || !road.points?.length) continue;
    for (const { point, latlngs } of splitRoadSections(road.points, pointSummaries(conditions))) {
      if (point.temp != null && point.temp <= FROST_C)
        casings.push(L.polyline(latlngs, { color: point.temp <= FREEZE_C ? ICE : FROST, weight: 11, opacity: 0.85, interactive: false, lineCap: 'round', lineJoin: 'round' }));
      lines.push(L.polyline(latlngs, { color: point.fog != null ? fogColor(point.fog) : NO_DATA, weight: 5, opacity: 1, interactive: false, lineCap: 'round', lineJoin: 'round' }));
    }
  }
  // All outlines first, then all lines, so one road's outline never paints over
  // another road's colour where they cross.
  for (const l of [...casings, ...lines]) l.addTo(conditionsGroup);
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
