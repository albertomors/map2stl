// The worldwide terrain tiles are partly built from radar surface models (SRTM), which take
// the top of a big building for the ground: the Colosseum and St. Peter's stand in smooth
// hills of their own shape, the arena filled up, the nave buried to the drum. Under each big
// building, the ground goes down to the level measured just around it.

import { distance, pointInRing, ringArea, type LngLat } from './geo';
import type { Building } from './osm';
import { lngLatPixel, type Terrain } from './terrain';

// Smaller buildings make no bump the tiles (about 30 m apart underneath) can show.
const MIN_AREA_M2 = 1000;
// How far the bump spreads past the walls (more for a bigger building: St. Peter's spreads
// over 20 m), and how wide a ring around that is read for the ground.
const SKIRT_M = 15;
const SKIRT_PER_SIDE = 0.15;
const GROUND_RING_M = 40;
// The ground: low in that ring (it still climbs the bump's flank), not its lowest point
// (a ditch or a sunken street).
const GROUND_PERCENTILE = 0.2;
// A bump lower than this is just the ground's own shape.
const MIN_BUMP_M = 4;

export function withoutBuildingBumps(t: Terrain, buildings: Building[]): Terrain {
  // A building in parts is one bump: its parts together.
  const groups = new Map<string, LngLat[][]>();
  for (const b of buildings) {
    if (ringArea(b.outer) < MIN_AREA_M2 && !b.group) continue;
    const key = b.group ?? b.id;
    groups.set(key, [...(groups.get(key) ?? []), b.outer]);
  }
  const midLat = (t.bbox[1] + t.bbox[3]) / 2;
  const metersPerPx = distance([t.bbox[0], midLat], [t.bbox[2], midLat]) / t.width;
  const heights = t.heights.slice();
  let changed = false;

  for (const outlines of groups.values()) {
    const area = outlines.reduce((sum, o) => sum + ringArea(o), 0);
    if (area < MIN_AREA_M2) continue;
    const skirt = Math.max(SKIRT_M, SKIRT_PER_SIDE * Math.sqrt(area)) / metersPerPx;
    const ring = GROUND_RING_M / metersPerPx;
    const rings = outlines.map((o) => o.map((p) => lngLatPixel(t, p)));
    const xs = rings.flat().map((p) => p[0]);
    const ys = rings.flat().map((p) => p[1]);
    const reach = skirt + ring;
    const [c0, c1] = [Math.max(0, Math.floor(Math.min(...xs) - reach)), Math.min(t.width - 1, Math.ceil(Math.max(...xs) + reach))];
    const [r0, r1] = [Math.max(0, Math.floor(Math.min(...ys) - reach)), Math.min(t.height - 1, Math.ceil(Math.max(...ys) + reach))];
    // Each grid point: under the building or its skirt (with how far out), around it (the
    // ground), or neither.
    const under: [number, number][] = [];
    const around: number[] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const p: [number, number] = [c, r];
        const d = rings.some((o) => pointInRing(p, o)) ? 0 : Math.min(...rings.map((o) => distanceToRing(p, o)));
        if (d <= skirt) under.push([r * t.width + c, d / skirt]);
        else if (d <= reach) around.push(heights[r * t.width + c]);
      }
    }
    if (!under.length || !around.length) continue;
    const ground = percentile(around, GROUND_PERCENTILE);
    if (Math.max(...under.map(([i]) => heights[i])) - ground < MIN_BUMP_M) continue;
    // Down to the ground under the walls, easing back to the tiles' own heights at the
    // skirt's edge: no step where the flattening ends.
    for (const [i, f] of under) heights[i] = Math.min(heights[i], ground + f * Math.max(0, heights[i] - ground));
    changed = true;
  }
  if (!changed) return t;
  let [min, max] = [Infinity, -Infinity];
  for (const h of heights) {
    if (h < min) min = h;
    if (h > max) max = h;
  }
  return { ...t, heights, min, max };
}

function distanceToRing([x, y]: [number, number], ring: [number, number][]): number {
  let best = Infinity;
  for (let i = 1; i < ring.length; i++) {
    const [ax, ay] = ring[i - 1];
    const [bx, by] = ring[i];
    const [vx, vy] = [bx - ax, by - ay];
    const len = vx * vx + vy * vy;
    const f = len ? Math.min(1, Math.max(0, ((x - ax) * vx + (y - ay) * vy) / len)) : 0;
    best = Math.min(best, Math.hypot(x - ax - f * vx, y - ay - f * vy));
  }
  return best;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * p)];
}
