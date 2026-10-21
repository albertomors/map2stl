// Changes the user makes to objects in the 3D view: delete, enlarge (all dimensions, keeping
// the ratio) and stretch the height alone. Keyed by object: a multi-part building is one key,
// trees are keyed by their index. Applied to the data before it's cut to the selection, so
// an enlarged landmark is still trimmed at the tile edge. The export applies the same edits.

import type { LngLat } from './geo';
import type { Building, OsmData, Polygon } from './osm';

export interface ObjectEdit {
  deleted?: boolean;
  // Uniform scale from the center of the base: footprint and heights together.
  scale?: number;
  // Height only, on top of `scale`.
  heightScale?: number;
}

export type Edits = Map<string, ObjectEdit>;

export function editKey(b: Building): string {
  return b.group ?? b.id;
}

export const treeKey = (index: number) => `tree/${index}`;

// A tree with its edit applied, for the tree builder.
export interface EditedTree {
  key: string;
  at: LngLat;
  size: number;
  height: number;
}

export function applyEdits(osm: OsmData, edits: Edits): OsmData {
  if (!edits.size) return osm;
  const keep = <T>(items: T[], key: (t: T) => string) => items.filter((t) => !edits.get(key(t))?.deleted);
  const k = (key: string) => edits.get(key)?.scale ?? 1;
  const h = (key: string) => (edits.get(key)?.scale ?? 1) * (edits.get(key)?.heightScale ?? 1);

  const buildingCenters = centers(osm.buildings, editKey, edits);
  const areaCenters = centers(osm.structureAreas, (a) => a.id, edits);
  return {
    ...osm,
    buildings: keep(osm.buildings, editKey).map((b) => {
      const key = editKey(b);
      const c = buildingCenters.get(key);
      return c || h(key) !== 1
        ? {
            ...b,
            ...(c ? scalePolygon(b, c, k(key)) : {}),
            height: b.height * h(key),
            minHeight: b.minHeight * h(key),
            roofHeight: b.roofHeight !== undefined ? b.roofHeight * h(key) : undefined,
          }
        : b;
    }),
    roads: keep(osm.roads, (l) => l.id),
    railways: keep(osm.railways, (l) => l.id),
    structureAreas: keep(osm.structureAreas, (a) => a.id).map((a) => {
      const c = areaCenters.get(a.id);
      return { ...a, ...(c ? scalePolygon(a, c, k(a.id)) : {}), height: a.height * h(a.id) };
    }),
    // Walls are lines: only their height changes.
    structureLines: keep(osm.structureLines, (l) => l.id).map((l) => ({ ...l, height: l.height * (edits.get(l.id)?.heightScale ?? 1) })),
    towers: keep(osm.towers, (t) => t.id).map((t) => ({ ...t, height: t.height * h(t.id), size: k(t.id) })),
  };
}

export function editedTrees(trees: LngLat[], edits: Edits, baseHeight: number): EditedTree[] {
  return trees.flatMap((at, i): EditedTree[] => {
    const key = treeKey(i);
    const e = edits.get(key);
    if (e?.deleted) return [];
    const size = e?.scale ?? 1;
    return [{ key, at, size, height: baseHeight * size * (e?.heightScale ?? 1) }];
  });
}

// The center each scaled object grows from (all parts of one key share it).
function centers<T extends Polygon>(items: T[], key: (t: T) => string, edits: Edits): Map<string, LngLat> {
  const sums = new Map<string, [number, number, number]>();
  for (const it of items) {
    const kk = key(it);
    if ((edits.get(kk)?.scale ?? 1) === 1) continue;
    const s = sums.get(kk) ?? [0, 0, 0];
    for (const [lng, lat] of it.outer) {
      s[0] += lng;
      s[1] += lat;
      s[2]++;
    }
    sums.set(kk, s);
  }
  return new Map([...sums].map(([kk, [x, y, n]]) => [kk, [x / n, y / n] as LngLat]));
}

// Scaling longitude and latitude offsets by the same factor scales meters evenly too.
function scalePolygon(p: Polygon, c: LngLat, k: number): Polygon {
  const scale = (ring: LngLat[]) => ring.map(([lng, lat]): LngLat => [c[0] + (lng - c[0]) * k, c[1] + (lat - c[1]) * k]);
  return { outer: scale(p.outer), holes: p.holes.map(scale) };
}
