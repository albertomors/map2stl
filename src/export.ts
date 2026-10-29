// The printable model: the same scene as the 3D view (edits, multipliers, visible layers),
// built as closed solids and converted to millimeters with Z up, base at Z = 0. Each layer is
// one part, so a 3MF can give each its own color; slicers merge overlapping parts.

import { BufferGeometry, ConeGeometry, Float32BufferAttribute, Matrix4 } from 'three';
import type { AreaData, Layer } from './area-data';
import { clipObjects } from './clip';
import { applyEdits, editedTrees, type Edits } from './edits';
import type { Wasm } from './merge';
import { boatInside, mooredBoats } from './boats';
import { buildCanopy, canopySolid } from './forest';
import { buildGroundSolids } from './print-ground';
import { elevationAt } from './terrain';
import { buildModels } from './viewer/models';
import { buildBoats, buildBridges, buildBuildings, buildStructures, COLORS, TREE_HEIGHT_M, treesGeometry, type PickableMesh } from './viewer/objects';
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
  // Which object each triangle belongs to: a building of several parts is one object.
  objects: Uint32Array;
  // For a part made of many like details (a forest's crowns), their width: the nozzle check
  // looks at that, not at the part's outline.
  featureMm?: number;
}

export interface PrintModel {
  parts: PrintPart[];
  // Bounding box of the whole model.
  sizeMm: [number, number, number];
  triangleCount: number;
  // Print millimeters back to the 3D view's scene, so the preview sits where the model was.
  toScene: Matrix4;
  // How wide the forests' crowns print, if there are forests.
  crownMm?: number;
}

// Objects standing on the ground reach this far into it, so no gap opens on slopes.
const SINK_M = 1;
const TERRAIN = 'Terrain';

// `wasm`: manifold-3d, loaded (see loadManifold).
export function buildPrintModel(
  wasm: Wasm,
  data: AreaData,
  edits: Edits,
  scales: { terrain: number; heights: number },
  visible: Set<Layer>,
  options: PrintOptions,
  // Hears how far along the build is (0 to 1) and what it's doing.
  progress: (fraction: number, label: string) => void = () => {},
): PrintModel {
  // Water off: the sea floor prints (its real depths), the deepest point the lowest.
  const { ring, frame, bounds, placement, groundHeight } = prepareScene(data, scales, !visible.has('water'));
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

  const edited = clipObjects(applyEdits(data.osm, edits), ring);
  const show = (layer: Layer) => visible.has(layer);
  // Streets, water, squares, parks and sand, carved into the terrain in steps of the thinnest
  // detail; the terrain then comes carved from there instead.
  // Edited: deleted streets and areas gone, widened ones wider, retyped areas moved.
  const ground = buildGroundSolids(wasm, applyEdits(data.osm, edits), data.terrain, ring, frame, groundHeight, show, at.minWidth, options.baseMm / mmPerUnit, (f, label) =>
    progress(0.7 * f, label),
  );
  const tile = ground.terrain ? null : buildTerrain(data.terrain, ring, frame, bounds, groundHeight, options.baseMm / mmPerUnit);
  const baseY = ground.terrain?.baseY ?? tile!.baseY;
  const flat = (positions: number[]) => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(positions, 3));
    return g;
  };
  const solids = (s: { positions: number[]; owners: number[] }): Piece => (s.positions.length ? { geometry: flat(s.positions), owners: s.owners } : null);

  // A geometry with, where it holds many solids, the solid of each triangle, and with keys
  // the object each solid belongs to.
  type Piece = { geometry: BufferGeometry; owners?: number[]; keys?: string[] } | null | undefined;
  const pick = (r: PickableMesh | null): Piece => r && { geometry: r.geometry, owners: r.owners, keys: r.keys };
  progress(0.7, 'Adding buildings and trees');
  const groups: { name: string; color: string; pieces: Piece[]; featureMm?: number }[] = [
    { name: TERRAIN, color: '#c9bba5', pieces: tile ? [{ geometry: tile.top }, { geometry: tile.sides }] : [{ geometry: flat(ground.terrain!.positions) }] },
    { name: 'Water', color: '#3b8fe0', pieces: [solids(ground.water)] },
    {
      name: 'Boats',
      color: '#f4f4f0',
      pieces: show('water') ? [pick(buildBoats(mooredBoats({ ...data.osm, ...edited }).filter((b) => boatInside(b, ring) && !edits.get(b.key)?.deleted), at))] : [],
    },
    { name: 'Streets', color: '#' + COLORS.road.getHexString(), pieces: [solids(ground.streets)] },
    // Each its own part, so a slicer can give it its own filament or the terrain's.
    { name: 'Squares', color: '#c9c6c1', pieces: [solids(ground.squares)] },
    { name: 'Parks', color: '#5fae4c', pieces: [solids(ground.parks)] },
    { name: 'Sand and rock', color: '#e8d6a4', pieces: [solids(ground.sand)] },
    // Steep ground, gray like the 3D view's rock: its own filament in a 3MF.
    { name: 'Rock', color: '#9c978e', pieces: [solids(ground.rock)] },
    {
      name: 'Buildings',
      color: '#' + COLORS.wall.getHexString(),
      // Buildings replaced by 3D models are models here too.
      pieces: show('buildings') ? [pick(buildBuildings(edited.buildings, at)), pick(buildModels(data.osm, edits, at, 'buildings'))] : [],
    },
    {
      name: 'Bridges and structures',
      color: '#' + COLORS.structure.getHexString(),
      pieces: [
        show('structures') ? pick(buildStructures({ ...data.osm, ...edited }, at)) : null,
        // Bridges replaced by 3D models.
        show('structures') ? pick(buildModels(data.osm, edits, at, 'bridges')) : null,
        show('roads') ? pick(buildBridges(edited.roads, at, COLORS.road)) : null,
        show('railways') ? pick(buildBridges(edited.railways, at, COLORS.rail)) : null,
      ],
    },
    (() => {
      // Forests: their canopy, crowns at a real crown's size whatever the print's (too small
      // for the nozzle, they show in red, like any object), reaching into the ground like
      // everything standing on it.
      const canopy = show('trees')
        ? buildCanopy(applyEdits(data.osm, edits), ring, frame, (x, z) => groundHeight(elevationAt(data.terrain, ...frame.toLngLat([x, z]))), {
            heightScale: scales.heights,
            pointsPerCrown: 4,
            bare: (id) => !!edits.get(id)?.noTrees,
          })
        : null;
      return {
        name: 'Forests',
        color: '#' + COLORS.tree.getHexString(),
        pieces: [canopy && { geometry: flat(canopySolid(canopy, 2 * SINK_M)) }],
        featureMm: canopy ? canopy.spacing * mmPerUnit : undefined,
      };
    })(),
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
  // Objects by key, or by solid where there's no key.
  const objectIds = new Map<string | number, number>();
  const objectOf = (k: string | number) => {
    let id = objectIds.get(k);
    if (id === undefined) objectIds.set(k, (id = objectIds.size));
    return id;
  };
  progress(0.9, 'Putting it together');
  for (const group of groups) {
    const chunks: Float32Array[] = [];
    const solidChunks: Uint32Array[] = [];
    const objectChunks: Uint32Array[] = [];
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
        const Z = (pos.getY(i) - baseY) * mmPerUnit;
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
      const objects = new Uint32Array(tris);
      if (!piece.owners) groupSolid ??= nextSolid++;
      const base = piece.owners ? nextSolid : groupSolid!;
      let top = 0;
      for (let t = 0; t < tris; t++) {
        const o = piece.owners ? Math.max(0, piece.owners[t]) : 0;
        solids[t] = base + o;
        objects[t] = objectOf(piece.keys ? piece.keys[o] : solids[t]);
        top = Math.max(top, o);
      }
      if (piece.owners) nextSolid = base + top + 1;
      solidChunks.push(solids);
      objectChunks.push(objects);
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
    const join = (list: Uint32Array[]) => {
      const out = new Uint32Array(total / 9);
      let at = 0;
      for (const c of list) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    };
    parts.push({ name: group.name, color: group.color, triangles, solids: join(solidChunks), objects: join(objectChunks), featureMm: group.featureMm });
  }
  // The inverse of the conversion above: plan() is its own inverse, Z up becomes y up.
  const k = 1 / mmPerUnit;
  const [tx, tz] = [cos * cx + sin * cy, sin * cx - cos * cy];
  const toScene = new Matrix4().set(cos * k, sin * k, 0, tx, 0, 0, k, baseY, sin * k, -cos * k, 0, tz, 0, 0, 0, 1);
  return {
    parts,
    sizeMm: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    triangleCount: parts.reduce((n, p) => n + p.triangles.length / 9, 0),
    toScene,
    crownMm: parts.find((p) => p.featureMm !== undefined)?.featureMm,
  };
}

export interface ThinObjects {
  // Per part, the objects narrower than the nozzle.
  objects: Map<PrintPart, Set<number>>;
  // Part name → how many.
  counts: [string, number][];
}

// Objects (not the terrain) narrower than the nozzle: they print as blobs, or not at all. The
// width is the narrowest side of the whole object's outline seen from above (its convex hull):
// a small kiosk or a thin mast is caught; a thin wing of an L-shaped building, or a thin part
// flush against a wider one (which prints fine, merged), isn't.
export function findThinObjects(model: PrintModel, nozzleMm: number): ThinObjects {
  const objects = new Map<PrintPart, Set<number>>();
  const counts: [string, number][] = [];
  for (const part of model.parts) {
    if (part.name === TERRAIN) continue;
    // Many like details: all of them too thin, or none.
    if (part.featureMm !== undefined) {
      if (part.featureMm < nozzleMm) {
        objects.set(part, new Set(part.objects));
        counts.push([part.name, new Set(part.objects).size]);
      }
      continue;
    }
    const points = new Map<number, number[]>();
    const t = part.triangles;
    for (let tri = 0; tri < part.objects.length; tri++) {
      let list = points.get(part.objects[tri]);
      if (!list) points.set(part.objects[tri], (list = []));
      for (let v = 0; v < 3; v++) list.push(t[tri * 9 + v * 3], t[tri * 9 + v * 3 + 1]);
    }
    const thin = new Set<number>();
    for (const [object, xy] of points) if (narrowestWidth(xy) < nozzleMm) thin.add(object);
    if (thin.size) {
      objects.set(part, thin);
      counts.push([part.name, thin.size]);
    }
  }
  return { objects, counts };
}

// Narrowest width of a point set (x, y pairs): over the convex hull's edges, the farthest
// point from each edge's line; the smallest of those.
function narrowestWidth(xy: number[]): number {
  const pts: [number, number][] = [];
  for (let i = 0; i < xy.length; i += 2) pts.push([xy[i], xy[i + 1]]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  // Andrew's monotone chain.
  const hull: [number, number][] = [];
  for (const pass of [pts, [...pts].reverse()]) {
    const start = hull.length;
    for (const p of pass) {
      while (hull.length >= start + 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
      hull.push(p);
    }
    hull.pop();
  }
  if (hull.length < 3) return 0;
  let best = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!len) continue;
    let far = 0;
    for (const p of hull) far = Math.max(far, Math.abs(cross(a, b, p)) / len);
    best = Math.min(best, far);
  }
  return best;
}

// Trees come as one merged geometry: consecutive runs of `perTree` triangles.
function treeOwners(g: BufferGeometry, perTree: number): number[] {
  const tris = g.getAttribute('position').count / 3;
  return Array.from({ length: tris }, (_, t) => (perTree ? Math.floor(t / perTree) : 0));
}
