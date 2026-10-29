// The 3D view's objects (buildings, structures, bridges, boats, trees, forests) as plain
// arrays, built in a worker (objects-worker.ts): for a big city they take seconds, and the
// page would freeze while they're made, on opening and on every edit. The view turns the
// arrays back into meshes (viewer.ts).

import type { AreaData, Layer } from '../area-data';
import { boatInside, mooredBoats, type Boat } from '../boats';
import { clipObjects } from '../clip';
import { applyEdits, editedTrees, type Edits } from '../edits';
import { buildCanopy, canopySurface, type Canopy } from '../forest';
import type { OsmData } from '../osm';
import { elevationAt } from '../terrain';
import { buildModels } from './models';
import { buildBoats, buildBridges, buildBuildings, buildStructures, buildTrees, COLORS, TREE_HEIGHT_M, type PickableMesh } from './objects';
import { prepareScene } from './scene';

export interface ObjectsJob {
  scales: { terrain: number; heights: number };
  // Water off: the ground is the sea floor.
  seaFloor: boolean;
  edits: Edits;
}

// One merged mesh: its triangles' points, and which object each triangle is.
export interface SolidArrays {
  layer: Layer;
  // One color for all (bridges), or per point.
  color?: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  grounds: Float32Array;
  owners: number[];
  keys: string[];
}

export interface SceneObjects {
  solids: SolidArrays[];
  boats: Boat[];
  // OSM's single trees and the forests' border trees: an instance matrix each.
  trees: { keys: string[]; matrices: Float32Array } | null;
  canopy: { field: Canopy; positions: Float32Array; grounds: Float32Array; index: Uint32Array; colors: Float32Array } | null;
}

// `clipped`: the data cut to the selection (the same for every job on the same data).
export function buildSceneObjects(data: AreaData, clipped: OsmData, job: ObjectsJob): SceneObjects {
  const { ring, placement: at, groundHeight } = prepareScene(data, job.scales, job.seaFloor);
  const osm = data.osm;
  const edits = job.edits;
  const edited = clipObjects(applyEdits(osm, edits), ring);
  const solids: SolidArrays[] = [];
  const solid = (result: PickableMesh | null, layer: Layer, color?: number) => {
    if (!result) return;
    const g = result.geometry;
    const array = (name: string) => g.getAttribute(name).array as Float32Array;
    solids.push({ layer, color, positions: array('position'), normals: array('normal'), colors: array('color'), grounds: array('groundY'), owners: result.owners, keys: result.keys });
  };
  solid(buildBuildings(edited.buildings, at), 'buildings');
  solid(buildModels(osm, edits, at, 'buildings'), 'buildings');
  solid(buildModels(osm, edits, at, 'bridges'), 'structures');
  solid(buildStructures({ ...osm, ...edited }, at), 'structures');
  solid(buildBridges(edited.roads, at, COLORS.road), 'roads', COLORS.road.getHex());
  solid(buildBridges(edited.railways, at, COLORS.rail), 'railways', COLORS.rail.getHex());
  // Boats at the (edited) piers, inside the selection; they float on the water layer.
  const boats = mooredBoats({ ...osm, ...edited }).filter((b) => boatInside(b, ring) && !edits.get(b.key)?.deleted);
  solid(buildBoats(boats, at), 'water');

  // The forests, from the edited woods (a wood deleted, printed as something else or with its
  // trees deleted has none): a canopy, with single trees along its border.
  const t = data.terrain;
  const field = buildCanopy(
    applyEdits(clipped, edits),
    ring,
    at.frame,
    (x, z) => {
      const [lng, lat] = at.frame.toLngLat([x, z]);
      return groundHeight(elevationAt(t, lng, lat));
    },
    { heightScale: at.heightScale, bare: (id) => !!edits.get(id)?.noTrees, borderTrees: true },
  );
  const trees = [
    ...editedTrees(osm.trees, edits, TREE_HEIGHT_M),
    ...(field?.border ?? []).map((tree) => ({ key: tree.key, at: at.frame.toLngLat([tree.x, tree.z]), size: tree.size, height: tree.height })),
  ];
  const treeMesh = buildTrees(trees, at);
  return {
    solids,
    boats,
    trees: treeMesh ? { keys: trees.map((tree) => tree.key), matrices: treeMesh.instanceMatrix.array as Float32Array } : null,
    canopy: field ? canopyArrays(field) : null,
  };
}

// The canopy's surface, darker down between the crowns and lighter at their tips: depth
// from above.
function canopyArrays(field: Canopy): SceneObjects['canopy'] {
  const { positions, grounds, index } = canopySurface(field);
  if (!index.length) return null;
  const colors = new Float32Array(positions.length);
  const base = COLORS.tree;
  for (let k = 0; k < field.above.length; k++) {
    const shade = 0.55 + 0.6 * Math.min(1, Math.max(0, field.above[k] / field.top));
    colors[k * 3] = base.r * shade;
    colors[k * 3 + 1] = base.g * shade;
    colors[k * 3 + 2] = base.b * shade;
  }
  return { field, positions, grounds: Float32Array.from(grounds), index: Uint32Array.from(index), colors };
}

// What a worker can hand back without copying.
export function transferables(o: SceneObjects): ArrayBuffer[] {
  const buffers = [
    ...o.solids.flatMap((s) => [s.positions, s.normals, s.colors, s.grounds]),
    ...(o.trees ? [o.trees.matrices] : []),
    ...(o.canopy ? [o.canopy.positions, o.canopy.grounds, o.canopy.index, o.canopy.colors] : []),
  ].map((a) => a.buffer as ArrayBuffer);
  // A buffer listed twice can't be transferred.
  return [...new Set(buffers)];
}
