// The printable model: the same scene as the 3D view (edits, multipliers, visible layers),
// built as closed solids and converted to millimeters with Z up, base at Z = 0. Each layer is
// one part, so a 3MF can give each its own color; slicers merge overlapping parts.

import type { BufferGeometry } from 'three';
import type { AreaData, Layer } from './area-data';
import { clipObjects } from './clip';
import { applyEdits, editedTrees, type Edits } from './edits';
import { buildBridges, buildBuildings, buildStructures, COLORS, TREE_HEIGHT_M, treesGeometry } from './viewer/objects';
import { prepareScene } from './viewer/scene';
import { buildTerrain } from './viewer/terrain-mesh';

export interface PrintOptions {
  // Longest horizontal side of the model.
  sizeMm: number;
  // Solid base under the lowest terrain point.
  baseMm: number;
  // Walls, masts, tree trunks and bridges are widened to at least this.
  minFeatureMm: number;
}

export interface PrintPart {
  name: string;
  color: string;
  // Triangles, 9 floats each, in millimeters (X east, Y north, Z up).
  triangles: Float32Array;
}

export interface PrintModel {
  parts: PrintPart[];
  // Bounding box of the whole model.
  sizeMm: [number, number, number];
  triangleCount: number;
}

// Objects standing on the ground reach this far into it, so no gap opens on slopes.
const SINK_M = 1;

export function buildPrintModel(
  data: AreaData,
  edits: Edits,
  scales: { terrain: number; heights: number },
  visible: Set<Layer>,
  options: PrintOptions,
): PrintModel {
  const { ring, frame, bounds, placement, groundHeight } = prepareScene(data, scales);
  const extent = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  const mmPerUnit = options.sizeMm / extent;
  const at = { ...placement, sink: SINK_M, minWidth: options.minFeatureMm / mmPerUnit };

  const tile = buildTerrain(data.terrain, ring, frame, bounds, groundHeight, options.baseMm / mmPerUnit);
  const edited = clipObjects(applyEdits(data.osm, edits), ring);
  const show = (layer: Layer) => visible.has(layer);

  const groups: { name: string; color: string; geometries: (BufferGeometry | null | undefined)[] }[] = [
    { name: 'Terrain', color: '#c9bba5', geometries: [tile.top, tile.sides] },
    { name: 'Buildings', color: '#' + COLORS.wall.getHexString(), geometries: [show('buildings') ? buildBuildings(edited.buildings, at)?.geometry : null] },
    {
      name: 'Bridges and structures',
      color: '#' + COLORS.structure.getHexString(),
      geometries: [
        show('structures') ? buildStructures({ ...data.osm, ...edited }, at)?.geometry : null,
        show('roads') ? buildBridges(edited.roads, at, COLORS.road)?.geometry : null,
        show('railways') ? buildBridges(edited.railways, at, COLORS.rail)?.geometry : null,
      ],
    },
    { name: 'Trees', color: '#' + COLORS.tree.getHexString(), geometries: [show('trees') ? treesGeometry(editedTrees(data.osm.trees, edits, TREE_HEIGHT_M), at) : null] },
  ];

  // Scene (x east, y up, z south, meters) → print (X east, Y north, Z up, mm), centered,
  // base at Z = 0. (x, y, z) → (x, −z, y) is a rotation, so faces keep their winding.
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const parts: PrintPart[] = [];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const group of groups) {
    const chunks: Float32Array[] = [];
    for (const g of group.geometries) {
      if (!g) continue;
      const flat = g.index ? g.toNonIndexed() : g;
      const pos = flat.getAttribute('position');
      const out = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const X = (pos.getX(i) - cx) * mmPerUnit;
        const Y = -(pos.getZ(i) - cz) * mmPerUnit;
        const Z = (pos.getY(i) - tile.baseY) * mmPerUnit;
        out.set([X, Y, Z], i * 3);
        for (const [k, v] of [X, Y, Z].entries()) {
          min[k] = Math.min(min[k], v);
          max[k] = Math.max(max[k], v);
        }
      }
      chunks.push(out);
      if (flat !== g) flat.dispose();
      g.dispose();
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    if (!total) continue;
    const triangles = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) {
      triangles.set(c, offset);
      offset += c.length;
    }
    parts.push({ name: group.name, color: group.color, triangles });
  }
  return {
    parts,
    sizeMm: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    triangleCount: parts.reduce((n, p) => n + p.triangles.length / 9, 0),
  };
}
