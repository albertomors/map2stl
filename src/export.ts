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
import { buildGroundSolids, type GroundSolids } from './print-ground';
import polygonClipping, { type Polygon as PcPolygon } from 'polygon-clipping';
import { pointInRing, type LngLat } from './geo';
import { JOINT, jointsOf, piecesOf, pocketFootprint, tabFootprint, type Piece, type PieceSpec, type Pt } from './pieces';
import { elevationAt } from './terrain';
import { buildModels } from './viewer/models';
import { buildBoats, buildBridges, buildBuildings, buildStructures, COLORS, TREE_HEIGHT_M, TREE_RADIUS_M, treesGeometry, type PickableMesh } from './viewer/objects';
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
  // Printed in pieces: which one it belongs to (an index into the model's pieces).
  piece?: number;
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
  // Printed in pieces: each piece's place in the grid, and the grid; and how many 3D models
  // cross a cut but couldn't be cut there (not closed): each prints whole in one piece.
  uncutModels?: number;
  pieces?: { col: number; row: number }[];
  grid?: { cols: number; rows: number };
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
  return buildPrintPieces(wasm, data, edits, scales, visible, options, undefined, progress)[0].model;
}

// The print, whole or in pieces (pieces.ts). Each piece is built like the whole, with its own
// outline (the shape cut to its cell): its cut sides come out closed walls, as the shape's
// edge always does, whatever the terrain's mesh (carved, it isn't always one manifold-3d
// takes, so cutting it afterwards can't be relied on). Every piece stands on the same base
// and keeps its place in the whole. The joints are built in, without cutting either: a tab
// is a block of its own reaching into the neighbor (slicers join overlapping solids); its
// pocket is a notch in the neighbor's ground outline, roofed over by a lid of terrain built
// from the pocket's top up.
export function buildPrintPieces(
  wasm: Wasm,
  data: AreaData,
  edits: Edits,
  scales: { terrain: number; heights: number },
  visible: Set<Layer>,
  options: PrintOptions,
  spec: PieceSpec | undefined,
  progress: (fraction: number, label: string) => void = () => {},
): { piece: Piece | null; model: PrintModel }[] {
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
  const cx = (minPX + maxPX) / 2;
  const cy = (minPY + maxPY) / 2;
  // Print millimeters back to the map (plan() is its own inverse).
  const toLngLat = ([X, Y]: Pt): LngLat => frame.toLngLat(plan(X / mmPerUnit + cx, Y / mmPerUnit + cy));
  const show = (layer: Layer) => visible.has(layer);
  const baseDepth = options.baseMm / mmPerUnit;

  // What to build: the whole, or each piece's regions (a free shape's piece can be in parts).
  interface Region {
    piece: number;
    ring: LngLat[];
    ground: LngLat[][];
    lids: LngLat[][];
    tabs: Pt[][];
  }
  let pieces: Piece[] = [];
  let regions: Region[] = [{ piece: 0, ring, ground: [ring], lids: [], tabs: [] }];
  const lidBottom = (JOINT.height * options.baseMm + (spec?.clearance ?? 0)) / mmPerUnit;
  if (spec) {
    const shape = outline.map(([x, y]): Pt => [(x - cx) * mmPerUnit, (y - cy) * mmPerUnit]);
    pieces = piecesOf(shape, spec.grid);
    const joints = spec.joints ? jointsOf(shape, pieces, spec.grid, spec.clearance) : [];
    regions = pieces.flatMap((piece, i) => {
      const pockets = joints.filter((j) => j.pocket === i).map((j) => [pocketFootprint(j, spec.clearance)] as PcPolygon);
      const tabs = joints.filter((j) => j.tab === i).map(tabFootprint);
      return piece.outline.map((poly, k) => {
        const own = [poly[0]] as PcPolygon;
        const ground = pockets.length ? (polygonClipping.difference(own, ...pockets) as Pt[][][]) : [[poly[0]]];
        const lids = pockets.flatMap((p) => polygonClipping.intersection(own, p) as Pt[][][]);
        const ll = (r: Pt[]) => r.map(toLngLat);
        // The tabs go with the piece's first part.
        return { piece: i, ring: ll(poly[0]), ground: ground.map((g) => ll(g[0])), lids: lids.map((l) => ll(l[0])), tabs: k ? [] : tabs };
      });
    });
  }

  const flat = (positions: number[]) => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(positions, 3));
    return g;
  };
  // A geometry with, where it holds many solids, the solid of each triangle, and with keys
  // the object each solid belongs to; `base`: where its bottom is, to be lowered to the
  // print's base (the pieces' terrain), and `raise`: how far above it (a pocket's lid).
  // `solid`: pieces with the same one are one solid (a terrain tile's top and sides).
  type Piece_ = { geometry: BufferGeometry; owners?: number[]; keys?: string[]; base?: number; raise?: number; solid?: string } | null | undefined;
  type Group = { name: string; color: string; pieces: Piece_[]; featureMm?: number };
  const solids = (s: { positions: number[]; owners: number[] }): Piece_ => (s.positions.length ? { geometry: flat(s.positions), owners: s.owners } : null);
  const pick = (r: PickableMesh | null): Piece_ => r && { geometry: r.geometry, owners: r.owners, keys: r.keys };
  const editedOsm = applyEdits(data.osm, edits);

  // The ground of an outline: the terrain with streets, water, squares, parks and sand carved
  // into it in steps of the thinnest detail; the plain tile where there's nothing to carve.
  // Edited: deleted streets and areas gone, widened ones wider, retyped areas moved.
  const groundOf = (r: LngLat[], f: (x: number) => number, solid: string, raise?: number) => {
    const g = buildGroundSolids(wasm, editedOsm, data.terrain, r, frame, groundHeight, show, at.minWidth, baseDepth, (x, label) => progress(f(x), label));
    const tile = g.terrain ? null : buildTerrain(data.terrain, r, frame, bounds, groundHeight, baseDepth);
    const base = g.terrain?.baseY ?? tile!.baseY;
    const terrain: Piece_[] = tile ? [{ geometry: tile.top, base, raise, solid }, { geometry: tile.sides, base, raise, solid }] : [{ geometry: flat(g.terrain!.positions), base, raise, solid }];
    return { g, terrain, base };
  };

  // In pieces, the 3D models (official ones, or the user's) are built once and each cut to
  // every piece it crosses (manifold-3d closes the cut face); one it won't take (not closed)
  // goes whole to the piece holding its middle, and is counted. And single trees whose crown
  // a cut would split are left out: a few millimeters' cone, nobody misses it.
  const uncut = new Set<string>();
  const allModels = spec
    ? (['buildings', 'bridges'] as const).map((which) => {
        const m = buildModels(data.osm, edits, at, which);
        if (!m) return [];
        const pos = m.geometry.getAttribute('position');
        const byOwner = new Map<number, number[]>();
        for (let t = 0; t < m.owners.length; t++) byOwner.set(m.owners[t], [...(byOwner.get(m.owners[t]) ?? []), t]);
        m.geometry.dispose();
        return [...byOwner].map(([owner, tris]) => {
          const t = new Float32Array(tris.length * 9);
          tris.forEach((tri, i) => {
            for (let v = 0; v < 3; v++) t.set([pos.getX(tri * 3 + v), pos.getY(tri * 3 + v), pos.getZ(tri * 3 + v)], i * 9 + v * 3);
          });
          return { key: m.keys[owner], t };
        });
      })
    : [[], []];
  // The cut lines in print mm, between the grid's cells.
  const cuts = { x: [] as number[], y: [] as number[] };
  if (spec && pieces.length) {
    const xs = new Set(pieces.flatMap((p) => [p.cell[0], p.cell[2]]));
    const ys = new Set(pieces.flatMap((p) => [p.cell[1], p.cell[3]]));
    cuts.x = [...xs].sort((a, b) => a - b).slice(1, -1);
    cuts.y = [...ys].sort((a, b) => a - b).slice(1, -1);
  }
  const toMm = (p: LngLat): Pt => {
    const [px, py] = plan(...frame.toLocal(p));
    return [(px - cx) * mmPerUnit, (py - cy) * mmPerUnit];
  };
  // The models in a piece's region: inside it whole, crossing it cut to it.
  const modelsIn = (models: { key: string; t: Float32Array }[], r: LngLat[]): Piece_ => {
    const local = r.map((p) => frame.toLocal(p));
    let prism: InstanceType<Wasm['Manifold']> | null = null;
    const chunks: number[] = [];
    const owners: number[] = [];
    const keys: string[] = [];
    for (const { key, t } of models) {
      let inside = 0;
      let [mx, mz] = [0, 0];
      for (let i = 0; i < t.length; i += 3) {
        if (pointInRing([t[i], t[i + 2]], local)) inside++;
        [mx, mz] = [mx + t[i], mz + t[i + 2]];
      }
      if (!inside) continue;
      let tris: Float32Array | null = t;
      if (inside < t.length / 3) {
        // Crossing the piece's edge: cut to its outline, raised into a prism standing on y
        // (the outline in x, −z, extruded, turned up).
        let ok = false;
        try {
          const { Manifold, Mesh, CrossSection } = wasm;
          if (!prism) {
            const section = new CrossSection([local.map(([x, z]) => [x, -z] as [number, number])], 'EvenOdd');
            prism = Manifold.extrude(section, 1e5).translate([0, 0, -5e4]).rotate([-90, 0, 0]);
            section.delete();
          }
          const mesh = new Mesh({ numProp: 3, vertProperties: t, triVerts: new Uint32Array(t.length / 3).map((_, i) => i) });
          mesh.merge();
          const solid = new Manifold(mesh);
          if (solid.status() === 'NoError' && !solid.isEmpty()) {
            const piece = solid.intersect(prism);
            const out = piece.getMesh();
            tris = new Float32Array(out.triVerts.length * 3);
            out.triVerts.forEach((v, i) => tris!.set([out.vertProperties[v * out.numProp], out.vertProperties[v * out.numProp + 1], out.vertProperties[v * out.numProp + 2]], i * 3));
            piece.delete();
            ok = true;
          }
          solid.delete();
        } catch {
          ok = false;
        }
        // Not closed: whole, in the piece holding its middle.
        if (!ok) {
          uncut.add(key);
          const n = t.length / 3;
          tris = pointInRing([mx / n, mz / n], local) ? t : null;
        }
      }
      if (!tris || !tris.length) continue;
      const owner = keys.push(key) - 1;
      for (let i = 0; i < tris.length; i++) chunks.push(tris[i]);
      for (let i = 0; i < tris.length / 9; i++) owners.push(owner);
    }
    prism?.delete();
    return chunks.length ? { geometry: flat(chunks), owners, keys } : null;
  };

  const built: { region: Region; groups: Group[] }[] = [];
  let lowest = Infinity;
  regions.forEach((region, ri) => {
    const share = (x: number) => (ri + x * 0.7) / regions.length;
    const r = region.ring;
    const edited = clipObjects(editedOsm, r);
    // Each outline's terrain a solid of its own; a lid stands on the pocket's top: its own
    // terrain's bottom raised to there.
    const grounds = region.ground.map((g, gi) => groundOf(g, share, `ground ${ri} ${gi}`));
    const lids = region.lids.map((l, li) => groundOf(l, share, `lid ${ri} ${li}`, lidBottom));
    for (const g of grounds) lowest = Math.min(lowest, g.base);
    const fills = (key: keyof GroundSolids) => [...grounds, ...lids].map((x) => solids(x.g[key] as { positions: number[]; owners: number[] }));
    progress(share(1), 'Adding buildings and trees');
    // Models, trees: whole, in the piece holding their middle (not cut at its edge).
    const holds = (p: LngLat) => pointInRing(p, r);
    const models = (which: 0 | 1, name: 'buildings' | 'bridges') => (spec ? modelsIn(allModels[which], r) : pick(buildModels(data.osm, edits, at, name)));
    // A single tree a cut would split: left out.
    const nearCut = (t: { at: LngLat; size: number }) => {
      const [X, Y] = toMm(t.at);
      const reach = Math.max(TREE_RADIUS_M * t.size, at.minWidth / 2) * mmPerUnit;
      return cuts.x.some((c) => Math.abs(X - c) < reach) || cuts.y.some((c) => Math.abs(Y - c) < reach);
    };
    const groups: Group[] = [
      { name: TERRAIN, color: '#c9bba5', pieces: [...grounds, ...lids].flatMap((g) => g.terrain) },
      { name: 'Water', color: '#3b8fe0', pieces: fills('water') },
      {
        name: 'Boats',
        color: '#f4f4f0',
        pieces: show('water') ? [pick(buildBoats(mooredBoats({ ...data.osm, ...edited }).filter((b) => boatInside(b, r) && !edits.get(b.key)?.deleted), at))] : [],
      },
      { name: 'Streets', color: '#' + COLORS.road.getHexString(), pieces: fills('streets') },
      // Each its own part, so a slicer can give it its own filament or the terrain's.
      { name: 'Squares', color: '#c9c6c1', pieces: fills('squares') },
      { name: 'Parks', color: '#5fae4c', pieces: fills('parks') },
      { name: 'Sand and rock', color: '#e8d6a4', pieces: fills('sand') },
      // Steep ground, gray like the 3D view's rock: its own filament in a 3MF.
      { name: 'Rock', color: '#9c978e', pieces: fills('rock') },
      {
        name: 'Buildings',
        color: '#' + COLORS.wall.getHexString(),
        // Buildings replaced by 3D models are models here too.
        pieces: show('buildings') ? [pick(buildBuildings(edited.buildings, at)), models(0, 'buildings')] : [],
      },
      {
        name: 'Bridges and structures',
        color: '#' + COLORS.structure.getHexString(),
        pieces: [
          show('structures') ? pick(buildStructures({ ...data.osm, ...edited }, at)) : null,
          // Bridges replaced by 3D models.
          show('structures') ? models(1, 'bridges') : null,
          show('roads') ? pick(buildBridges(edited.roads, at, COLORS.road)) : null,
          show('railways') ? pick(buildBridges(edited.railways, at, COLORS.rail)) : null,
        ],
      },
      (() => {
        // Forests: their canopy, crowns at a real crown's size whatever the print's (too small
        // for the nozzle, they show in red, like any object), reaching into the ground like
        // everything standing on it.
        const canopy = show('trees')
          ? buildCanopy(editedOsm, r, frame, (x, z) => groundHeight(elevationAt(data.terrain, ...frame.toLngLat([x, z]))), {
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
        const trees = editedTrees(data.osm.trees, edits, TREE_HEIGHT_M).filter((t) => !spec || (holds(t.at) && !nearCut(t)));
        const g = show('trees') ? treesGeometry(trees, at) : null;
        // Each tree is a cone of the same number of triangles, one after another.
        const perTree = new ConeGeometry(1, 1, 7).toNonIndexed().getAttribute('position').count / 3;
        return { name: 'Trees', color: '#' + COLORS.tree.getHexString(), pieces: [g && { geometry: g, owners: treeOwners(g, perTree) }] };
      })(),
    ];
    built.push({ region, groups });
  });

  // Scene (x east, y up, z south, meters) → print (X, Y in the shape's own frame, Z up, mm),
  // centered, base at Z = 0. Only rotations, so faces keep their winding.
  progress(0.95, 'Putting it together');
  const baseY = lowest;
  const out = (spec ? pieces : [null]).map(() => ({ parts: [] as PrintPart[], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
  // Solids and objects are numbered across the whole print.
  let nextSolid = 0;
  const named = new Map<string, number>();
  const objectIds = new Map<string | number, number>();
  const objectOf = (k: string | number) => {
    let id = objectIds.get(k);
    if (id === undefined) objectIds.set(k, (id = objectIds.size));
    return id;
  };
  const byPiece = new Map<number, Map<string, { color: string; featureMm?: number; chunks: Float32Array[]; solids: Uint32Array[]; objects: Uint32Array[] }>>();
  for (const { region, groups } of built) {
    const target = out[region.piece];
    const partsOf = byPiece.get(region.piece) ?? (byPiece.set(region.piece, new Map()), byPiece.get(region.piece)!);
    for (const group of groups) {
      let groupSolid: number | undefined;
      for (const piece of group.pieces) {
        if (!piece) continue;
        const g = piece.geometry;
        const flatG = g.index ? g.toNonIndexed() : g;
        const pos = flatG.getAttribute('position');
        const arr = new Float32Array(pos.count * 3);
        // A piece's terrain built on its own outline has its own bottom: lowered to the
        // print's, so all pieces stand on one base (a lid's to the pocket's top).
        const bottom = piece.base === undefined ? undefined : Math.fround(piece.base);
        const to = piece.raise === undefined ? baseY : baseY + piece.raise;
        for (let i = 0; i < pos.count; i++) {
          const y = bottom !== undefined && pos.getY(i) === bottom ? to : pos.getY(i);
          const [px, py] = plan(pos.getX(i), pos.getZ(i));
          const X = (px - cx) * mmPerUnit;
          const Y = (py - cy) * mmPerUnit;
          const Z = (y - baseY) * mmPerUnit;
          arr.set([X, Y, Z], i * 3);
          for (const [k, v] of [X, Y, Z].entries()) {
            target.min[k] = Math.min(target.min[k], v);
            target.max[k] = Math.max(target.max[k], v);
          }
        }
        // Without owners the geometry is one solid, shared by all such pieces of the group (the
        // terrain tile's top and sides close each other); with an empty list, one of its own.
        const tris = pos.count / 3;
        const solidIds = new Uint32Array(tris);
        const objects = new Uint32Array(tris);
        let base: number;
        if (piece.solid !== undefined) base = named.get(piece.solid) ?? (named.set(piece.solid, nextSolid++), named.get(piece.solid)!);
        else if (!piece.owners) base = groupSolid ??= nextSolid++;
        else base = nextSolid;
        let top = 0;
        for (let t = 0; t < tris; t++) {
          const o = piece.owners ? Math.max(0, piece.owners[t]) : 0;
          solidIds[t] = base + o;
          objects[t] = objectOf(piece.keys ? piece.keys[o] : solidIds[t]);
          top = Math.max(top, o);
        }
        if (piece.owners) nextSolid = base + top + 1;
        const part = partsOf.get(group.name) ?? (partsOf.set(group.name, { color: group.color, featureMm: group.featureMm, chunks: [], solids: [], objects: [] }), partsOf.get(group.name)!);
        part.chunks.push(arr);
        part.solids.push(solidIds);
        part.objects.push(objects);
        if (flatG !== g) flatG.dispose();
        g.dispose();
      }
    }
    // The tabs: blocks from the bed up, each a solid of its own.
    if (region.tabs.length) {
      const part = partsOf.get(TERRAIN) ?? (partsOf.set(TERRAIN, { color: '#c9bba5', chunks: [], solids: [], objects: [] }), partsOf.get(TERRAIN)!);
      for (const footprint of region.tabs) {
        const t = prism(footprint, 0, JOINT.height * options.baseMm);
        const id = nextSolid++;
        part.chunks.push(t);
        part.solids.push(new Uint32Array(t.length / 9).fill(id));
        part.objects.push(new Uint32Array(t.length / 9).fill(objectOf(id)));
        for (let i = 0; i < t.length; i++) {
          target.min[i % 3] = Math.min(target.min[i % 3], t[i]);
          target.max[i % 3] = Math.max(target.max[i % 3], t[i]);
        }
      }
    }
  }
  const join = <T extends Float32Array | Uint32Array>(list: T[], make: (n: number) => T): T => {
    const all = make(list.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of list) {
      all.set(c, o);
      o += c.length;
    }
    return all;
  };
  // The inverse of the conversion above: plan() is its own inverse, Z up becomes y up.
  const k = 1 / mmPerUnit;
  const [tx, tz] = [cos * cx + sin * cy, sin * cx - cos * cy];
  const toScene = new Matrix4().set(cos * k, sin * k, 0, tx, 0, 0, k, baseY, sin * k, -cos * k, 0, tz, 0, 0, 0, 1);
  return out.map((o, i) => {
    const parts: PrintPart[] = [];
    for (const [name, p] of byPiece.get(i) ?? []) {
      const triangles = join(p.chunks, (n) => new Float32Array(n));
      if (!triangles.length) continue;
      parts.push({ name, color: p.color, triangles, solids: join(p.solids, (n) => new Uint32Array(n)), objects: join(p.objects, (n) => new Uint32Array(n)), featureMm: p.featureMm });
    }
    const model: PrintModel = {
      uncutModels: uncut.size || undefined,
      parts,
      sizeMm: parts.length ? [o.max[0] - o.min[0], o.max[1] - o.min[1], o.max[2] - o.min[2]] : [0, 0, 0],
      triangleCount: parts.reduce((n, p) => n + p.triangles.length / 9, 0),
      toScene,
      crownMm: parts.find((p) => p.featureMm !== undefined)?.featureMm,
    };
    return { piece: spec ? pieces[i] : null, model };
  });
}

// The pieces as one model: each part tagged with its piece (the preview shows them pulled
// apart, the download writes each on its own).
export function combinePieces(list: { piece: Piece | null; model: PrintModel }[], grid: { cols: number; rows: number }): PrintModel {
  const parts = list.flatMap(({ model }, i) => model.parts.map((p) => ({ ...p, piece: i })));
  const [min, max] = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
  for (const p of parts) {
    for (let i = 0; i < p.triangles.length; i++) {
      min[i % 3] = Math.min(min[i % 3], p.triangles[i]);
      max[i % 3] = Math.max(max[i % 3], p.triangles[i]);
    }
  }
  return {
    parts,
    sizeMm: parts.length ? [max[0] - min[0], max[1] - min[1], max[2] - min[2]] : [0, 0, 0],
    triangleCount: parts.reduce((n, p) => n + p.triangles.length / 9, 0),
    toScene: list[0].model.toScene,
    crownMm: parts.find((p) => p.featureMm !== undefined)?.featureMm,
    pieces: list.map(({ piece }) => ({ col: piece?.col ?? 0, row: piece?.row ?? 0 })),
    uncutModels: list[0].model.uncutModels,
    grid,
  };
}

// One piece of a combined model, as a model of its own.
export function pieceOf(model: PrintModel, i: number): PrintModel {
  const parts = model.parts.filter((p) => p.piece === i);
  return { ...model, parts, triangleCount: parts.reduce((n, p) => n + p.triangles.length / 9, 0), pieces: undefined, grid: undefined };
}

// A block on a convex counterclockwise footprint (print mm), as triangles (9 floats each).
function prism(ring: Pt[], z0: number, z1: number): Float32Array {
  const out: number[] = [];
  const n = ring.length;
  for (let k = 1; k + 1 < n; k++) {
    out.push(ring[0][0], ring[0][1], z1, ring[k][0], ring[k][1], z1, ring[k + 1][0], ring[k + 1][1], z1);
    out.push(ring[0][0], ring[0][1], z0, ring[k + 1][0], ring[k + 1][1], z0, ring[k][0], ring[k][1], z0);
  }
  for (let k = 0; k < n; k++) {
    const [a, b] = [ring[k], ring[(k + 1) % n]];
    out.push(a[0], a[1], z0, b[0], b[1], z0, b[0], b[1], z1);
    out.push(a[0], a[1], z0, b[0], b[1], z1, a[0], a[1], z1);
  }
  return Float32Array.from(out);
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
  // In pieces, a kind of part comes once per piece: counted together.
  const total = new Map<string, number>();
  for (const [name, n] of counts) total.set(name, (total.get(name) ?? 0) + n);
  return { objects, counts: [...total] };
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
