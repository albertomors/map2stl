// Forests as trees: OSM maps a wood as an area, not tree by tree, so its trees are placed
// here, on a jittered grid inside it (natural-looking, and the same every time for the same
// data), a little varied in size, none on a road or in water. In the print they make the
// forest a rough, raised texture; the spacing never drops below what the print can resolve,
// which also bounds how many there are.

import type { EditedTree } from './edits';
import { pointInRing, type LngLat } from './geo';
import type { Area, OsmData } from './osm';

// The green areas that are forest.
export const FOREST = /^(wood|forest)$/;
// Between trees, in the 3D view (the print may space them wider: see the export).
export const FOREST_SPACING_M = 12;
const HEIGHT_M = [12, 18];
const SIZE = [0.8, 1.3];
// Clear of roads by this much past their edge.
const ROAD_CLEARANCE_M = 2;
// Never more than this many, whatever the area.
const MAX_TREES = 40_000;
const METERS_PER_DEGREE = 111_320;

// `bare`: woods whose trees were deleted (the wood stays).
export function forestTrees(osm: OsmData, spacingM: number, bare: (id: string) => boolean = () => false): EditedTree[] {
  const forests = osm.green.filter((a) => FOREST.test(a.kind) && !bare(a.id));
  if (!forests.length) return [];
  const lat = forests[0].outer[0][1];
  const kLat = 1 / METERS_PER_DEGREE;
  const kLng = kLat / Math.cos((lat * Math.PI) / 180);
  const toM = ([lng, lat0]: LngLat): [number, number] => [lng / kLng, lat0 / kLat];
  const nearRoad = roadIndex(osm, toM);
  const water = osm.waterAreas.map((a) => ({ area: a, box: box(a) }));
  const inside = (a: Area, p: LngLat) => pointInRing(p, a.outer) && !a.holes.some((h) => pointInRing(p, h));
  const out: EditedTree[] = [];
  for (const forest of forests) {
    const [w, s, e, n] = box(forest);
    const [x0, y0] = toM([w, s]);
    const [x1, y1] = toM([e, n]);
    for (let gx = Math.floor(x0 / spacingM); gx <= Math.ceil(x1 / spacingM); gx++) {
      for (let gy = Math.floor(y0 / spacingM); gy <= Math.ceil(y1 / spacingM); gy++) {
        // Jitter, size and height from the grid cell: the same tree every time.
        const r = [hash(gx, gy, 1), hash(gx, gy, 2), hash(gx, gy, 3), hash(gx, gy, 4)];
        const mx = (gx + 0.15 + 0.7 * r[0]) * spacingM;
        const my = (gy + 0.15 + 0.7 * r[1]) * spacingM;
        const p: LngLat = [mx * kLng, my * kLat];
        if (!inside(forest, p)) continue;
        if (nearRoad(mx, my)) continue;
        if (water.some((wa) => p[0] >= wa.box[0] && p[0] <= wa.box[2] && p[1] >= wa.box[1] && p[1] <= wa.box[3] && inside(wa.area, p))) continue;
        out.push({
          key: `forest/${forest.id}/${gx},${gy}`,
          at: p,
          size: SIZE[0] + (SIZE[1] - SIZE[0]) * r[2],
          height: HEIGHT_M[0] + (HEIGHT_M[1] - HEIGHT_M[0]) * r[3],
        });
        if (out.length >= MAX_TREES) return out;
      }
    }
  }
  return out;
}

export const isForestTree = (key: string) => key.startsWith('forest/');

// Whether a point (meters) is on or next to a road: road segments bucketed into cells, so
// each tree checks only the few nearby.
function roadIndex(osm: OsmData, toM: (p: LngLat) => [number, number]) {
  const CELL = 50;
  const cells = new Map<string, [number, number, number, number, number][]>();
  for (const l of osm.roads) {
    if (l.bridge) continue;
    const reach = l.width / 2 + ROAD_CLEARANCE_M;
    const pts = l.path.map(toM);
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1];
      const [bx, by] = pts[i];
      for (let cx = Math.floor((Math.min(ax, bx) - reach) / CELL); cx <= Math.floor((Math.max(ax, bx) + reach) / CELL); cx++) {
        for (let cy = Math.floor((Math.min(ay, by) - reach) / CELL); cy <= Math.floor((Math.max(ay, by) + reach) / CELL); cy++) {
          const key = `${cx},${cy}`;
          const list = cells.get(key) ?? [];
          list.push([ax, ay, bx, by, reach]);
          cells.set(key, list);
        }
      }
    }
  }
  return (x: number, y: number) =>
    (cells.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`) ?? []).some(([ax, ay, bx, by, reach]) => {
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
      return Math.hypot(x - ax - t * dx, y - ay - t * dy) <= reach;
    });
}

function box(a: Area): [number, number, number, number] {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of a.outer) {
    w = Math.min(w, x);
    e = Math.max(e, x);
    s = Math.min(s, y);
    n = Math.max(n, y);
  }
  return [w, s, e, n];
}

// A number in [0, 1) from integers, the same every time.
function hash(x: number, y: number, k: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(k, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
