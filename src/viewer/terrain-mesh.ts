// The ground as a printable-looking tile: the terrain grid cut exactly to the selection
// outline, with side walls down to a flat base. The top carries UVs for the painted ground
// texture.
//
// Cells wholly inside the outline are kept as they are; cells the outline passes through are
// cut along it (each grid triangle intersected with the outline), with heights interpolated
// inside the triangle, so the cut lies exactly on the surface. The walls hang from the
// surface's open edges, which after the cut are the outline itself.

import { BufferGeometry, Float32BufferAttribute, ShapeUtils, Vector2 } from 'three';
import { pointInRing, type LngLat } from '../geo';
import type { LocalFrame } from '../local';
import { lngLatPixel, pixelLngLat, type Terrain } from '../terrain';

// Finer than this is wasted on screen and slow to build.
const MAX_GRID = 512;

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface TerrainMesh {
  top: BufferGeometry;
  sides: BufferGeometry;
  // Base of the tile, in scene units (meters × exaggeration).
  baseY: number;
}

// A point in grid pixel space with its terrain height (meters).
export type GP = { x: number; y: number; h: number };

// The terrain grid as the tile is built from it: every `step`-th sample (the last row and
// column clamped to the edge), each cell split into the triangles a-d-b and b-d-e (a top left,
// e bottom right). Anything that lies on the terrain must follow these same triangles.
export interface Grid {
  step: number;
  cols: number;
  rows: number;
  colX: (c: number) => number;
  rowY: (r: number) => number;
  // Terrain height (meters) at a grid corner.
  height: (c: number, r: number) => number;
}

export function terrainGrid(t: Terrain): Grid {
  const step = Math.ceil(Math.max(t.width, t.height) / MAX_GRID);
  const colX = (c: number) => Math.min(c * step, t.width - 1);
  const rowY = (r: number) => Math.min(r * step, t.height - 1);
  return {
    step,
    cols: Math.ceil((t.width - 1) / step) + 1,
    rows: Math.ceil((t.height - 1) / step) + 1,
    colX,
    rowY,
    height: (c, r) => t.heights[rowY(r) * t.width + colX(c)],
  };
}

// `ground(h)` turns a terrain height into the scene height (sea clamp, exaggeration).
export function buildTerrain(
  t: Terrain,
  ring: LngLat[],
  frame: LocalFrame,
  bounds: Bounds,
  ground: (h: number) => number,
  baseDepth: number,
): TerrainMesh {
  const { step, cols, rows, colX, rowY, height } = terrainGrid(t);

  // Vertices are shared by position, so the open edges can be found by counting edge uses.
  // Grid corners (nearly all of them) are found by their index; points cut along the
  // outline by their position.
  const pos: number[] = [];
  const uv: number[] = [];
  const ids = new Map<string, number>();
  const gridIds = new Int32Array(cols * rows).fill(-1);
  // A point cut on an edge two grid triangles share is computed once by each, through
  // different clipping steps: the two results differ by float noise, and as two vertices
  // they'd leave open edges inside the surface (walls inside the tile, a base walking off
  // the outline in stripes). Points this close (about a millimeter) are one vertex.
  const SNAP = 1e-4;
  // A grid corner, or a cut point within float noise of one (clipping a grid triangle the
  // outline fully contains gives back its corners, recomputed): the same vertex either way.
  const gridIndex = (x: number, y: number): number => {
    const c = Math.min(Math.round(x / step), cols - 1);
    const r = Math.min(Math.round(y / step), rows - 1);
    return Math.abs(colX(c) - x) < SNAP && Math.abs(rowY(r) - y) < SNAP ? r * cols + c : -1;
  };
  const cell = (v: number) => Math.round(v / SNAP);
  const nearby = (x: number, y: number): number | undefined => {
    const [cx, cy] = [cell(x), cell(y)];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const id = ids.get(`${cx + dx},${cy + dy}`);
        if (id !== undefined) return id;
      }
    }
    return undefined;
  };
  const vertex = ({ x, y, h }: GP): number => {
    const g = gridIndex(x, y);
    let id = g < 0 ? nearby(x, y) : gridIds[g] < 0 ? undefined : gridIds[g];
    if (id === undefined) {
      id = pos.length / 3;
      if (g < 0) ids.set(`${cell(x)},${cell(y)}`, id);
      else gridIds[g] = id;
      const [lx, lz] = frame.toLocal(pixelLngLat(t, x, y));
      pos.push(lx, ground(h), lz);
      uv.push((lx - bounds.minX) / (bounds.maxX - bounds.minX), 1 - (lz - bounds.minZ) / (bounds.maxZ - bounds.minZ));
    }
    return id;
  };

  const ringPx = ring.slice(0, -1).map((p) => lngLatPixel(t, p));
  const inside: boolean[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) inside.push(pointInRing(pixelLngLat(t, colX(c), rowY(r)), ring));
  }
  // Cells holding an outline corner need cutting even if their own corners are all inside.
  const cornerCells = new Set<number>();
  for (const [x, y] of ringPx) {
    const c = Math.min(Math.max(Math.floor(x / step), 0), cols - 2);
    const r = Math.min(Math.max(Math.floor(y / step), 0), rows - 2);
    cornerCells.add(r * cols + c);
  }

  const index: number[] = [];
  // Faces must wind so they face up: in pixel space (x east, y south) that's a negative cross.
  const face = (a: number, b: number, c: number) => {
    const ax = pos[3 * a], az = pos[3 * a + 2];
    const cross = (pos[3 * b] - ax) * (pos[3 * c + 2] - az) - (pos[3 * b + 2] - az) * (pos[3 * c] - ax);
    if (Math.abs(cross) < 1e-9) return;
    if (cross > 0) index.push(a, c, b);
    else index.push(a, b, c);
  };

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const corner = (cc: number, rr: number): GP => ({ x: colX(cc), y: rowY(rr), h: height(cc, rr) });
      const ids4 = [r * cols + c, r * cols + c + 1, (r + 1) * cols + c, (r + 1) * cols + c + 1];
      const flags = ids4.map((i) => inside[i]);
      const a = corner(c, r), b = corner(c + 1, r), d = corner(c, r + 1), e = corner(c + 1, r + 1);
      if (flags.every(Boolean) && !cornerCells.has(r * cols + c)) {
        face(vertex(a), vertex(d), vertex(b));
        face(vertex(b), vertex(d), vertex(e));
      } else if (flags.some(Boolean) || cornerCells.has(r * cols + c) || cellCrossed(ringPx, a, e)) {
        for (const tri of [[a, d, b], [b, d, e]] as GP[][]) cutTriangle(tri, ringPx, vertex, face);
      }
    }
  }

  const top = new BufferGeometry();
  top.setAttribute('position', new Float32BufferAttribute(pos, 3));
  top.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  top.setIndex(index);
  top.computeVertexNormals();

  // Open edges of the surface (used by one face only) run along the outline. Each keeps the
  // direction its face goes round, so the walls hung from it can wind the opposite way: a
  // shared edge crossed in opposite directions is what makes the tile one closed solid.
  const uses = new Map<number, [number, number]>();
  const count = pos.length / 3;
  for (let i = 0; i < index.length; i += 3) {
    for (const [p, q] of [[index[i], index[i + 1]], [index[i + 1], index[i + 2]], [index[i + 2], index[i]]]) {
      const key = p < q ? p * count + q : q * count + p;
      if (uses.has(key)) uses.delete(key);
      else uses.set(key, [p, q]);
    }
  }
  let minY = Infinity;
  for (let i = 1; i < pos.length; i += 3) minY = Math.min(minY, pos[i]);
  const baseY = minY - baseDepth;

  const side: number[] = [];
  const top3 = (i: number) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
  const base3 = (i: number) => [pos[3 * i], baseY, pos[3 * i + 2]];
  const out = new Map<number, number[]>();
  for (const [p, q] of uses.values()) {
    side.push(...top3(q), ...top3(p), ...base3(p));
    side.push(...top3(q), ...base3(p), ...base3(q));
    out.set(p, [...(out.get(p) ?? []), q]);
  }
  // The base: each rim loop at the base height, through the very same points as the walls'
  // bottom edges, triangulated (free shapes can be concave) and facing down. Where two parts
  // of the surface touch at a point (the outline pinching through one grid triangle), the
  // rim leaves that point twice: the walk takes the sharpest turn, so each loop stays a
  // simple polygon instead of a figure eight that triangulates across the gap.
  const dir = (a: number, b: number) => [pos[3 * b] - pos[3 * a], pos[3 * b + 2] - pos[3 * a + 2]];
  const turn = (from: number, at: number, to: number) => {
    const [ix, iz] = dir(from, at);
    const [ox, oz] = dir(at, to);
    return Math.atan2(ix * oz - iz * ox, ix * ox + iz * oz);
  };
  const take = (from: number, at: number): number | undefined => {
    const options = out.get(at);
    if (!options?.length) return undefined;
    let best = 0;
    for (let k = 1; k < options.length; k++) if (turn(from, at, options[k]) > turn(from, at, options[best])) best = k;
    return options.splice(best, 1)[0];
  };
  for (const start of out.keys()) {
    while (out.get(start)!.length) {
      const loop = [start];
      let prev = start;
      let v: number | undefined = out.get(start)!.pop();
      while (v !== undefined && v !== start) {
        loop.push(v);
        const w = take(prev, v);
        prev = v;
        v = w;
      }
      if (loop.length < 3) continue;
      const outline = loop.map((i) => new Vector2(pos[3 * i], pos[3 * i + 2]));
      for (const [a, b, c] of ShapeUtils.triangulateShape(outline, [])) {
        const [pa, pb, pc] = [base3(loop[a]), base3(loop[b]), base3(loop[c])];
        // Normal y < 0 means facing down.
        const ny = (pb[2] - pa[2]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[2] - pa[2]);
        side.push(...pa, ...(ny < 0 ? pb : pc), ...(ny < 0 ? pc : pb));
      }
    }
  }
  const sides = new BufferGeometry();
  sides.setAttribute('position', new Float32BufferAttribute(side, 3));
  sides.computeVertexNormals();
  return { top, sides, baseY };
}

// Whether any outline edge passes through the cell spanned by corners a (top-left) and e.
function cellCrossed(ringPx: [number, number][], a: GP, e: GP): boolean {
  for (let i = 0; i < ringPx.length; i++) {
    const [x0, y0] = ringPx[i];
    const [x1, y1] = ringPx[(i + 1) % ringPx.length];
    if (Math.max(x0, x1) < a.x || Math.min(x0, x1) > e.x || Math.max(y0, y1) < a.y || Math.min(y0, y1) > e.y) continue;
    return true;
  }
  return false;
}

// The part of the outline inside one grid triangle (Sutherland–Hodgman: the outline clipped
// by the triangle's three edges), triangulated, with heights from the triangle's plane.
function cutTriangle(tri: GP[], ringPx: [number, number][], vertex: (p: GP) => number, face: (a: number, b: number, c: number) => void) {
  let poly: [number, number][] = ringPx;
  // Clip against each edge, keeping the side the third corner is on.
  for (let i = 0; i < 3 && poly.length; i++) {
    const p = tri[i], q = tri[(i + 1) % 3], o = tri[(i + 2) % 3];
    const side = (x: number, y: number) => (q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x);
    const keep = Math.sign(side(o.x, o.y));
    const out: [number, number][] = [];
    for (let k = 0; k < poly.length; k++) {
      const s = poly[k];
      const e = poly[(k + 1) % poly.length];
      const ds = side(s[0], s[1]) * keep;
      const de = side(e[0], e[1]) * keep;
      if (ds >= 0) out.push(s);
      if ((ds >= 0) !== (de >= 0)) {
        const f = ds / (ds - de);
        out.push([s[0] + f * (e[0] - s[0]), s[1] + f * (e[1] - s[1])]);
      }
    }
    poly = out;
  }
  if (poly.length < 3) return;

  // Height on the triangle's plane (barycentric).
  const [a, b, c] = tri;
  const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  const at = ([x, y]: [number, number]): GP => {
    const wa = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / det;
    const wb = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / det;
    return { x, y, h: wa * a.h + wb * b.h + (1 - wa - wb) * c.h };
  };
  const ids = poly.map((p) => vertex(at(p)));
  const flat = poly.map(([x, y]) => new Vector2(x, y));
  for (const [i, j, k] of ShapeUtils.triangulateShape(flat, [])) face(ids[i], ids[j], ids[k]);
}
