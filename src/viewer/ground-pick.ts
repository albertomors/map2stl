// What's under a point on the ground: the street, railway, river, square, park or sandy
// area there, top to bottom in the order the ground is painted (so what's seen is what's
// picked). Bridges aren't here: they're objects, picked as meshes.

import type { Layer } from '../area-data';
import { pointInRing, type LngLat } from '../geo';
import type { LocalFrame } from '../local';
import type { Area, Line, OsmData } from '../osm';

// Thin paths are still easy to hit.
const MIN_PICK_M = 2;

export function groundAt(osm: OsmData, visible: Set<Layer>, at: LngLat, frame: LocalFrame): string | null {
  const p = frame.toLocal(at);
  const onLine = (l: Line) => !l.bridge && nearPath(p, l.path.map((q) => frame.toLocal(q)), Math.max(l.width / 2, MIN_PICK_M));
  const inArea = (a: Area) => pointInRing(at, a.outer) && !a.holes.some((h) => pointInRing(at, h));
  const order: [Layer, () => { id: string } | undefined][] = [
    ['railways', () => osm.railways.find(onLine)],
    ['roads', () => osm.roads.find(onLine)],
    ['water', () => osm.waterways.find(onLine) ?? osm.waterAreas.find(inArea)],
    ['paved', () => osm.pavedLines.find(onLine) ?? osm.pavedAreas.find(inArea)],
    ['surfaces', () => osm.surfaces.find(inArea)],
    ['green', () => osm.green.find(inArea)],
  ];
  for (const [layer, find] of order) {
    if (!visible.has(layer)) continue;
    const hit = find();
    if (hit) return hit.id;
  }
  return null;
}

function nearPath([x, z]: [number, number], path: [number, number][], radius: number): boolean {
  for (let i = 1; i < path.length; i++) {
    const [ax, az] = path[i - 1];
    const [bx, bz] = path[i];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
    if (Math.hypot(x - ax - t * dx, z - az - t * dz) <= radius) return true;
  }
  return false;
}
