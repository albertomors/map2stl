// Cutting the print into pieces (pieces.ts), in the print worker, with manifold-3d: a solid
// intersected with each piece's cell comes out with flat, closed cut faces; the terrain (or
// the whole model, for an STL) gets the tabs and pockets of its joints. For the file, each
// part's solids united first (merge.ts); what manifold-3d won't take (not closed) goes to the
// piece holding each triangle's middle, uncut. For the preview, quicker: only the solids a
// cut crosses are cut (the terrain, a few buildings and streets), each on its own; the rest
// go whole to their piece.

import type { PrintModel, PrintPart } from './export';
import { partSolids, type Wasm } from './merge';
import { JOINT, jointsOf, piecesOf, pocketFootprint, tabFootprint, type Grid, type Piece, type Pt } from './pieces';

export interface PieceSpec {
  grid: Grid;
  joints: boolean;
  // How much wider a pocket is than its tab, all round (mm).
  clearance: number;
}

export interface CutPiece {
  piece: Piece;
  model: PrintModel;
}

// Edge cells reach this far past the shape: a hair of it outside a cell must not be lost.
const OUTSIDE = 1e4;

// Each piece's cell, open past the grid's outer edges.
function cellBox(p: Piece, grid: Grid): [number, number, number, number] {
  const [x0, y0, x1, y1] = p.cell;
  return [p.col === 0 ? -OUTSIDE : x0, p.row === grid.rows - 1 ? -OUTSIDE : y0, p.col === grid.cols - 1 ? OUTSIDE : x1, p.row === 0 ? OUTSIDE : y1];
}

// `jointPart`: the part the joints go in (its base): the terrain, or the whole model.
export function cutPieces(wasm: Wasm, model: PrintModel, outline: Pt[], spec: PieceSpec, baseMm: number, jointPart: string, progress: (f: number) => void = () => {}): CutPiece[] {
  const { Manifold } = wasm;
  const pieces = piecesOf(outline, spec.grid);
  const cut = cutter(wasm, outline, pieces, spec, baseMm, model.sizeMm[2]);
  const out = pieces.map(() => [] as PrintPart[]);
  model.parts.forEach((part, partIndex) => {
    const { ok, left } = partSolids(wasm, part);
    const whole = ok.length ? Manifold.union(ok) : null;
    for (const m of ok) m.delete();
    pieces.forEach((piece, i) => {
      const chunks: Float32Array[] = [];
      const solids: number[] = [];
      if (whole) {
        const t = cut(whole, i, part.name === jointPart);
        if (t.length) {
          chunks.push(t);
          for (let k = 0; k < t.length / 9; k++) solids.push(0);
        }
      }
      // Not closed: whole triangles, to the piece holding their middle.
      const [x0, y0, x1, y1] = cellBox(piece, spec.grid);
      const ids = new Map<number, number>();
      const kept: number[] = [];
      for (const t of left) {
        const o = t * 9;
        const [mx, my] = [(part.triangles[o] + part.triangles[o + 3] + part.triangles[o + 6]) / 3, (part.triangles[o + 1] + part.triangles[o + 4] + part.triangles[o + 7]) / 3];
        if (mx < x0 || mx >= x1 || my < y0 || my >= y1) continue;
        kept.push(t);
        const s = part.solids[t];
        if (!ids.has(s)) ids.set(s, 1 + ids.size);
        solids.push(ids.get(s)!);
      }
      if (kept.length) {
        const t = new Float32Array(kept.length * 9);
        kept.forEach((tri, k) => t.set(part.triangles.subarray(tri * 9, tri * 9 + 9), k * 9));
        chunks.push(t);
      }
      if (!chunks.length) return;
      const triangles = join(chunks);
      const s = Uint32Array.from(solids);
      out[i].push({ name: part.name, color: part.color, triangles, solids: s, objects: s });
    });
    whole?.delete();
    progress((partIndex + 1) / model.parts.length);
  });
  return pieces.map((piece, i) => ({ piece, model: modelOf(out[i], model) }));
}

// A solid cut to piece i's cell, with its joints' tabs and pockets if `joints`, as triangles.
function cutter(wasm: Wasm, outline: Pt[], pieces: Piece[], spec: PieceSpec, baseMm: number, heightMm: number) {
  const { Manifold } = wasm;
  const joints = spec.joints ? jointsOf(outline, pieces, spec.grid, spec.clearance) : [];
  const height = JOINT.height * baseMm;
  // Counterclockwise footprints raised into blocks: a tab from the bed up, a pocket from
  // below the bed (open at the bottom) to the clearance above the tab.
  const block = (ring: Pt[], z0: number, z1: number) => Manifold.extrude([ring], z1 - z0).translate([0, 0, z0]);
  const tall = heightMm + 20;
  return (solid: InstanceType<Wasm['Manifold']>, i: number, withJoints: boolean): Float32Array => {
    const [x0, y0, x1, y1] = cellBox(pieces[i], spec.grid);
    const box = Manifold.cube([x1 - x0, y1 - y0, tall]).translate([x0, y0, -10]);
    let cut = solid.intersect(box);
    box.delete();
    if (withJoints) {
      for (const j of joints) {
        if (j.tab !== i && j.pocket !== i) continue;
        const shape = j.tab === i ? block(tabFootprint(j), 0, height) : block(pocketFootprint(j, spec.clearance), -1, height + spec.clearance);
        const next = j.tab === i ? cut.add(shape) : cut.subtract(shape);
        [cut, shape].forEach((m) => m.delete());
        cut = next;
      }
    }
    const t = trianglesOf(cut);
    cut.delete();
    return t;
  };
}

// The pieces for the preview, each piece's parts tagged with it (and the part they came from,
// for the thin details' marks); and how far each piece moves out when the view pulls them
// apart.
export interface ShownPart extends PrintPart {
  piece: number;
  from: number;
}

export function piecesForPreview(wasm: Wasm, model: PrintModel, outline: Pt[], spec: PieceSpec, baseMm: number, jointPart: string): { parts: ShownPart[]; offsets: Pt[] } {
  const { Manifold, Mesh } = wasm;
  const pieces = piecesOf(outline, spec.grid);
  const cut = cutter(wasm, outline, pieces, spec, baseMm, model.sizeMm[2]);
  const boxes = pieces.map((p) => cellBox(p, spec.grid));
  const parts: ShownPart[] = [];
  model.parts.forEach((part, from) => {
    const buffers = pieces.map(() => ({ chunks: [] as Float32Array[], solids: [] as number[], objects: [] as number[] }));
    const add = (i: number, t: Float32Array, solid: number, object: number) => {
      if (!t.length) return;
      buffers[i].chunks.push(t);
      for (let k = 0; k < t.length / 9; k++) {
        buffers[i].solids.push(solid);
        buffers[i].objects.push(object);
      }
    };
    const t = part.triangles;
    const bySolid = new Map<number, number[]>();
    for (let tri = 0; tri < part.solids.length; tri++) {
      const list = bySolid.get(part.solids[tri]);
      if (list) list.push(tri);
      else bySolid.set(part.solids[tri], [tri]);
    }
    for (const [solid, tris] of bySolid) {
      let [lx, ly, hx, hy] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const tri of tris) {
        for (let v = 0; v < 3; v++) {
          const [x, y] = [t[tri * 9 + v * 3], t[tri * 9 + v * 3 + 1]];
          [lx, ly, hx, hy] = [Math.min(lx, x), Math.min(ly, y), Math.max(hx, x), Math.max(hy, y)];
        }
      }
      const object = part.objects[tris[0]];
      const own = (): Float32Array => {
        const out = new Float32Array(tris.length * 9);
        tris.forEach((tri, k) => out.set(t.subarray(tri * 9, tri * 9 + 9), k * 9));
        return out;
      };
      const crossed = boxes.flatMap((b, i) => (hx > b[0] && lx < b[2] && hy > b[1] && ly < b[3] ? [i] : []));
      // Inside one piece: as it is (the joints only touch solids a cut crosses).
      if (crossed.length === 1) {
        add(crossed[0], own(), solid, object);
        continue;
      }
      // Crossed by a cut: cut, closed, with the joints if it's the base.
      let m: InstanceType<typeof Manifold> | null = null;
      try {
        const mesh = new Mesh({ numProp: 3, vertProperties: own(), triVerts: new Uint32Array(tris.length * 3).map((_, i) => i) });
        mesh.merge();
        m = new Manifold(mesh);
        if (m.status() !== 'NoError' || m.isEmpty()) throw new Error('not manifold');
      } catch {
        m?.delete();
        m = null;
      }
      for (const i of crossed) {
        if (m) add(i, cut(m, i, part.name === jointPart), solid, object);
        else {
          // Not closed: its triangles clipped to the cell, open at the cut.
          const clipped: number[] = [];
          for (const tri of tris) {
            const o = tri * 9;
            const poly = clipToBox([[t[o], t[o + 1], t[o + 2]], [t[o + 3], t[o + 4], t[o + 5]], [t[o + 6], t[o + 7], t[o + 8]]], boxes[i]);
            for (let k = 1; k + 1 < poly.length; k++) clipped.push(...poly[0], ...poly[k], ...poly[k + 1]);
          }
          add(i, Float32Array.from(clipped), solid, object);
        }
      }
      m?.delete();
    }
    buffers.forEach((b, piece) => {
      if (b.chunks.length) parts.push({ name: part.name, color: part.color, triangles: join(b.chunks), solids: Uint32Array.from(b.solids), objects: Uint32Array.from(b.objects), featureMm: part.featureMm, piece, from });
    });
  });
  // Pulled apart along the grid: each piece out by its place in it, a step a ninth of a cell.
  const [cw, ch] = [pieces[0] ? pieces[0].cell[2] - pieces[0].cell[0] : 0, pieces[0] ? pieces[0].cell[3] - pieces[0].cell[1] : 0];
  const step = Math.max(cw, ch) / 9;
  const offsets = pieces.map((p): Pt => [(p.col - (spec.grid.cols - 1) / 2) * step, -(p.row - (spec.grid.rows - 1) / 2) * step]);
  return { parts, offsets };
}

// A triangle (or any convex polygon) clipped to a box in x and y (Sutherland-Hodgman), z
// interpolated along the cut edges.
type V3 = [number, number, number];
function clipToBox(poly: V3[], [x0, y0, x1, y1]: [number, number, number, number]): V3[] {
  const planes: [0 | 1, number, 1 | -1][] = [[0, x0, 1], [0, x1, -1], [1, y0, 1], [1, y1, -1]];
  for (const [axis, at, side] of planes) {
    const next: V3[] = [];
    for (let i = 0; i < poly.length; i++) {
      const [a, b] = [poly[i], poly[(i + 1) % poly.length]];
      const [da, db] = [(a[axis] - at) * side, (b[axis] - at) * side];
      if (da >= 0) next.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const f = da / (da - db);
        next.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
      }
    }
    poly = next;
    if (poly.length < 3) return [];
  }
  return poly;
}

function trianglesOf(m: InstanceType<Wasm['Manifold']>): Float32Array {
  const mesh = m.getMesh();
  const p = mesh.vertProperties;
  const n = mesh.numProp;
  const out = new Float32Array(mesh.triVerts.length * 3);
  mesh.triVerts.forEach((v, i) => out.set([p[v * n], p[v * n + 1], p[v * n + 2]], i * 3));
  return out;
}

function join(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// A piece's parts as a model of its own: its size from its triangles.
function modelOf(parts: PrintPart[], whole: PrintModel): PrintModel {
  const [min, max] = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
  for (const p of parts) {
    for (let i = 0; i < p.triangles.length; i++) {
      const k = i % 3;
      min[k] = Math.min(min[k], p.triangles[i]);
      max[k] = Math.max(max[k], p.triangles[i]);
    }
  }
  return {
    parts,
    sizeMm: parts.length ? [max[0] - min[0], max[1] - min[1], max[2] - min[2]] : [0, 0, 0],
    triangleCount: parts.reduce((n, p) => n + p.triangles.length / 9, 0),
    toScene: whole.toScene,
  };
}
