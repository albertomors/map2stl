// Changes the user makes to buildings in the 3D view: delete, or enlarge from the base.
// Keyed by building (a multi-part building is one key), applied to the data before it's cut
// to the selection, so an enlarged landmark is still trimmed at the tile edge. The export
// applies the same edits.

import type { LngLat } from './geo';
import type { Building } from './osm';

export interface BuildingEdit {
  deleted?: boolean;
  // Uniform scale from the center of the footprint's base: footprint and heights together.
  scale?: number;
}

export type Edits = Map<string, BuildingEdit>;

export function editKey(b: Building): string {
  return b.group ?? b.id;
}

export function applyEdits(buildings: Building[], edits: Edits): Building[] {
  if (!edits.size) return buildings;
  // All parts of a building scale around one center, so they stay together.
  const centers = new Map<string, LngLat>();
  for (const [key, edit] of edits) {
    if (!edit.scale || edit.scale === 1) continue;
    let x = 0, y = 0, n = 0;
    for (const b of buildings) {
      if (editKey(b) !== key) continue;
      for (const [lng, lat] of b.outer) {
        x += lng;
        y += lat;
        n++;
      }
    }
    if (n) centers.set(key, [x / n, y / n]);
  }
  return buildings.flatMap((b): Building[] => {
    const edit = edits.get(editKey(b));
    if (edit?.deleted) return [];
    const center = centers.get(editKey(b));
    if (!center || !edit?.scale) return [b];
    const k = edit.scale;
    // Scaling longitude and latitude offsets by the same factor scales meters evenly too.
    const scale = (ring: LngLat[]) => ring.map(([lng, lat]): LngLat => [center[0] + (lng - center[0]) * k, center[1] + (lat - center[1]) * k]);
    return [{
      ...b,
      outer: scale(b.outer),
      holes: b.holes.map(scale),
      height: b.height * k,
      minHeight: b.minHeight * k,
      roofHeight: b.roofHeight !== undefined ? b.roofHeight * k : undefined,
    }];
  });
}
