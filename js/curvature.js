// js/curvature.js
// VERBATIM port of the road-curvature engine from H:\tougemap.html (v1),
// itself a port of adamfranco/curvature (roadcurvature.com pipeline).
// Do NOT alter any numeric constant, threshold, or branch here — see
// .superpowers/sdd/constraints.md ("Keep the curvature algorithm verbatim").

import { fetchWithTimeout } from './http.js';

// Port of v1 L558-566
export function distOnEarth(lat1, lon1, lat2, lon2) {
  if(lat1===lat2 && lon1===lon2) return 0;
  const d2r = Math.PI/180;
  const phi1=(90-lat1)*d2r, phi2=(90-lat2)*d2r;
  const t1=lon1*d2r, t2=lon2*d2r;
  let cos = Math.sin(phi1)*Math.sin(phi2)*Math.cos(t1-t2) + Math.cos(phi1)*Math.cos(phi2);
  if(cos>1) cos=1;
  return Math.acos(cos)*6373000;
}

// Port of v1 L568-575
export function circumCircleRadius(a, b, c) {
  // From radiusmath.py - side lengths of triangle
  if(a>0 && b>0 && c>0){
    const d = Math.sqrt(Math.abs((a+b+c)*(b+c-a)*(c+a-b)*(a+b-c)));
    return d>0 ? (a*b*c)/d : 10000;
  }
  return 10000;
}

// Port of v1 L577-583
export function segmentWeight(radius) {
  if(radius < 30)  return {level:4, weight:2.0};
  if(radius < 60)  return {level:3, weight:1.6};
  if(radius < 100) return {level:2, weight:1.3};
  if(radius < 175) return {level:1, weight:1.0};
  return {level:0, weight:0};
}

// squash_curvature_near_way_tag_change --tag oneway --ignored-values 'no' --distance 30
// Zeros curvature within `distance` metres of where the oneway tag changes between ways.
// This eliminates the fake "curve" at village entry points where roads go from two-way to one-way.
// Port of v1 L588-608
export function squashNearOnewayChange(segs, waySegOffsets, distance) {
  const onewayVal = (way) => (way.oneway && way.oneway !== 'no') ? way.oneway : null;
  for(let i=1; i<waySegOffsets.length; i++){
    const prev = waySegOffsets[i-1];
    const curr = waySegOffsets[i];
    if(onewayVal(prev.way) === onewayVal(curr.way)) continue;
    // Tag changed — squash within `distance` metres forward and backward from junction
    // Backward from junction (end of prev way)
    let remaining = distance;
    for(let s = prev.start + prev.count - 1; s >= prev.start && remaining > 0; s--){
      segs[s].curvature = 0; segs[s].curvature_level = 0;
      remaining -= segs[s].length;
    }
    // Forward from junction (start of curr way)
    remaining = distance;
    for(let s = curr.start; s < curr.start + curr.count && remaining > 0; s++){
      segs[s].curvature = 0; segs[s].curvature_level = 0;
      remaining -= segs[s].length;
    }
  }
}

// Squash curvature on ways tagged as roundabouts/junctions.
// Port of squash_curvature_for_tagged_ways --tag junction --values roundabout,circular
// Port of v1 L612-616
export function squashCurvatureForJunctions(way, segs) {
  if(way.junction === 'roundabout' || way.junction === 'circular'){
    for(const seg of segs){ seg.curvature = 0; seg.curvature_level = 0; }
  }
}

// Squash curvature for traffic_calming ways
// Port of v1 L619-623
export function squashCurvatureForTrafficCalming(way, segs) {
  if(way.traffic_calming){
    for(const seg of segs){ seg.curvature = 0; seg.curvature_level = 0; }
  }
}

// Build segments with length, radius, curvature_level, curvature
// coords: array of [lat,lon] pairs
// Port of v1 L627-663
export function buildSegments(coords) {
  if(coords.length < 2) return [];
  const segs = [];
  // Create segment objects
  for(let i=0; i<coords.length-1; i++){
    segs.push({
      start: coords[i],
      end:   coords[i+1],
      length: distOnEarth(coords[i][0],coords[i][1],coords[i+1][0],coords[i+1][1]),
      radius: 10000,
      curvature_level: 0,
      curvature: 0
    });
  }
  // Calculate radii (exact port of add_segment_length_and_radius.py)
  for(let i=0; i<segs.length; i++){
    const next = segs[i+1];
    if(!next) break;
    const base = distOnEarth(segs[i].start[0],segs[i].start[1],next.end[0],next.end[1]);
    const r = circumCircleRadius(segs[i].length, next.length, base);
    if(i===0){
      segs[i].radius = r;
    } else if(segs[i].radius > r){
      segs[i].radius = r;
    }
    next.radius = r;
  }
  // Cap at MAX_RADIUS
  for(const seg of segs) if(seg.radius > 10000) seg.radius = 10000;
  // Apply curvature weights
  for(const seg of segs){
    const {level,weight} = segmentWeight(seg.radius);
    seg.curvature_level = level;
    seg.curvature = level > 0 ? seg.length * weight : 0;
  }
  return segs;
}

// Filter deflections (port of filter_segment_deflections.py)
// A "deflection" is a small jog on an otherwise straight section - digitization noise.
// Port of v1 L667-673
export function filterDeflections(segs) {
  for(let i=0; i<segs.length; i++){
    for(const lookAhead of [3,4,5,6,7]){
      filterDeflection(segs, i, lookAhead);
    }
  }
}

// Port of v1 L675-677
export function segHeading(seg){
  return 180 + Math.atan2(seg.end[0]-seg.start[0], seg.end[1]-seg.start[1]) * (180/Math.PI);
}

// Port of v1 L679-695
export function filterDeflection(segs, start, lookAhead){
  if(start+lookAhead >= segs.length) return;
  const first = segs[start];
  const last  = segs[start+lookAhead];
  if((first.curvature_level && !first.curvature_filtered) || (last.curvature_level && !last.curvature_filtered)) return;
  const ha = segHeading(first), hb = segHeading(last);
  const diff = Math.abs(ha-hb);
  const gapDist = distOnEarth(first.end[0],first.end[1],last.start[0],last.start[1]);
  const minVariance = gapDist / 175; // level_1_max_radius
  if(diff < minVariance){
    for(let i=start; i<start+lookAhead; i++){
      if(segs[i].curvature_level) segs[i].curvature_filtered = true;
      segs[i].curvature_level = 0;
      segs[i].curvature = 0;
    }
  }
}

// Split a segment array on straight runs > threshold metres (port of split_collections_on_straight_segments.py)
// Returns array of coord-arrays (each being a sub-collection to score separately)
// Port of v1 L699-753
export function splitOnStraights(coords, segs, threshold=2414) {
  // Exact port of SplitCollectionsOnStraightSegments.process()
  // Operates on segments (which already have curvature_level set).
  // Returns array of {coords, segs} objects — straight sub-collections have
  // near-zero curvature and will be filtered out by the curvature>=300 check.
  if(!segs.length) return [{coords, segs}];

  const results = [];
  let resultSegs = [];
  let straightBuffer = [];
  let straightDist = 0;

  const flushResult = (segArr) => {
    if(!segArr.length) return;
    // Reconstruct coords from segment start/end points
    const c = [segArr[0].start, ...segArr.map(s => s.end)];
    results.push({coords: c, segs: segArr});
  };

  for(const seg of segs){
    // Split trigger: entering a curve after a long straight
    if(seg.curvature_level > 0 && straightDist > threshold){
      flushResult(resultSegs);
      flushResult(straightBuffer);
      resultSegs = [];
      straightBuffer = [];
      straightDist = 0;
    }

    if(seg.curvature_level > 0){
      // Curvy segment: absorb any short straight buffer back into result
      if(straightBuffer.length){
        resultSegs.push(...straightBuffer);
        straightBuffer = [];
        straightDist = 0;
      }
      resultSegs.push(seg);
    } else {
      // Straight segment: buffer it
      straightDist += seg.length;
      straightBuffer.push(seg);
    }
  }

  // Handle trailing straight
  if(straightDist > threshold){
    flushResult(resultSegs);
    flushResult(straightBuffer);
  } else {
    resultSegs.push(...straightBuffer);
    flushResult(resultSegs);
  }

  return results.length ? results : [{coords, segs}];
}

// Calculate total curvature from segments
// Port of v1 L780-782
export function totalCurvatureFromSegs(segs){
  return segs.reduce((sum,s)=>sum+s.curvature, 0);
}

// Port of v1 L810-826
export function curvColor(c){
  // Exact port of roadcurvature.com's SingleColorKmlOutput color formula.
  // Their web map uses: --min_curvature 300 --max_curvature 20000
  // Logarithmic scale compresses the range so most roads show yellow/orange.
  const MIN = 300, MAX = 20000;
  if(c <= MIN) return '#ffff00';
  const curvPct = Math.min((c - MIN) / (MAX - MIN), 1);
  const colorPct = 1 - 1/Math.pow(10, curvPct * 2);
  const level = Math.round(510 * colorPct) + 1;
  if(level <= 255){
    const g = 255 - (level - 1);
    return `rgb(255,${g},0)`;       // yellow → red
  } else {
    const b = level - 255;
    return `rgb(255,0,${b})`;       // red → magenta
  }
}

// Port of v1 L827-832
export function fogColor(r){
  if(r<30) return '#3ecf6e';
  if(r<60) return '#f5c842';
  if(r<80) return '#8090c8';
  return '#c8b4ff';
}

// ── COLLECTOR JOIN + POST-PROCESSING PIPELINE ────────────────────────────────
// Pure port of the body of v1 loadRoads() (v1 L881-1162), with all setStatus/DOM/
// fetch calls removed — those belong to the caller. Takes the parsed Overpass
// `json.elements` array and returns the scored `collections` array
// (curvature >= 300). Logic is otherwise unchanged from v1.
export function joinAndScore(elements) {
  // ── EXACT PORT OF collector.py join_ways() ──────────────────────────────────
  // Group ways by ref or name into route buckets.
  // Unnamed ways go directly into collections as single-way entries.
  // Joining uses OSM node refs (integer IDs), not coordinate strings.

  const routes = new Map(); // key -> {join_type, join_data, ways:[]}
  const singletons = [];   // unnamed ways

  // Separate node elements (have lat/lon) from way elements (have nodes[])
  const nodeMap = new Map(); // node_id -> [lat, lon]
  const wayElements = [];
  for(const el of elements){
    if(el.type === 'node'){
      nodeMap.set(el.id, [el.lat, el.lon]);
    } else if(el.type === 'way'){
      wayElements.push(el);
    }
  }

  for(const el of wayElements){
    if(!el.nodes || el.nodes.length < 2) continue;
    // filter_out_ways_with_tag --tag service (driveways, parking aisles, etc.)
    const svcTag = el.tags?.service||'';
    if(['driveway','parking_aisle','drive-through','parking','bus','emergency_access','alley'].includes(svcTag)) continue;
    // filter_out_ways_with_tag --tag access --values 'no'
    if(el.tags?.access === 'no' || el.tags?.vehicle === 'no' || el.tags?.motor_vehicle === 'no') continue;
    // Use actual OSM node IDs as refs (exact match with their Python code)
    const refs = el.nodes; // integer node IDs
    const coords = refs.map(id => nodeMap.get(id)).filter(Boolean);
    if(coords.length < 2) continue;
    const tags = el.tags || {};
    const way = {
      id: el.id,
      coords,
      refs,
      name: tags.name||'',
      ref:  tags.ref||tags.official_ref||tags.admin_ref||tags.highway_ref||'',
      highway: tags.highway||'',
      surface: tags.surface||'',
      oneway: tags.oneway||'',
      junction: tags.junction||'',
    };

    // Sort key mirrors way_sort_key() from collector.py
    // Two-way non-junction ways first, then one-ways, then roundabouts
    let groupKey = 'a';
    if(way.oneway==='yes') groupKey='b';
    if(way.highway.includes('_link')) groupKey='c';
    if(way.junction==='roundabout'||way.junction==='circular') groupKey='z';
    else if(way.junction && way.oneway==='yes') groupKey='y';
    else if(way.junction) groupKey='x';
    const hwOrder = {motorway:'a',trunk:'b',primary:'c',secondary:'d',tertiary:'e',unclassified:'f',residential:'g'};
    const hwKey = Object.entries(hwOrder).find(([k])=>way.highway.includes(k))?.[1]||'h';
    way._sortKey = `${groupKey}${hwKey}-${String(el.id).padStart(20,'0')}`;

    // Join ONLY by name tag (not ref).
    // Ref tags like "526" are national route numbers spanning 100s of km —
    // joining all ways with the same ref creates one giant chain across the country.
    // Name tags identify the actual physical road segment (e.g. "Cesta na Muráň").
    // Unnamed ways stay as individual singletons.
    if(way.name){
      if(!routes.has(way.name)) routes.set(way.name, {join_type:'name', join_data:way.name, ways:[]});
      routes.get(way.name).ways.push(way);
    } else {
      singletons.push(way);
    }
  }

  // Join each route's ways (exact port of join_ways())
  const rawCollections = []; // {join_type, ways:[way,...]}

  // For unnamed ways: join through non-junction endpoint nodes.
  // Count how many ways reference each endpoint node (degree map).
  // degree==1: dead end. degree==2: road continues. degree>=3: junction — stop joining.
  const endpointDegree = new Map(); // nodeId -> count of ways using it as endpoint
  for(const w of singletons){
    const s = w.refs[0], e = w.refs[w.refs.length-1];
    endpointDegree.set(s, (endpointDegree.get(s)||0)+1);
    endpointDegree.set(e, (endpointDegree.get(e)||0)+1);
  }

  // Build endpoint index for singletons: nodeId -> [{way, end:'start'|'end'}]
  const anonEndpointIndex = new Map();
  for(const w of singletons){
    const s = w.refs[0], e = w.refs[w.refs.length-1];
    if(!anonEndpointIndex.has(s)) anonEndpointIndex.set(s, []);
    if(!anonEndpointIndex.has(e)) anonEndpointIndex.set(e, []);
    anonEndpointIndex.get(s).push({way:w, end:'start'});
    anonEndpointIndex.get(e).push({way:w, end:'end'});
  }

  const usedAnon = new Set();
  for(const seedWay of singletons){
    if(usedAnon.has(seedWay.id)) continue;
    usedAnon.add(seedWay.id);
    let chain = [seedWay];

    // Extend forward through non-junction nodes
    let extended = true;
    while(extended){
      extended = false;
      const tail = chain[chain.length-1];
      const tailNode = tail.refs[tail.refs.length-1];
      if((endpointDegree.get(tailNode)||0) >= 3) break; // junction — stop
      const candidates = (anonEndpointIndex.get(tailNode)||[]).filter(
        c => !usedAnon.has(c.way.id) && c.way.highway === seedWay.highway
      );
      if(candidates.length === 1){ // only join if unambiguous (degree==2)
        const {way:nw, end} = candidates[0];
        usedAnon.add(nw.id);
        if(end==='start') chain.push(nw);
        else chain.push({...nw, refs:[...nw.refs].reverse(), coords:[...nw.coords].reverse()});
        extended = true;
      }
    }

    // Extend backward through non-junction nodes
    extended = true;
    while(extended){
      extended = false;
      const head = chain[0];
      const headNode = head.refs[0];
      if((endpointDegree.get(headNode)||0) >= 3) break; // junction — stop
      const candidates = (anonEndpointIndex.get(headNode)||[]).filter(
        c => !usedAnon.has(c.way.id) && c.way.highway === seedWay.highway
      );
      if(candidates.length === 1){
        const {way:nw, end} = candidates[0];
        usedAnon.add(nw.id);
        if(end==='end') chain.unshift(nw);
        else chain.unshift({...nw, refs:[...nw.refs].reverse(), coords:[...nw.coords].reverse()});
        extended = true;
      }
    }

    rawCollections.push({join_type:'none', ways:chain});
  }

  for(const [routeKey, routeData] of routes){
    // Sort ways per way_sort_key
    const ways = [...routeData.ways].sort((a,b)=>a._sortKey<b._sortKey?-1:1);
    const remaining = [...ways];

    while(remaining.length > 0){
      const collection = {join_type:routeData.join_type, join_data:routeData.join_data, ways:[remaining.shift()]};
      const collectionRefs = new Set(collection.ways[0].refs);

      let collectionModified = true;
      let maxLoop = remaining.length;
      let j = 0;

      while(collectionModified && j < maxLoop){
        j++;
        collectionModified = false;
        const unused = [];

        while(remaining.length > 0){
          const way = remaining.shift();
          const collWays = collection.ways;
          const lastRefs = collWays[collWays.length-1].refs;
          const firstRefs = collWays[0].refs;
          let modifiedThisPass = false;

          // join to the end in order
          if(lastRefs[lastRefs.length-1] === way.refs[0] && !collectionRefs.has(way.refs[way.refs.length-1])){
            collection.ways.push(way);
            way.refs.forEach(r=>collectionRefs.add(r));
            collectionModified = modifiedThisPass = true;
          }
          // join to the end in reverse
          else if(lastRefs[lastRefs.length-1] === way.refs[way.refs.length-1] && !collectionRefs.has(way.refs[0])){
            const rev = {...way, refs:[...way.refs].reverse(), coords:[...way.coords].reverse()};
            collection.ways.push(rev);
            rev.refs.forEach(r=>collectionRefs.add(r));
            collectionModified = modifiedThisPass = true;
          }
          // join to the beginning in order
          else if(firstRefs[0] === way.refs[way.refs.length-1] && !collectionRefs.has(way.refs[0])){
            collection.ways.unshift(way);
            way.refs.forEach(r=>collectionRefs.add(r));
            collectionModified = modifiedThisPass = true;
          }
          // join to the beginning in reverse
          else if(firstRefs[0] === way.refs[0] && !collectionRefs.has(way.refs[way.refs.length-1])){
            const rev = {...way, refs:[...way.refs].reverse(), coords:[...way.coords].reverse()};
            collection.ways.unshift(rev);
            rev.refs.forEach(r=>collectionRefs.add(r));
            collectionModified = modifiedThisPass = true;
          }
          else {
            unused.push(way);
          }

          if(modifiedThisPass){
            // Restart with the unused ways at front (match their behavior)
            remaining.unshift(...unused.splice(0));
          }
        }
        remaining.push(...unused);
      }
      rawCollections.push(collection);
    }
  }

  // ── POST-PROCESSING PIPELINE (mirrors their processing chain) ────────────────
  // For each raw collection:
  // 1. Flatten all way coords into one coordinate array
  // 2. Build segments with length+radius (add_segment_length_and_radius)
  // 3. Add curvature per segment (add_segment_curvature)
  // 4. Filter deflections (filter_segment_deflections)
  // 5. Split on straights > 2414m (split_collections_on_straight_segments)
  // 6. Roll up curvature + length per sub-collection (roll_up_curvature / roll_up_length)
  // 7. Filter by curvature >= 300 (filter_collections_by_curvature)

  const collections = [];

  for(const raw of rawCollections){
    // 1. Flatten coords (deduplicate joining seam points)
    let allCoords = [];
    for(let wi=0; wi<raw.ways.length; wi++){
      const wc = raw.ways[wi].coords;
      if(wi===0) allCoords.push(...wc);
      else allCoords.push(...wc.slice(1)); // skip first point (duplicate of prev last)
    }
    if(allCoords.length < 3) continue;

    // 2+3. Build segments with radius + curvature, then squash junctions/calming
    const segs = buildSegments(allCoords);
    // Squash curvature for each way's segments (roundabouts, traffic calming)
    // Port of squash_curvature_for_tagged_ways steps from adams_default.sh
    let segOffset = 0;
    const waySegOffsets = []; // track each way's seg range for the oneway squash
    for(const way of raw.ways){
      const waySegCount = Math.max(0, way.coords.length - 1);
      const waySegs = segs.slice(segOffset, segOffset + waySegCount);
      squashCurvatureForJunctions(way, waySegs);
      squashCurvatureForTrafficCalming(way, waySegs);
      waySegOffsets.push({way, start: segOffset, count: waySegCount});
      segOffset += waySegCount;
    }
    // squash_curvature_near_way_tag_change --tag oneway --ignored-values 'no' --distance 30
    // Zero curvature within 30m of where the oneway tag changes between adjacent ways
    squashNearOnewayChange(segs, waySegOffsets, 30);

    // 4. Filter deflections
    filterDeflections(segs);

    // 5. Split on straights — returns {coords, segs} pairs
    const subCollections = splitOnStraights(allCoords, segs, 2414);

    // 6+7. Score each sub-collection using already-calculated segment curvatures
    for(const {coords: subCoords, segs: subSegs} of subCollections){
      if(subCoords.length < 2) continue;
      const curvature = Math.round(totalCurvatureFromSegs(subSegs));
      if(curvature < 300) continue; // filter_collections_by_curvature --min 300

      const km = subSegs.reduce((s,seg)=>s+seg.length,0) / 1000;
      if(km < 0.3) continue;

      const way0 = raw.ways[0];
      const surf = way0.surface.toLowerCase();
      const knownPaved   = ['asphalt','concrete','paved','tarmac','cobblestone'].some(s=>surf.includes(s));
      const knownUnpaved = ['unpaved','dirt','gravel','sand','grass','ground','mud','clay'].some(s=>surf.includes(s));
      const surfaceClass = knownUnpaved?'unpaved':knownPaved?'paved':'unknown';

      const mi = Math.floor(subCoords.length/2);
      collections.push({
        id: `${way0.id}_${collections.length}`,
        coords: subCoords,
        curvature,
        length: km,
        name: way0.name,
        ref: way0.ref,
        highway: way0.highway,
        surface: way0.surface,
        surfaceClass,
        midLat: subCoords[mi][0],
        midLon: subCoords[mi][1],
        fogRisk: undefined
      });
    }
  }

  return collections;
}

// tail of js/curvature.js — network wrapper kept separate from pure pipeline
export function buildOverpassQuery(regions, types) {
  // regions: [{bbox:'w,s,e,n'}], types: ['secondary',...]  (ported from v1 L845–855)
  const parts = regions.flatMap(r => {
    const [w, s, e, n] = r.bbox.split(',');
    return types.map(tp =>
      `way["highway"="${tp}"]["junction"!="roundabout"]["area"!="yes"](${s},${w},${n},${e});`);
  });
  return `[out:json][timeout:90];\n(\n${parts.join('\n')}\n);\nout body;\n>;\nout skel qt;`;
}

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];

export async function fetchOverpass(query, mirrors = OVERPASS_MIRRORS) {
  for (const ep of mirrors) {
    try {
      const res = await fetchWithTimeout(ep, { method: 'POST', body: 'data=' + encodeURIComponent(query) }, 25000);
      if (res.ok) return (await res.json()).elements;
    } catch { /* try next mirror */ }
  }
  throw new Error('All Overpass mirrors failed');
}
