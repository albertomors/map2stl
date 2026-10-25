// The frame every model is built in, shared by the 3D view and the export: local meters
// around the selection center, the selection's bounds, and how terrain heights become scene
// heights (sea floor flattened to the water surface, lowest point at 0, exaggerated).

import type { AreaData } from '../area-data';
import type { LngLat } from '../geo';
import { LocalFrame } from '../local';
import { isSea } from '../osm';
import { describe } from '../selection';
import { elevationAt } from '../terrain';
import type { Placement } from './objects';
import type { Bounds } from './terrain-mesh';

export interface SceneSetup {
  ring: LngLat[];
  frame: LocalFrame;
  bounds: Bounds;
  placement: Placement;
  // Terrain height (meters above sea) → scene height.
  groundHeight: (h: number) => number;
}

// `seaFloor`: water isn't shown, so the sea floor is (its real depths, where the area has them):
// the deepest point is then the lowest, not sea level.
export function prepareScene(data: AreaData, scales: { terrain: number; heights: number }, seaFloor = false): SceneSetup {
  const { terrain, selection, osm } = data;
  const ring = describe(selection).ring;
  const frame = new LocalFrame(selection.center);
  const local = ring.map((p) => frame.toLocal(p));
  const bounds: Bounds = {
    minX: Math.min(...local.map((p) => p[0])),
    maxX: Math.max(...local.map((p) => p[0])),
    minZ: Math.min(...local.map((p) => p[1])),
    maxZ: Math.max(...local.map((p) => p[1])),
  };
  // Terrarium includes the sea floor: where there's sea, the water surface is the ground.
  const hasSea = osm.waterAreas.some(isSea);
  const clampSea = (h: number) => (hasSea && !seaFloor ? Math.max(h, 0) : h);
  // Heights relative to the lowest point, so the model sits near y = 0 wherever it is.
  const ref = clampSea(terrain.min);
  return {
    ring,
    frame,
    bounds,
    placement: {
      frame,
      elevation: ([lng, lat]) => clampSea(elevationAt(terrain, lng, lat)) - ref,
      terrainScale: scales.terrain,
      heightScale: scales.heights,
    },
    groundHeight: (h) => (clampSea(h) - ref) * scales.terrain,
  };
}
