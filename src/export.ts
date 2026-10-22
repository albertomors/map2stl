// The printable model: the same scene as the 3D view (edits, multipliers, visible layers),
// built as closed solids and converted to millimeters with Z up, base at Z = 0. Each layer is
// one part, so a 3MF can give each its own color; slicers merge overlapping parts.

import { ConeGeometry, type BufferGeometry } from 'three';
import type { AreaData, Layer } from './area-data';
import { clipObjects } from './clip';
import { applyEdits, editedTrees, type Edits } from './edits';
import { buildBridges, buildBuildings, buildStructures, COLORS, TREE_HEIGHT_M, treesGeometry, type PickableMesh } from './viewer/objects';
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
  // Which solid each triangle belongs to (a building, a tree…): solids that merely touch
  // must not share points in the file, or slicers see their shared edges as broken.
  solids: Uint32Array;
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
  // The print keeps the shape the way it was drawn: its "up" (the map bearing when drawn)
  // becomes the print's +Y, so a rectangle drawn on a turned map lies straight on the bed and
  // the longest side is the shape's own. In plan (X east, Y north) that's a counterclockwise
  // turn by the bearing.
  const turn = (data.selection.rotation * Math.PI) / 180;
  const [cos, sin] = [Math.cos(turn), Math.sin(turn)];
  const plan = (x: number, z: number): [number, number] => [x * cos + z * sin, x * sin - z * cos];
  const outline = ring.map((p) => plan(...frame.toLocal(p)));
  const [minPX, maxPX] = [Math.min(...outline.map((p) => p[0])), Math.max(...outline.map((p) => p[0]))];
  const [minPY, maxPY] = [Math.min(...outline.map((p) => p[1])), Math.max(...outline.map((p) => p[1]))];
  const extent = Math.max(maxPX - minPX, maxPY - minPY);
  const mmPerUnit = options.sizeMm / extent;
  const at = { ...placement, sink: SINK_M, minWidth: options.minFeatureMm / mmPerUnit };

  const tile = buildTerrain(data.terrain, ring, frame, bounds, groundHeight, options.baseMm / mmPerUnit);
  const edited = clipObjects(applyEdits(data.osm, edits), ring);
  const show = (layer: Layer) => visible.has(layer);

  // A geometry with, where it holds many solids, the solid of each triangle.
  type Piece = { geometry: BufferGeometry; owners?: number[] } | null | undefined;
  const pick = (r: PickableMesh | null): Piece => r && { geometry: r.geometry, owners: r.owners };
  const groups: { name: string; color: string; pieces: Piece[] }[] = [
    { name: 'Terrain', color: '#c9bba5', pieces: [{ geometry: tile.top }, { geometry: tile.sides }] },
    { name: 'Buildings', color: '#' + COLORS.wall.getHexString(), pieces: [show('buildings') ? pick(buildBuildings(edited.buildings, at)) : null] },
    {
      name: 'Bridges and structures',
      color: '#' + COLORS.structure.getHexString(),
      pieces: [
        show('structures') ? pick(buildStructures({ ...data.osm, ...edited }, at)) : null,
        show('roads') ? pick(buildBridges(edited.roads, at, COLORS.road)) : null,
        show('railways') ? pick(buildBridges(edited.railways, at, COLORS.rail)) : null,
      ],
    },
    (() => {
      const g = show('trees') ? treesGeometry(editedTrees(data.osm.trees, edits, TREE_HEIGHT_M), at) : null;
      // Each tree is a cone of the same number of triangles, one after another.
      const perTree = new ConeGeometry(1, 1, 7).toNonIndexed().getAttribute('position').count / 3;
      return { name: 'Trees', color: '#' + COLORS.tree.getHexString(), pieces: [g && { geometry: g, owners: treeOwners(g, perTree) }] };
    })(),
  ];

  // Scene (x east, y up, z south, meters) → print (X, Y in the shape's own frame, Z up, mm),
  // centered, base at Z = 0. Only rotations, so faces keep their winding.
  const cx = (minPX + maxPX) / 2;
  const cy = (minPY + maxPY) / 2;
  const parts: PrintPart[] = [];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let nextSolid = 0;
  for (const group of groups) {
    const chunks: Float32Array[] = [];
    const solidChunks: Uint32Array[] = [];
    let groupSolid: number | undefined;
    for (const piece of group.pieces) {
      if (!piece) continue;
      const g = piece.geometry;
      const flat = g.index ? g.toNonIndexed() : g;
      const pos = flat.getAttribute('position');
      const out = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const [px, py] = plan(pos.getX(i), pos.getZ(i));
        const X = (px - cx) * mmPerUnit;
        const Y = (py - cy) * mmPerUnit;
        const Z = (pos.getY(i) - tile.baseY) * mmPerUnit;
        out.set([X, Y, Z], i * 3);
        for (const [k, v] of [X, Y, Z].entries()) {
          min[k] = Math.min(min[k], v);
          max[k] = Math.max(max[k], v);
        }
      }
      chunks.push(out);
      // Without owners the geometry is one solid, shared by all such pieces of the group (the
      // terrain tile's top and sides close each other).
      const tris = pos.count / 3;
      const solids = new Uint32Array(tris);
      if (!piece.owners) groupSolid ??= nextSolid++;
      const base = piece.owners ? nextSolid : groupSolid!;
      let top = 0;
      for (let t = 0; t < tris; t++) {
        const o = piece.owners ? Math.max(0, piece.owners[t]) : 0;
        solids[t] = base + o;
        top = Math.max(top, o);
      }
      if (piece.owners) nextSolid = base + top + 1;
      solidChunks.push(solids);
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
    const solids = new Uint32Array(total / 9);
    let so = 0;
    for (const c of solidChunks) {
      solids.set(c, so);
      so += c.length;
    }
    parts.push({ name: group.name, color: group.color, triangles, solids });
  }
  return {
    parts,
    sizeMm: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    triangleCount: parts.reduce((n, p) => n + p.triangles.length / 9, 0),
  };
}

// Trees come as one merged geometry: consecutive runs of `perTree` triangles.
function treeOwners(g: BufferGeometry, perTree: number): number[] {
  const tris = g.getAttribute('position').count / 3;
  return Array.from({ length: tris }, (_, t) => (perTree ? Math.floor(t / perTree) : 0));
}
