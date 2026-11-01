// Printing in pieces: a map bigger than the printer's bed is cut into an n × m grid of pieces,
// printed one by one and put back together. The grid is centered on the selection and turned
// with it (the print's own axes), each cell an equal share of the shape's bounding box; a
// piece is the shape inside a cell, and cells the shape doesn't reach are dropped. Along every
// cut the base gets joints: tabs on one side, matching pockets on the other, so the pieces
// line up. Plain geometry, in print millimeters (X right, Y up the bed), free of three.js and
// manifold: the page sizes the pieces with it, the print worker cuts them.

import polygonClipping, { type Polygon as PcPolygon } from 'polygon-clipping';
import { pointInRing } from './geo';
import { LocalFrame } from './local';
import { describe, type Selection } from './selection';

export type Pt = [number, number];

export interface Grid {
  cols: number;
  rows: number;
}

export interface Piece {
  // Column from the left, row from the top (as named in the files: r1c1 top left).
  col: number;
  row: number;
  // The cell: [x0, y0, x1, y1].
  cell: [number, number, number, number];
  // The shape inside it (one or more polygons, holes after their outer ring).
  outline: Pt[][][];
  // Its footprint's size (mm), tabs included, and its share of a full cell.
  sizeMm: Pt;
  share: number;
}

// Below this share of a cell, a piece is a sliver: fiddly to print and to glue.
export const SLIVER = 0.15;

// The joints, in mm: a tab reaching this far past the cut, this wide at the cut and at its tip
// (tapered, so it finds its place), as tall as this share of the base, one per this much cut,
// and kept this far from where the cut leaves the shape.
export const JOINT = { length: 6, root: 10, tip: 7, height: 0.6, every: 40, margin: 3 };

export interface Joint {
  // The tab's root, in the middle of the cut, and the way it points (+x or +y).
  at: Pt;
  along: 'x' | 'y';
  // The piece that has the tab, and the one with the pocket (indexes into the pieces).
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

// The pieces of a grid over the outline: those the shape reaches, row by row from the top.
export function piecesOf(outline: Pt[], grid: Grid): Piece[] {
  const [x0, y0, x1, y1] = boxOf(outline);
  const [w, h] = [(x1 - x0) / grid.cols, (y1 - y0) / grid.rows];
  const pieces: Piece[] = [];
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const cell: Piece['cell'] = [x0 + col * w, y1 - (row + 1) * h, x0 + (col + 1) * w, y1 - row * h];
      const box: Pt[] = [[cell[0], cell[1]], [cell[2], cell[1]], [cell[2], cell[3]], [cell[0], cell[3]], [cell[0], cell[1]]];
      const inside = polygonClipping.intersection([outline] as PcPolygon, [box] as PcPolygon) as Pt[][][];
      const area = inside.reduce((a, poly) => a + poly.reduce((b, ring, i) => b + (i ? -1 : 1) * Math.abs(ringArea(ring)), 0), 0);
      // A hair of the shape along a cell's edge isn't a piece.
      if (area < w * h * 0.001) continue;
      const [px0, py0, px1, py1] = boxOf(inside.flat(2));
      // Tabs stick out toward +x and +y where there's a neighbor there.
      const right = col < grid.cols - 1 ? JOINT.length : 0;
      const up = row > 0 ? JOINT.length : 0;
      pieces.push({ col, row, cell, outline: inside, sizeMm: [px1 - px0 + right, py1 - py0 + up], share: area / (w * h) });
    }
  }
  return pieces;
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

// The joints along every cut between two pieces: on each stretch of cut inside the shape,
// one tab per JOINT.every mm (at least one), evenly spread; none where the stretch is too
// short, or where the pocket would reach past the shape's edge.
export function jointsOf(outline: Pt[], pieces: Piece[], grid: Grid, clearance: number): Joint[] {
  const index = new Map(pieces.map((p, i) => [`${p.col},${p.row}`, i]));
  const joints: Joint[] = [];
  const add = (tab: number | undefined, pocket: number | undefined, along: 'x' | 'y', cut: number, from: number, to: number) => {
    if (tab === undefined || pocket === undefined) return;
    for (const [a, b] of stretches(outline, along, cut, from, to)) {
      const length = b - a;
      if (length < JOINT.root + 2 * JOINT.margin) continue;
      const n = Math.max(1, Math.floor(length / JOINT.every));
      for (let k = 0; k < n; k++) {
        const t = a + ((k + 0.5) * length) / n;
        const at: Pt = along === 'x' ? [cut, t] : [t, cut];
        if (pocketFootprint({ at, along, tab, pocket }, clearance).every((p) => pointInRing(p, outline))) joints.push({ at, along, tab, pocket });
      }
    }
  };
  for (const p of pieces) {
    const i = index.get(`${p.col},${p.row}`);
    // Its right side: tab here, pocket in the piece to the right.
    if (p.col < grid.cols - 1) add(i, index.get(`${p.col + 1},${p.row}`), 'x', p.cell[2], p.cell[1], p.cell[3]);
    // Its top side: tab here, pocket in the piece above.
    if (p.row > 0) add(i, index.get(`${p.col},${p.row - 1}`), 'y', p.cell[3], p.cell[0], p.cell[2]);
  }
  return joints;
}

// A tab's footprint: from 1 mm inside its own piece (so it joins it) to its tip, tapered.
export function tabFootprint(j: Joint): Pt[] {
  return footprint(j, JOINT.root, JOINT.tip, JOINT.length);
}

// Its pocket's: the tab grown by the clearance all round.
export function pocketFootprint(j: Joint, clearance: number): Pt[] {
  return footprint(j, JOINT.root + 2 * clearance, JOINT.tip + 2 * clearance, JOINT.length + clearance);
}

// Counterclockwise, in print mm.
function footprint({ at: [x, y], along }: Joint, root: number, tip: number, length: number): Pt[] {
  // Across and along the tab, then turned to its axis.
  const local: Pt[] = [[-1, -root / 2], [0, -root / 2], [length, -tip / 2], [length, tip / 2], [0, root / 2], [-1, root / 2]];
  return along === 'x' ? local.map(([u, v]) => [x + u, y + v]) : local.map(([u, v]) => [x - v, y + u]);
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
