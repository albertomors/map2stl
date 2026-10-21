// Cuts the fetched data to the selection outline, like a cookie cutter, so nothing in the
// model sticks out past the tile edge: areas and buildings are intersected with the outline,
// lines are cut where they cross it. Buildings cut at the edge get a flat roof (half a
// pitched roof would look wrong) and a flat face along the edge.

import polygonClipping, { type Polygon as PcPolygon } from 'polygon-clipping';
import { pointInRing, segmentsCross, type LngLat } from './geo';
import type { Area, Building, Line, OsmData, Polygon, StructureArea, StructureLine } from './osm';

export function clipToSelection(osm: OsmData, ring: LngLat[]): OsmData {
  const shape: PcPolygon = [ring];
  const areas = <T extends Polygon>(items: T[]): T[] => items.flatMap((a) => clipPolygon(a, shape, ring).map((p) => ({ ...a, ...p })));
  const lines = <T extends Line>(items: T[]): T[] =>
    items.flatMap((l) => clipLine(l.path, ring).map((path) => ({ ...l, path, ends: l.ends ?? [l.path[0], l.path[l.path.length - 1]] })));
  return {
    ...osm,
    buildings: clipBuildings(osm.buildings, ring),
    roads: lines(osm.roads),
    railways: lines(osm.railways),
    waterAreas: areas<Area>(osm.waterAreas),
    waterways: lines(osm.waterways),
    green: areas<Area>(osm.green),
    structureLines: lines<StructureLine>(osm.structureLines),
    structureAreas: areas<StructureArea>(osm.structureAreas),
    surfaces: areas<Area>(osm.surfaces),
    pavedAreas: areas<Area>(osm.pavedAreas),
    pavedLines: lines(osm.pavedLines),
  };
}

// The polygon itself when it's wholly inside (the common case, and cheap), else its pieces.
function clipPolygon(p: Polygon, shape: PcPolygon, ring: LngLat[]): Polygon[] {
  if (p.outer.every((q) => pointInRing(q, ring)) && !ringsCross(p.outer, ring)) return [p];
  const result = polygonClipping.intersection([p.outer, ...p.holes] as PcPolygon, shape);
  return result.map(([outer, ...holes]) => ({ outer: outer as LngLat[], holes: holes as LngLat[][] }));
}

// Just what the 3D view rebuilds after an edit: buildings, bridges and structures. (Areas
// and ground lines don't change with edits and are cut once.)
export function clipObjects(osm: OsmData, ring: LngLat[]): Pick<OsmData, 'buildings' | 'roads' | 'railways' | 'structureAreas' | 'structureLines' | 'towers'> {
  const shape: PcPolygon = [ring];
  const lines = <T extends Line>(items: T[]): T[] =>
    items.flatMap((l) => clipLine(l.path, ring).map((path) => ({ ...l, path, ends: l.ends ?? [l.path[0], l.path[l.path.length - 1]] })));
  return {
    buildings: clipBuildings(osm.buildings, ring),
    roads: lines(osm.roads.filter((l) => l.bridge)),
    railways: lines(osm.railways.filter((l) => l.bridge)),
    structureAreas: osm.structureAreas.flatMap((a) => clipPolygon(a, shape, ring).map((p) => ({ ...a, ...p }))),
    structureLines: lines(osm.structureLines),
    towers: osm.towers,
  };
}

// Buildings crossing the edge are cut there and get a flat roof (half a pitched roof looks
// wrong); the pieces keep their building's id, so edits still find them.
export function clipBuildings(buildings: Building[], ring: LngLat[]): Building[] {
  const shape: PcPolygon = [ring];
  return buildings.flatMap((b): Building[] => {
    const pieces = clipPolygon(b, shape, ring);
    const cut = pieces.length !== 1 || pieces[0] !== b;
    return pieces.map((p) => ({ ...b, ...p, ...(cut ? { roofShape: 'flat', roofHeight: undefined } : {}) }));
  });
}

// Pieces of the path inside the ring: split at every crossing, keep the inside parts.
export function clipLine(path: LngLat[], ring: LngLat[]): LngLat[][] {
  const pieces: LngLat[][] = [];
  let current: LngLat[] = [];
  const flush = () => {
    if (current.length > 1) pieces.push(current);
    current = [];
  };
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    // Crossing points along a→b, in order.
    const cuts: { t: number; p: LngLat }[] = [];
    for (let j = 1; j < ring.length; j++) {
      const t = crossingT(a, b, ring[j - 1], ring[j]);
      if (t !== null) cuts.push({ t, p: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] });
    }
    cuts.sort((x, y) => x.t - y.t);
    const stops = [{ t: 0, p: a }, ...cuts, { t: 1, p: b }];
    for (let k = 1; k < stops.length; k++) {
      const s = stops[k - 1];
      const e = stops[k];
      const mid: LngLat = [(s.p[0] + e.p[0]) / 2, (s.p[1] + e.p[1]) / 2];
      if (pointInRing(mid, ring)) {
        if (!current.length) current.push(s.p);
        current.push(e.p);
      } else {
        flush();
      }
    }
  }
  flush();
  return pieces;
}

// Where segment a→b crosses c→d, as a fraction along a→b, or null.
function crossingT(a: LngLat, b: LngLat, c: LngLat, d: LngLat): number | null {
  if (!segmentsCross(a, b, c, d)) return null;
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  return ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / (rx * sy - ry * sx);
}

function ringsCross(a: LngLat[], b: LngLat[]): boolean {
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) if (segmentsCross(a[i - 1], a[i], b[j - 1], b[j])) return true;
  }
  return false;
}
