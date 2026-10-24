// Shapes laid on the terrain for printing: flat map layers (roads, parks, water) as surfaces
// that follow the terrain exactly, raised into thin solids or carved into the tile.
//
// Shapes are polygons in terrain grid pixels, already cut into small tiles (so their
// triangles stay small). Each is triangulated and its triangles cut by the grid's own
// triangles (the ones the tile is built from), so every point of a surface lies on the
// terrain's plane there, plus an offset: never inside the ground on a slope, never floating
// above it.

import { ShapeUtils, Vector2 } from 'three';
import type { LocalFrame } from '../local';
import { pixelLngLat, type Terrain } from '../terrain';
import type { GP, Grid } from './terrain-mesh';

type Tri = [GP, GP, GP];
type Pair = [number, number];

// A polygon in grid pixels: rings open (last point ≠ first), holes inside the outer ring.
export interface Poly {
  outer: Pair[];
  holes: Pair[][];
}

// Context shared by every shape on one tile: the grid, and grid point → scene position.
export interface DrapeContext {
  grid: Grid;
  // A cell whose two triangles are this close to one plane (terrain meters: how far the
  // corner heights are from it, summed) is cut as a whole, not along its diagonal too.
  flatness: number;
  // Scene [x, y, z] of a grid point, `offset` scene units above (or below) the terrain.
  scene: (p: GP, offset: number) => [number, number, number];
}

export function drapeContext(t: Terrain, grid: Grid, frame: LocalFrame, ground: (h: number) => number, flatness: number): DrapeContext {
  return {
    grid,
    flatness,
    scene: (p, offset) => {
      const [x, z] = frame.toLocal(pixelLngLat(t, p.x, p.y));
      return [x, ground(p.h) + offset, z];
    },
  };
}

// The triangles of some polygons' surface on the terrain, facing up: each polygon is
// triangulated, and each of its triangles cut by the grid triangles under it (both convex, so
// a plain clip of one by the other does), with heights from the grid's planes. A flat cell
// (most of them, in a city) is cut as one square, heights blended from its corners: that
// matches its neighbors exactly along its sides, and halves the pieces.
export function drapeFaces({ grid, flatness }: DrapeContext, polys: Poly[]): Tri[] {
  const { step, cols, rows, colX, rowY, height } = grid;
  const out: Tri[] = [];
  const cellCol = (x: number) => Math.min(Math.max(Math.floor(x / step), 0), cols - 2);
  const cellRow = (y: number) => Math.min(Math.max(Math.floor(y / step), 0), rows - 2);
  const corner = (c: number, r: number): GP => ({ x: colX(c), y: rowY(r), h: height(c, r) });
  for (const poly of polys) {
    if (poly.outer.length < 3) continue;
    const points = [poly.outer, ...poly.holes].flat();
    const v = (ring: Pair[]) => ring.map(([x, y]) => new Vector2(x, y));
    for (const [i, j, k] of ShapeUtils.triangulateShape(v(poly.outer), poly.holes.map(v))) {
      const tri = [points[i], points[j], points[k]];
      const xs = tri.map((p) => p[0]);
      const ys = tri.map((p) => p[1]);
      for (let r = cellRow(Math.min(...ys)); r <= cellRow(Math.max(...ys)); r++) {
        for (let c = cellCol(Math.min(...xs)); c <= cellCol(Math.max(...xs)); c++) {
          const a = corner(c, r), b = corner(c + 1, r), d = corner(c, r + 1), e = corner(c + 1, r + 1);
          if (Math.abs(a.h + e.h - b.h - d.h) <= flatness) {
            const [x0, x1, y0, y1] = [a.x, b.x, a.y, d.y];
            const bilinear = (x: number, y: number) => {
              const u = (x - x0) / (x1 - x0);
              const v = (y - y0) / (y1 - y0);
              return a.h * (1 - u) * (1 - v) + b.h * u * (1 - v) + d.h * (1 - u) * v + e.h * u * v;
            };
            clipConvex(tri, [a, d, e, b], bilinear, out);
          } else {
            for (const g of [[a, d, b], [b, d, e]] as Tri[]) clipConvex(tri, g, planeOf(g), out);
          }
        }
      }
    }
  }
  return out;
}

// Height on a grid triangle's plane (barycentric).
function planeOf([a, b, c]: Tri): (x: number, y: number) => number {
  const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  return (x, y) => {
    const wa = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / det;
    const wb = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / det;
    return wa * a.h + wb * b.h + (1 - wa - wb) * c.h;
  };
}

// The part of triangle `tri` inside the convex grid shape `g` (Sutherland–Hodgman), fanned
// into triangles, each point at the height `heightAt` gives.
function clipConvex(tri: Pair[], g: GP[], heightAt: (x: number, y: number) => number, out: Tri[]) {
  let poly = tri;
  const n = g.length;
  for (let i = 0; i < n && poly.length >= 3; i++) {
    const p = g[i], q = g[(i + 1) % n], o = g[(i + 2) % n];
    const side = (x: number, y: number) => (q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x);
    const keep = Math.sign(side(o.x, o.y));
    const next: Pair[] = [];
    for (let k = 0; k < poly.length; k++) {
      const s = poly[k];
      const e = poly[(k + 1) % poly.length];
      const ds = side(s[0], s[1]) * keep;
      const de = side(e[0], e[1]) * keep;
      if (ds >= 0) next.push(s);
      if ((ds >= 0) !== (de >= 0)) {
        const f = ds / (ds - de);
        next.push([s[0] + f * (e[0] - s[0]), s[1] + f * (e[1] - s[1])]);
      }
    }
    poly = next;
  }
  if (poly.length < 3) return;
  const pts = poly.map(([x, y]): GP => ({ x, y, h: heightAt(x, y) }));
  // Even near-flat slivers stay: dropping one would leave its long edge facing two short ones
  // on the other side, a crack. (Triangles squashed to a line by shared points drop later.)
  for (let k = 1; k < pts.length - 1; k++) out.push(up([pts[0], pts[k], pts[k + 1]]));
}

// Faces up in the scene: in pixel space (x east, y south, like the scene's x and z) that's a
// negative cross product, as in the terrain mesh.
function up(t: Tri): Tri {
  const [a, b, c] = t;
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return cross > 0 ? [a, c, b] : t;
}

// A surface's triangles as shared points: each point once (by its grid position), so the
// surface's open edges (used by one face) can be found: those run along its outline. Points
// on a tile seam come out of both tiles alike, which stitches the tiles back together.
// Points snap to a thousandth of a pixel (millimeters on the ground): two points are then
// either the same or clearly apart, never so close that the file's 32-bit coordinates fuse
// them and fold the triangles between.
const SNAP = 1e3;

// Snap cells shared by several surfaces, so a border two of them share gets the same points
// on both sides. Computed separately, the two sides can land a hair apart, in neighboring
// cells: a point within one cell of one already taken becomes that one.
export class Welder {
  private cells = new Map<string, [number, number]>();

  weld(x: number, y: number): [number, number] {
    const cx = Math.round(x * SNAP);
    const cy = Math.round(y * SNAP);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const found = this.cells.get(`${cx + dx},${cy + dy}`);
        if (found) return found;
      }
    }
    this.cells.set(`${cx},${cy}`, [cx, cy]);
    return [cx, cy];
  }
}

class Surface {
  readonly points: GP[] = [];
  readonly faces: [number, number, number][] = [];
  private ids = new Map<string, number>();

  constructor(tris: Tri[], private welder = new Welder()) {
    for (const [a, b, c] of tris) {
      const f: [number, number, number] = [this.id(a), this.id(b), this.id(c)];
      if (f[0] !== f[1] && f[1] !== f[2] && f[0] !== f[2]) this.faces.push(f);
    }
  }

  static key(p: GP): string {
    return `${Math.round(p.x * SNAP)},${Math.round(p.y * SNAP)}`;
  }

  private id(p: GP): number {
    const [cx, cy] = this.welder.weld(p.x, p.y);
    const key = `${cx},${cy}`;
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.points.length;
      this.ids.set(key, id);
      this.points.push({ x: cx / SNAP, y: cy / SNAP, h: p.h });
    }
    return id;
  }

  // Open edges, each in the direction its face goes round.
  openEdges(): [number, number][] {
    const uses = new Map<string, [number, number]>();
    for (const [a, b, c] of this.faces) {
      for (const [p, q] of [[a, b], [b, c], [c, a]] as [number, number][]) {
        const key = p < q ? `${p},${q}` : `${q},${p}`;
        if (uses.has(key)) uses.delete(key);
        else uses.set(key, [p, q]);
      }
    }
    return [...uses.values()];
  }

  // Which connected piece each point belongs to (faces sharing a point are connected).
  components(): number[] {
    const parent = this.points.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
    for (const [a, b, c] of this.faces) {
      parent[find(b)] = find(a);
      parent[find(c)] = find(a);
    }
    const ids = new Map<number, number>();
    return this.points.map((_, i) => {
      const root = find(i);
      if (!ids.has(root)) ids.set(root, ids.size);
      return ids.get(root)!;
    });
  }
}

export interface Solids {
  // Triangles, 9 floats each, scene units.
  positions: number[];
  // The solid of each triangle.
  owners: number[];
}

// Closed solids, one per connected piece: the surface `top` above the terrain, a copy
// `bottom` above it (negative: inside the ground), and walls between them along the outline.
// `count` is how many solids; their owners start at `firstOwner`.
export function drapedSolids(ctx: DrapeContext, polys: Poly[], top: number, bottom: number, firstOwner = 0): Solids & { count: number } {
  const positions: number[] = [];
  const owners: number[] = [];
  const s = new Surface(drapeFaces(ctx, polys));
  const piece = s.components();
  const hi = s.points.map((p) => ctx.scene(p, top));
  const lo = s.points.map((p) => ctx.scene(p, bottom));
  const tri = (a: number[], b: number[], c: number[], owner: number) => {
    positions.push(...a, ...b, ...c);
    owners.push(firstOwner + owner);
  };
  for (const [a, b, c] of s.faces) {
    tri(hi[a], hi[b], hi[c], piece[a]);
    tri(lo[a], lo[c], lo[b], piece[a]);
  }
  // Walls hang from each open edge, winding the opposite way round it to the face above.
  for (const [p, q] of s.openEdges()) {
    tri(hi[q], hi[p], lo[p], piece[p]);
    tri(hi[q], lo[p], lo[q], piece[p]);
  }
  return { positions, owners, count: piece.reduce((n, p) => Math.max(n, p + 1), 0) };
}

// The terrain tile with shapes carved in, each region at its own depth below the terrain
// (0 for the plain ground), steep walls where regions of different depths meet, and the side
// walls and flat base under all of it, as one closed solid. The regions must together cover
// the selection without overlapping.
export function carvedTerrain(ctx: DrapeContext, regions: { polys: Poly[]; depth: number }[], baseDepth: number): { positions: number[]; baseY: number } {
  const positions: number[] = [];
  const tri = (a: number[], b: number[], c: number[]) => positions.push(...a, ...b, ...c);
  const welder = new Welder();
  const levels = regions.map(({ polys, depth }) => ({ surface: new Surface(drapeFaces(ctx, polys), welder), depth }));
  const at = levels.map(({ surface, depth }) => surface.points.map((p) => ctx.scene(p, -depth)));
  levels.forEach(({ surface }, l) => surface.faces.forEach(([a, b, c]) => tri(at[l][a], at[l][b], at[l][c])));

  // Every open edge of every region, by its two points' grid positions.
  type Edge = { level: number; p: number; q: number };
  const keyOf = (e: Edge, v: number) => Surface.key(levels[e.level].surface.points[v]);
  const open = new Map<string, Edge>();
  levels.forEach(({ surface }, level) => {
    for (const [p, q] of surface.openEdges()) {
      const e = { level, p, q };
      open.set(`${keyOf(e, p)}>${keyOf(e, q)}`, e);
    }
  });
  // All the points stacked at one grid position, top to bottom: a wall's vertical side
  // passes through each one between its top and bottom, so walls meet edge to edge.
  const stacks = new Map<string, number[][]>();
  levels.forEach(({ surface }, l) =>
    surface.points.forEach((p, v) => {
      const k = Surface.key(p);
      const stack = stacks.get(k) ?? [];
      if (!stack.some((q) => q[1] === at[l][v][1])) stack.push(at[l][v]);
      stacks.set(k, stack);
    }),
  );
  const between = (k: string, top: number, bottom: number) =>
    (stacks.get(k) ?? []).filter((p) => p[1] < top && p[1] > bottom).sort((a, b) => b[1] - a[1]);
  // A wall in a vertical plane from edge p→q (top) down to bp→bq, through the points
  // stacked at either end: the polygon tq, tp, (p's, going down), bp, bq, (q's, going up),
  // split along tq–bp.
  const wall = (kp: string, kq: string, tp: number[], tq: number[], bp: number[], bq: number[]) => {
    const down = [tp, ...between(kp, tp[1], bp[1]), bp];
    for (let i = 0; i < down.length - 1; i++) tri(tq, down[i], down[i + 1]);
    const up = [bq, ...between(kq, tq[1], bq[1]).reverse(), tq];
    for (let i = 0; i < up.length - 1; i++) tri(bp, up[i], up[i + 1]);
  };

  // An edge whose reverse belongs to a deeper region is a step down: the wall hangs from it to
  // that region's edge. Regions at the same depth just meet. Edges with no reverse are the rim.
  const rim: Edge[] = [];
  for (const [key, e] of open) {
    const [kp, kq] = key.split('>');
    const other = open.get(`${kq}>${kp}`);
    if (!other) {
      rim.push(e);
      continue;
    }
    const [hi, lo] = [levels[e.level].depth, levels[other.level].depth];
    if (hi >= lo) continue;
    // The other edge runs q→p.
    wall(kp, kq, at[e.level][e.p], at[e.level][e.q], at[other.level][other.q], at[other.level][other.p]);
  }

  let minY = Infinity;
  for (const pts of at) for (const p of pts) minY = Math.min(minY, p[1]);
  const baseY = minY - baseDepth;
  // Rim edges leaving each point. A point can have more than one (where a region just
  // touches the rim), so each edge is walked once.
  const next = new Map<string, Edge[]>();
  for (const e of rim) {
    const [tp, tq] = [at[e.level][e.p], at[e.level][e.q]];
    wall(keyOf(e, e.p), keyOf(e, e.q), tp, tq, [tp[0], baseY, tp[2]], [tq[0], baseY, tq[2]]);
    const list = next.get(keyOf(e, e.p)) ?? [];
    list.push(e);
    next.set(keyOf(e, e.p), list);
  }
  // The base: each rim loop at the base height, triangulated, facing down.
  const used = new Set<Edge>();
  for (const first of rim) {
    if (used.has(first)) continue;
    const loop: number[][] = [];
    for (let e: Edge | undefined = first; e && !used.has(e); ) {
      used.add(e);
      loop.push(at[e.level][e.p]);
      e = next.get(keyOf(e, e.q))?.find((n) => !used.has(n));
    }
    if (loop.length < 3) continue;
    const outline = loop.map((p) => new Vector2(p[0], p[2]));
    for (const [a, b, c] of ShapeUtils.triangulateShape(outline, [])) {
      const [pa, pb, pc] = [loop[a], loop[b], loop[c]].map((p) => [p[0], baseY, p[2]]);
      const ny = (pb[2] - pa[2]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[2] - pa[2]);
      tri(pa, ny < 0 ? pb : pc, ny < 0 ? pc : pb);
    }
  }
  return { positions, baseY };
}

