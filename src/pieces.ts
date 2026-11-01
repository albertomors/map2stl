// Printing in pieces: a map bigger than the printer's bed is cut into an n × m grid of cells,
// printed one by one and put back together. The grid is centered on the selection and turned
// with it (the print's own axes), each cell an equal share of the shape's bounding box; a
// piece is the shape inside its cells (one, or more where a sliver was joined to a
// neighbor), and cells the shape doesn't reach are dropped. Along every cut the base gets
// joints, so the pieces line up. Plain geometry, in print millimeters (X right, Y up the
// bed), free of three.js and manifold: the page sizes the pieces with it, the print builds
// them (export.ts).
//
// Two kinds of joint. Tabs: one piece's tab slides into its neighbor's pocket; every tab
// points to the next column (right) or the next row (down), so r1c1 has only tabs, and the
// pieces go together diagonally from the top left. Keys: both pieces get half of a bowtie
// pocket, open at the bottom, and a bowtie key printed apart is pushed up into it once
// they're side by side: its wide ends hold them together, no glue needed.

import polygonClipping, { type Polygon as PcPolygon } from 'polygon-clipping';
import { pointInRing } from './geo';
import { LocalFrame } from './local';
import { describe, type Selection } from './selection';

export type Pt = [number, number];

export interface Grid {
  cols: number;
  rows: number;
}

// A sliver joined to a neighbor: [its column, its row, the neighbor's column, row].
export type Merge = [number, number, number, number];

export interface PieceSpec {
  grid: Grid;
  joints: 'tabs' | 'keys' | 'none';
  // How much wider a pocket is than its tab or key, all round (mm).
  clearance: number;
  merges?: Merge[];
}

export interface Piece {
  // Its cell's column from the left and row from the top (as named in the files: r1c1 top
  // left), and every cell it covers (more than its own where a sliver was joined to it).
  col: number;
  row: number;
  cells: Pt[];
  // The shape inside them (one or more polygons, holes after their outer ring).
  outline: Pt[][][];
  // Its footprint's size (mm), tabs included, and its share of a full cell.
  sizeMm: Pt;
  share: number;
}

// Below this share of a cell, a piece is a sliver: fiddly to print and to glue.
export const SLIVER = 0.15;

// The joints, in mm: a tab reaching this far past the cut, this wide at the cut and at its tip
// (tapered, so it finds its place), as tall as this share of the base; one per this much cut,
// up to this many, evenly spread; kept this far from where the cut leaves the shape.
export const JOINT = { length: 6, root: 10, tip: 7, height: 0.6, every: 40, most: 2, margin: 3 };
// A key: this narrow at the cut, this wide at its ends, reaching this far into each piece.
export const KEY = { waist: 5, end: 10, reach: 7 };

export interface Joint {
  // On the cut; the way from the first piece to the second: right (+x) or down (−y).
  at: Pt;
  dir: Pt;
  // The first piece (it has the tab) and the second (the pocket), as indexes into the pieces.
  tab: number;
  pocket: number;
}

// The selection's outline in print millimeters, as the print builds it (export.ts): its own
// "up" along +Y, centered on its bounding box, the longest side `sizeMm` long.
export function outlineMm(selection: Selection, sizeMm: number): Pt[] {
  const ring = describe(selection).ring;
  const frame = new LocalFrame(selection.center);
  const turn = (selection.rotation * Math.PI) / 180;
  const [cos, sin] = [Math.cos(turn), Math.sin(turn)];
  const plan = ring.map((p): Pt => {
    const [x, z] = frame.toLocal(p);
    return [x * cos + z * sin, x * sin - z * cos];
  });
  const [x0, y0, x1, y1] = boxOf(plan);
  const k = sizeMm / Math.max(x1 - x0, y1 - y0);
  return plan.map(([x, y]) => [(x - (x0 + x1) / 2) * k, (y - (y0 + y1) / 2) * k]);
}

// The grid's cells over the outline: [x0, y0, x1, y1] of the cell at column c, row r.
function cellsOf(outline: Pt[], grid: Grid) {
  const [x0, y0, x1, y1] = boxOf(outline);
  const [w, h] = [(x1 - x0) / grid.cols, (y1 - y0) / grid.rows];
  return { w, h, box: ([c, r]: Pt): [number, number, number, number] => [x0 + c * w, y1 - (r + 1) * h, x0 + (c + 1) * w, y1 - r * h] };
}

// Which piece each cell belongs to (by its own cell's "col,row"), the joins applied.
function owners(grid: Grid, merges: Merge[]): Map<string, string> {
  const owner = new Map<string, string>();
  for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) owner.set(`${c},${r}`, `${c},${r}`);
  for (const [c, r, tc, tr] of merges) {
    const into = owner.get(`${tc},${tr}`);
    const from = owner.get(`${c},${r}`);
    if (!into || !from || into === from) continue;
    // Everything that was the sliver's goes to the neighbor's piece.
    for (const [k, v] of owner) if (v === from) owner.set(k, into);
  }
  return owner;
}

// The pieces of a grid over the outline: those the shape reaches, row by row from the top.
// `tabs`: their size includes the tabs sticking out right and down.
export function piecesOf(outline: Pt[], grid: Grid, merges: Merge[] = [], tabs = true): Piece[] {
  const { w, h, box } = cellsOf(outline, grid);
  const owner = owners(grid, merges);
  const ring = (b: [number, number, number, number]): Pt[] => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]];
  const pieces: Piece[] = [];
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const key = `${col},${row}`;
      if (owner.get(key) !== key) continue;
      const cells = [...owner].filter(([, v]) => v === key).map(([k]) => k.split(',').map(Number) as Pt);
      const region = polygonClipping.union(...(cells.map((c) => [ring(box(c))]) as [PcPolygon, ...PcPolygon[]]));
      const inside = polygonClipping.intersection([outline] as PcPolygon, region) as Pt[][][];
      const area = inside.reduce((a, poly) => a + poly.reduce((b, r, i) => b + (i ? -1 : 1) * Math.abs(ringArea(r)), 0), 0);
      // A hair of the shape along a cell's edge isn't a piece.
      if (area < w * h * 0.001) continue;
      const [px0, py0, px1, py1] = boxOf(inside.flat(2));
      // Tabs stick out right and down where another piece's cell is there.
      const next = (dc: number, dr: number) => cells.some(([c, r]) => owner.has(`${c + dc},${r + dr}`) && owner.get(`${c + dc},${r + dr}`) !== key);
      const right = tabs && next(1, 0) ? JOINT.length : 0;
      const down = tabs && next(0, 1) ? JOINT.length : 0;
      pieces.push({ col, row, cells, outline: inside, sizeMm: [px1 - px0 + right, py1 - py0 + down], share: area / (w * h) });
    }
  }
  return pieces;
}

// Which piece holds a point (print mm), as an index into the pieces; −1 for none.
export function pieceAt(outline: Pt[], grid: Grid, pieces: Piece[]): (p: Pt) => number {
  const [x0, , , y1] = boxOf(outline);
  const { w, h } = cellsOf(outline, grid);
  const at = new Map<string, number>();
  pieces.forEach((p, i) => p.cells.forEach(([c, r]) => at.set(`${c},${r}`, i)));
  return ([x, y]) => at.get(`${Math.floor((x - x0) / w)},${Math.floor((y1 - y) / h)}`) ?? -1;
}

// Whether a piece fits the bed, either way round.
export function fits([w, h]: Pt, [bw, bh]: Pt): boolean {
  return (w <= bw && h <= bh) || (w <= bh && h <= bw);
}

// The fewest pieces that all fit the bed (squarer grids first among equals), up to 8 × 8.
export function proposeGrid(outline: Pt[], bed: Pt): Grid | null {
  const grids: Grid[] = [];
  for (let cols = 1; cols <= 8; cols++) for (let rows = 1; rows <= 8; rows++) grids.push({ cols, rows });
  grids.sort((a, b) => a.cols * a.rows - b.cols * b.rows || Math.abs(a.cols - a.rows) - Math.abs(b.cols - b.rows));
  return grids.find((g) => piecesOf(outline, g).every((p) => fits(p.sizeMm, bed))) ?? null;
}

// The neighbor a sliver is best joined to: the piece it shares the longest cut with, as long
// as the two together still fit the bed. Null if none does.
export function joinFor(outline: Pt[], grid: Grid, merges: Merge[], sliver: Piece, bed: Pt, tabs = true): Merge | null {
  const pieces = piecesOf(outline, grid, merges, tabs);
  const owner = owners(grid, merges);
  const { w, h } = cellsOf(outline, grid);
  const shared = new Map<string, number>();
  for (const [c, r] of sliver.cells) {
    for (const [dc, dr, len] of [[1, 0, h], [-1, 0, h], [0, 1, w], [0, -1, w]]) {
      const o = owner.get(`${c + dc},${r + dr}`);
      if (o && o !== `${sliver.col},${sliver.row}`) shared.set(o, (shared.get(o) ?? 0) + len);
    }
  }
  for (const [o] of [...shared].sort((a, b) => b[1] - a[1])) {
    const [tc, tr] = o.split(',').map(Number);
    if (!pieces.some((p) => p.col === tc && p.row === tr)) continue;
    const merge: Merge = [sliver.col, sliver.row, tc, tr];
    const joined = piecesOf(outline, grid, [...merges, merge], tabs).find((p) => p.col === tc && p.row === tr);
    if (joined && fits(joined.sizeMm, bed)) return merge;
  }
  return null;
}

// The joints along every cut between two pieces: on each stretch of cut inside the shape,
// one per JOINT.every mm, at least one and at most JOINT.most, evenly spread (two at a
// quarter and three quarters of the way); none where the stretch is too short, or where a
// pocket would reach past the shape's edge. Cells of one piece have no cut between them.
export function jointsOf(outline: Pt[], pieces: Piece[], grid: Grid, clearance: number, kind: 'tabs' | 'keys' = 'tabs'): Joint[] {
  const { box } = cellsOf(outline, grid);
  const pieceOf = new Map<string, number>();
  pieces.forEach((p, i) => p.cells.forEach(([c, r]) => pieceOf.set(`${c},${r}`, i)));
  const pockets = (j: Joint) => (kind === 'keys' ? keyFootprint(j, clearance) : pocketFootprint(j, clearance));
  const joints: Joint[] = [];
  // `along`: the cut is the line x = cut ('x') or y = cut ('y').
  const add = (tab: number | undefined, pocket: number | undefined, along: 'x' | 'y', dir: Pt, cut: number, from: number, to: number) => {
    if (tab === undefined || pocket === undefined || tab === pocket) return;
    for (const [a, b] of stretches(outline, along, cut, from, to)) {
      const length = b - a;
      if (length < JOINT.root + 2 * JOINT.margin) continue;
      const n = Math.min(JOINT.most, Math.max(1, Math.floor(length / JOINT.every)));
      for (let k = 0; k < n; k++) {
        const t = a + ((k + 0.5) * length) / n;
        const joint: Joint = { at: along === 'x' ? [cut, t] : [t, cut], dir, tab, pocket };
        if (pockets(joint).every((p) => pointInRing(p, outline))) joints.push(joint);
      }
    }
  };
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const b = box([c, r]);
      const here = pieceOf.get(`${c},${r}`);
      // Its right side: the first piece here, the second to the right.
      if (c < grid.cols - 1) add(here, pieceOf.get(`${c + 1},${r}`), 'x', [1, 0], b[2], b[1], b[3]);
      // Its bottom side: the first piece here, the second below.
      if (r < grid.rows - 1) add(here, pieceOf.get(`${c},${r + 1}`), 'y', [0, -1], b[1], b[0], b[2]);
    }
  }
  return joints;
}

// A tab's footprint: from 1 mm inside its own piece (so it joins it) to its tip, tapered.
export function tabFootprint(j: Joint): Pt[] {
  return footprint(j, [[-1, -JOINT.root / 2], [0, -JOINT.root / 2], [JOINT.length, -JOINT.tip / 2], [JOINT.length, JOINT.tip / 2], [0, JOINT.root / 2], [-1, JOINT.root / 2]]);
}

// Its pocket's: the tab grown by the clearance all round.
export function pocketFootprint(j: Joint, clearance: number): Pt[] {
  const [root, tip, length] = [JOINT.root + 2 * clearance, JOINT.tip + 2 * clearance, JOINT.length + clearance];
  return footprint(j, [[-1, -root / 2], [0, -root / 2], [length, -tip / 2], [length, tip / 2], [0, root / 2], [-1, root / 2]]);
}

// A bowtie key across the cut, narrow at it and wide at both ends, grown by `grow` all round
// (its pocket; 0 for the key itself).
export function keyFootprint(j: Joint, grow = 0): Pt[] {
  const [waist, end, reach] = [KEY.waist / 2 + grow, KEY.end / 2 + grow, KEY.reach + grow];
  return footprint(j, [[-reach, -end], [0, -waist], [reach, -end], [reach, end], [0, waist], [-reach, end]]);
}

// Counterclockwise, in print mm: `local` along the joint (u, the way it points) and across
// it (v), turned to its direction (a rotation, so it stays counterclockwise).
function footprint({ at: [x, y], dir: [dx, dy] }: Joint, local: Pt[]): Pt[] {
  return local.map(([u, v]) => [x + u * dx - v * dy, y + u * dy + v * dx]);
}

// The stretches of the line x = cut (or y = cut) inside the outline, between `from` and `to`
// along it.
function stretches(outline: Pt[], along: 'x' | 'y', cut: number, from: number, to: number): Pt[] {
  const [u, v] = along === 'x' ? [0, 1] : [1, 0];
  const hits: number[] = [];
  for (let i = 0; i + 1 < outline.length; i++) {
    const [a, b] = [outline[i], outline[i + 1]];
    if ((a[u] > cut) === (b[u] > cut)) continue;
    hits.push(a[v] + ((cut - a[u]) / (b[u] - a[u])) * (b[v] - a[v]));
  }
  hits.sort((a, b) => a - b);
  const out: Pt[] = [];
  for (let i = 0; i + 1 < hits.length; i += 2) {
    const [a, b] = [Math.max(hits[i], from), Math.min(hits[i + 1], to)];
    if (b > a) out.push([a, b]);
  }
  return out;
}

function boxOf(points: Pt[]): [number, number, number, number] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  return [x0, y0, x1, y1];
}

function ringArea(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i + 1 < ring.length; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return a / 2;
}
