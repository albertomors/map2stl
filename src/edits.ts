// Changes the user makes to objects in the 3D view: delete, enlarge (all dimensions, keeping
// the ratio) and stretch the height alone; for streets, railways and rivers their width, and
// for areas (water, parks, squares, sand) which of those they print as. Keyed by object: a
// multi-part building is one key, trees are keyed by their index. Applied to the data before it's cut to the selection, so
// an enlarged landmark is still trimmed at the tile edge. The export applies the same edits.

import type { LngLat } from './geo';
import type { Area, Building, Line, OsmData, Polygon } from './osm';
import type { ModelChoice } from './model-assets';

export interface ObjectEdit {
  deleted?: boolean;
  // Uniform scale from the center of the base: footprint and heights together.
  scale?: number;
  // Height only, on top of `scale`.
  heightScale?: number;
  // A 3D model drawn instead of the building (see viewer/models.ts).
  model?: ModelChoice;
  // Streets, railways, rivers, paths: their width, times this.
  width?: number;
  // Areas: printed as this kind instead.
  ground?: GroundKind;
}

// What an area can print as.
export type GroundKind = 'water' | 'green' | 'paved' | 'surfaces';
const AREA_FIELDS = { water: 'waterAreas', green: 'green', paved: 'pavedAreas', surfaces: 'surfaces' } as const;

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
  const widen = (l: Line): Line => {
    const k = edits.get(l.id)?.width ?? 1;
    return k === 1 ? l : { ...l, width: l.width * k };
  };
  // A building replaced by a model is drawn from the model instead.
  const keepBuilding = (b: Building) => !edits.get(editKey(b))?.deleted && !edits.get(editKey(b))?.model;
  const k = (key: string) => edits.get(key)?.scale ?? 1;
  const h = (key: string) => (edits.get(key)?.scale ?? 1) * (edits.get(key)?.heightScale ?? 1);

  const buildingCenters = centers(osm.buildings, editKey, edits);
  const areaCenters = centers(osm.structureAreas, (a) => a.id, edits);
  return {
    ...osm,
    buildings: osm.buildings.filter(keepBuilding).map((b) => {
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
    ...groundEdits(osm, edits, widen),
    // A bridge replaced by a model is drawn from the model instead.
    roads: keep(osm.roads, (l) => l.id).filter((l) => !edits.get(l.id)?.model).map(widen),
    railways: keep(osm.railways, (l) => l.id).filter((l) => !edits.get(l.id)?.model).map(widen),
    structureAreas: keep(osm.structureAreas, (a) => a.id).filter((a) => !edits.get(a.id)?.model).map((a) => {
      const c = areaCenters.get(a.id);
      return { ...a, ...(c ? scalePolygon(a, c, k(a.id)) : {}), height: a.height * h(a.id) };
    }),
    // Walls are lines: only their height changes.
    structureLines: keep(osm.structureLines, (l) => l.id).map((l) => ({ ...l, height: l.height * (edits.get(l.id)?.heightScale ?? 1) })),
    towers: keep(osm.towers, (t) => t.id).map((t) => ({ ...t, height: t.height * h(t.id), size: k(t.id) })),
  };
}

// Areas deleted or moved to another kind; lines deleted or widened.
function groundEdits(osm: OsmData, edits: Edits, widen: (l: Line) => Line): Pick<OsmData, 'waterAreas' | 'green' | 'pavedAreas' | 'surfaces' | 'waterways' | 'pavedLines'> {
  const out = { waterAreas: [] as Area[], green: [] as Area[], pavedAreas: [] as Area[], surfaces: [] as Area[] };
  for (const [kind, field] of Object.entries(AREA_FIELDS) as [GroundKind, keyof typeof out][]) {
    for (const a of osm[field]) {
      const e = edits.get(a.id);
      if (!e?.deleted) out[AREA_FIELDS[e?.ground ?? kind]].push(a);
    }
  }
  const lines = (list: Line[]) => list.filter((l) => !edits.get(l.id)?.deleted).map(widen);
  return { ...out, waterways: lines(osm.waterways), pavedLines: lines(osm.pavedLines) };
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

// The center each scaled object grows from: the middle of its bounding box (all parts of
// one key share it). The 3D view's live preview scales around the same point, so letting go
// of the slider doesn't shift the object.
function centers<T extends Polygon>(items: T[], key: (t: T) => string, edits: Edits): Map<string, LngLat> {
  const boxes = new Map<string, [number, number, number, number]>();
  for (const it of items) {
    const kk = key(it);
    if ((edits.get(kk)?.scale ?? 1) === 1) continue;
    const b = boxes.get(kk) ?? [Infinity, Infinity, -Infinity, -Infinity];
    for (const [lng, lat] of it.outer) {
      b[0] = Math.min(b[0], lng);
      b[1] = Math.min(b[1], lat);
      b[2] = Math.max(b[2], lng);
      b[3] = Math.max(b[3], lat);
    }
    boxes.set(kk, b);
  }
  return new Map([...boxes].map(([kk, [w, s, e, n]]) => [kk, [(w + e) / 2, (s + n) / 2] as LngLat]));
}

// Scaling longitude and latitude offsets by the same factor scales meters evenly too.
function scalePolygon(p: Polygon, c: LngLat, k: number): Polygon {
  const scale = (ring: LngLat[]) => ring.map(([lng, lat]): LngLat => [c[0] + (lng - c[0]) * k, c[1] + (lat - c[1]) * k]);
  return { outer: scale(p.outer), holes: p.holes.map(scale) };
}
