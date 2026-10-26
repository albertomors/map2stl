// Forests as one canopy: OSM maps a wood as an area, not tree by tree, so it's drawn as a
// mass of treetops over the whole wood, a single surface whatever its size (tens of
// thousands of trees would be too many to draw). The surface is crowns: pointed tips on a
// jittered grid, a little varied in size and height, dipping between them. Toward its edge
// it slopes down to the ground over about a tree, along a ragged line. On screen, single
// trees stand along the border, a few meters apart and thinning out toward the edge, with
// the canopy's slope hidden among them: the inside reads as a mass of trees, the edge as
// trees (they grow with the forest's outline, not its area, so they stay few). Roads,
// railways and water cut it open.
//
// It's a height field on a regular grid, its spacing a fraction of the crowns': the same
// number of points for a copse or a mountainside (bigger forests get bigger crowns, the way
// they'd look from farther away anyway). The forest is rasterized onto that grid (a canvas:
// it works in the print worker too), and each point's distance into it sets the edge slope.

import type { LngLat } from './geo';
import type { LocalFrame } from './local';
import type { Area, OsmData } from './osm';

// The green areas that are forest.
export const FOREST = /^(wood|forest)$/;
// Tree height (before the height multiplier), crowns at the closest, and the height between
// crowns, as a fraction of the trees'.
const TREE_M = 15;
const CROWN_SPACING_M = 5;
const BETWEEN = 0.15;
// Grid points per crown spacing (enough for a pointed tip; the print asks for more), and at
// most this many crowns across the selection's longest side (bigger areas get bigger
// crowns).
const POINTS_PER_CROWN = 3;
const MAX_CROWNS_ACROSS = 400;
// The edge slopes down over this many crown spacings, along a line this ragged (in crown
// spacings, either way, in lumps a few crowns long).
const EDGE_CROWNS = 1.2;
const RAGGED_CROWNS = 0.8;
// Single trees along the border (on screen): this far into the forest, this far apart
// (wider with bigger crowns), a third of those points used at the inner side of the band and
// fewer toward the edge, a little varied; the canopy rises from this far into the band,
// behind them.
const BORDER_M = 8;
const BORDER_SPACING_M = 3.5;
const BORDER_INNER_DENSITY = 1 / 3;
const BORDER_OUTER_DENSITY = 0.1;
const BORDER_HEIGHT_M = [11, 17];
const BORDER_SIZE = [0.7, 1.1];
const CANOPY_FROM = 0.5;
// With real heights (LiDAR): lower than this all around a point, it's a clearing, not forest.
const OPEN_M = 2;
// Roads and water cut the canopy this much wider than they are: a forest road is a clearing.
const CLEARANCE_M = 2;
// Outside the forest the surface tucks just under the ground, so its edge never floats.
const TUCK_M = 0.5;

// Woods that have their trees (`bare`: woods whose trees were deleted; the wood stays).
export function forestAreas(osm: OsmData, bare: (id: string) => boolean = () => false): Area[] {
  return osm.green.filter((a) => FOREST.test(a.kind) && !bare(a.id));
}

// The canopy as a height field: grid point (i, j) at scene (x0 + i·cell, z0 + j·cell),
// `above` the ground (scene units, multiplier applied; negative: tucked under), the ground
// at `ground`.
export interface Canopy {
  x0: number;
  z0: number;
  cell: number;
  cols: number;
  rows: number;
  // Meters between crowns: about a crown's width.
  spacing: number;
  above: Float32Array;
  ground: Float32Array;
  // The tallest a crown gets (for shading).
  top: number;
  // Single trees along the border (scene x, z; meters before the multiplier), when asked.
  border: { x: number; z: number; key: string; height: number; size: number }[];
}

export function buildCanopy(
  osm: OsmData,
  ring: LngLat[],
  frame: LocalFrame,
  // Scene ground height at a scene point.
  groundAt: (x: number, z: number) => number,
  {
    heightScale,
    pointsPerCrown = POINTS_PER_CROWN,
    bare = () => false,
    borderTrees = false,
    treeHeight,
  }: {
    heightScale: number;
    pointsPerCrown?: number;
    bare?: (id: string) => boolean;
    borderTrees?: boolean;
    // The trees' real height at a scene point (meters), where it's known (terrain.ts canopyAt).
    treeHeight?: (x: number, z: number) => number | undefined;
  },
): Canopy | null {
  const woods = forestAreas(osm, bare);
  if (!woods.length) return null;
  const local = (r: LngLat[]) => r.map((p) => frame.toLocal(p));
  const outline = local(ring);
  let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, z] of outline) {
    [minX, maxX, minZ, maxZ] = [Math.min(minX, x), Math.max(maxX, x), Math.min(minZ, z), Math.max(maxZ, z)];
  }
  const spacing = Math.max(CROWN_SPACING_M, Math.max(maxX - minX, maxZ - minZ) / MAX_CROWNS_ACROSS);
  const cell = spacing / pointsPerCrown;
  // A cell of margin all round: the field is tucked under at its border.
  const [x0, z0] = [minX - cell, minZ - cell];
  const cols = Math.ceil((maxX - minX) / cell) + 3;
  const rows = Math.ceil((maxZ - minZ) / cell) + 3;

  // The forest on the grid, one pixel per point: woods inside the selection, minus roads,
  // railways and water; and the selection alone (green), to keep the canopy inside it.
  const canvas = new OffscreenCanvas(cols, rows);
  // Read back once, on the CPU: a GPU canvas makes getImageData a slow round trip.
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.setTransform(1 / cell, 0, 0, 1 / cell, -x0 / cell + 0.5, -z0 / cell + 0.5);
  const path = (rings: [number, number][][]) => {
    ctx.beginPath();
    for (const r of rings) r.forEach(([x, z], k) => (k ? ctx.lineTo(x, z) : ctx.moveTo(x, z)));
  };
  path([outline]);
  ctx.fillStyle = '#0f0';
  ctx.fill();
  ctx.clip();
  ctx.fillStyle = '#fff';
  for (const a of woods) {
    path([a.outer, ...a.holes].map(local));
    ctx.fill('evenodd');
  }
  ctx.fillStyle = ctx.strokeStyle = '#0f0';
  ctx.lineCap = ctx.lineJoin = 'round';
  for (const a of osm.waterAreas) {
    path([a.outer, ...a.holes].map(local));
    ctx.fill('evenodd');
  }
  for (const l of [...osm.roads, ...osm.railways, ...osm.waterways]) {
    if (l.bridge) continue;
    path([local(l.path)]);
    ctx.lineWidth = l.width + 2 * CLEARANCE_M;
    ctx.stroke();
  }
  const pixels = ctx.getImageData(0, 0, cols, rows).data;

  // The tallest real height around a point (half a crown spacing each way), or undefined.
  const tallest = treeHeight
    ? (x: number, z: number) => {
        let h: number | undefined;
        for (const [dx, dz] of [[0, 0], [-0.5, 0], [0.5, 0], [0, -0.5], [0, 0.5]]) {
          const v = treeHeight(x + dx * spacing, z + dz * spacing);
          if (v !== undefined) h = Math.max(h ?? 0, v);
        }
        return h;
      }
    : undefined;
  // Each point's distance into the forest, and into the selection (scene meters; 0
  // outside). Clearings the real heights show (nothing as tall as a tree around) are outside
  // the forest: their edges slope and get border trees like the woods' outlines.
  const n = cols * rows;
  const clearing = (k: number) => {
    const h = tallest?.(x0 + (k % cols) * cell, z0 + Math.floor(k / cols) * cell);
    return h !== undefined && h < OPEN_M;
  };
  const dist = distances(cols, rows, cell, (k) => pixels[k * 4] > 127 && !clearing(k));
  const inside = distances(cols, rows, cell, (k) => pixels[k * 4 + 1] > 127);

  const scale = TREE_M * heightScale;
  // The edge's line wanders in and out by this (meters), in lumps a few crowns long.
  const ragged = (x: number, z: number) => RAGGED_CROWNS * spacing * valueNoise(x / (3 * spacing), z / (3 * spacing), 7);
  const band = BORDER_M * (spacing / CROWN_SPACING_M);
  const [gx0, gy0] = [Math.floor(x0 / spacing) - 1, Math.floor(z0 / spacing) - 1];
  // Crown heights as a fraction of TREE_M: the real one where known.
  const real = tallest && ((cx: number, cz: number) => {
    const h = tallest(cx * spacing, cz * spacing);
    return h === undefined ? undefined : h / TREE_M;
  });
  const crowns = crownField(x0 / spacing, z0 / spacing, 1 / pointsPerCrown, gx0, gy0, Math.ceil((cols * cell) / spacing) + 3, Math.ceil((rows * cell) / spacing) + 3, real);
  const above = new Float32Array(n);
  const ground = new Float32Array(n);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const [x, z] = [x0 + i * cell, z0 + j * cell];
      ground[k] = groundAt(x, z);
      // Down to the ground a cell and a half inside the selection's edge, so no cell with any
      // point above it reaches past the edge.
      if (!dist[k] || inside[k] < 1.5 * cell) {
        above[k] = -TUCK_M;
        continue;
      }
      const into = dist[k] + ragged(x, z) - (borderTrees ? CANOPY_FROM * band : 0);
      const edge = Math.min(1, Math.max(0, into / (EDGE_CROWNS * spacing)));
      above[k] = edge > 0 ? scale * edge * crowns(x / spacing, z / spacing) : -TUCK_M;
    }
  }

  // The border's trees: a jittered grid, kept where the point is in the band (by the same
  // ragged distance), more of them toward the inside.
  const border: Canopy['border'] = [];
  if (borderTrees) {
    const step = BORDER_SPACING_M * (spacing / CROWN_SPACING_M);
    for (let gx = Math.floor(minX / step); gx <= Math.ceil(maxX / step); gx++) {
      for (let gz = Math.floor(minZ / step); gz <= Math.ceil(maxZ / step); gz++) {
        const r = [hash(gx, gz, 11), hash(gx, gz, 12), hash(gx, gz, 13), hash(gx, gz, 14), hash(gx, gz, 15)];
        const x = (gx + 0.1 + 0.8 * r[0]) * step;
        const z = (gz + 0.1 + 0.8 * r[1]) * step;
        const k = Math.round((z - z0) / cell) * cols + Math.round((x - x0) / cell);
        if (k < 0 || k >= n || !dist[k] || inside[k] < 1.5 * cell) continue;
        const d = (dist[k] + ragged(x, z)) / band;
        if (d <= 0 || d >= 1 || r[2] > BORDER_OUTER_DENSITY + (BORDER_INNER_DENSITY - BORDER_OUTER_DENSITY) * d) continue;
        const measured = tallest?.(x, z);
        if (measured !== undefined && measured < OPEN_M) continue;
        border.push({
          x,
          z,
          key: `forest/${gx},${gz}`,
          height: measured ?? BORDER_HEIGHT_M[0] + (BORDER_HEIGHT_M[1] - BORDER_HEIGHT_M[0]) * r[3],
          size: BORDER_SIZE[0] + (BORDER_SIZE[1] - BORDER_SIZE[0]) * r[4],
        });
      }
    }
  }
  return { x0, z0, cell, cols, rows, spacing, above, ground, top: scale * 1.25, border };
}

// Distance from each grid point to the nearest point outside a mask (0 outside it): two
// chamfer passes.
function distances(cols: number, rows: number, cell: number, inMask: (k: number) => boolean): Float32Array {
  const dist = new Float32Array(cols * rows);
  for (let k = 0; k < dist.length; k++) dist[k] = inMask(k) ? 1e9 : 0;
  const diag = cell * Math.SQRT2;
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= cols || j >= rows ? 0 : dist[j * cols + i]);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (dist[k]) dist[k] = Math.min(dist[k], at(i - 1, j) + cell, at(i, j - 1) + cell, at(i - 1, j - 1) + diag, at(i + 1, j - 1) + diag);
    }
  }
  for (let j = rows - 1; j >= 0; j--) {
    for (let i = cols - 1; i >= 0; i--) {
      const k = j * cols + i;
      if (dist[k]) dist[k] = Math.min(dist[k], at(i + 1, j) + cell, at(i, j + 1) + cell, at(i + 1, j + 1) + diag, at(i - 1, j + 1) + diag);
    }
  }
  return dist;
}

// The canopy surface for the 3D view: indexed triangles over every cell with any point above
// the ground, and each position's ground height (for the height slider's stretch).
export function canopySurface(c: Canopy): { positions: Float32Array; grounds: Float32Array; index: Uint32Array } {
  const { cols, rows, above, ground } = c;
  const positions = new Float32Array(cols * rows * 3);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      positions[k * 3] = c.x0 + i * c.cell;
      positions[k * 3 + 1] = ground[k] + above[k];
      positions[k * 3 + 2] = c.z0 + j * c.cell;
    }
  }
  const index = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let n = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const [a, b, d, e] = [j * cols + i, j * cols + i + 1, (j + 1) * cols + i, (j + 1) * cols + i + 1];
      if (above[a] <= 0 && above[b] <= 0 && above[d] <= 0 && above[e] <= 0) continue;
      // Facing up (+y), with x east and z south.
      index[n++] = a, index[n++] = d, index[n++] = b, index[n++] = b, index[n++] = d, index[n++] = e;
    }
  }
  return { positions, grounds: ground, index: index.slice(0, n) };
}

// The canopy as a closed solid for the print: the surface on top, the same cells `sink`
// under the ground below, walls round the outline (where the surface is tucked under, so
// they're short). Triangles, 9 floats each.
export function canopySolid(c: Canopy, sink: number): number[] {
  const { cols, rows, above, ground } = c;
  const out: number[] = [];
  const top = (i: number, j: number) => [c.x0 + i * c.cell, ground[j * cols + i] + above[j * cols + i], c.z0 + j * c.cell];
  const bottom = (i: number, j: number) => [c.x0 + i * c.cell, ground[j * cols + i] - sink, c.z0 + j * c.cell];
  const used = (i: number, j: number) => {
    if (i < 0 || j < 0 || i >= cols - 1 || j >= rows - 1) return false;
    const k = j * cols + i;
    return above[k] > 0 || above[k + 1] > 0 || above[k + cols] > 0 || above[k + cols + 1] > 0;
  };
  const tri = (a: number[], b: number[], d: number[]) => {
    for (const p of [a, b, d]) out.push(p[0], p[1], p[2]);
  };
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      if (!used(i, j)) continue;
      tri(top(i, j), top(i, j + 1), top(i + 1, j));
      tri(top(i + 1, j), top(i, j + 1), top(i + 1, j + 1));
      tri(bottom(i, j), bottom(i + 1, j), bottom(i, j + 1));
      tri(bottom(i + 1, j), bottom(i + 1, j + 1), bottom(i, j + 1));
      // A wall on each side with no cell beyond it, facing out.
      const wall = (p: [number, number], q: [number, number]) => {
        tri(top(...p), bottom(...p), top(...q));
        tri(top(...q), bottom(...p), bottom(...q));
      };
      if (!used(i, j - 1)) wall([i + 1, j], [i, j]);
      if (!used(i + 1, j)) wall([i + 1, j + 1], [i + 1, j]);
      if (!used(i, j + 1)) wall([i, j + 1], [i + 1, j + 1]);
      if (!used(i - 1, j)) wall([i, j], [i, j + 1]);
    }
  }
  return out;
}

// Height of the crowns at a point (in crown spacings), as a fraction of the trees': the
// tallest of the nearby crowns there, each a cone on a jittered grid, never below the level
// between them. Shaped like the single trees' cones (as narrow, as steep), each tip on a
// grid point (`ox`, `oy`, every `step`), so the surface has the peak, not a blunt top
// between points. Each crown is worked out once, for the grid cells from (gx0, gy0), `nx`
// by `ny` of them (about nine points share each). `real`: a crown's measured height at its
// tip (as a fraction), where known.
function crownField(
  ox: number,
  oy: number,
  step: number,
  gx0: number,
  gy0: number,
  nx: number,
  ny: number,
  real?: (x: number, y: number) => number | undefined,
): (x: number, y: number) => number {
  const n = nx * ny;
  const [cxs, cys, radii, heights] = [new Float64Array(n), new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const snap = (v: number, o: number) => o + Math.round((v - o) / step) * step;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const [cx, cy, k] = [gx0 + i, gy0 + j, j * nx + i];
      cxs[k] = snap(cx + 0.15 + 0.7 * hash(cx, cy, 1), ox);
      cys[k] = snap(cy + 0.15 + 0.7 * hash(cx, cy, 2), oy);
      radii[k] = 0.45 + 0.2 * hash(cx, cy, 3);
      const measured = real?.(cxs[k], cys[k]);
      heights[k] = measured === undefined ? 0.75 + 0.4 * hash(cx, cy, 4) : Math.max(BETWEEN, measured);
    }
  }
  return (x, y) => {
    const [gx, gy] = [Math.floor(x) - gx0, Math.floor(y) - gy0];
    let h = BETWEEN;
    for (let j = Math.max(0, gy - 1); j <= Math.min(ny - 1, gy + 1); j++) {
      for (let i = Math.max(0, gx - 1); i <= Math.min(nx - 1, gx + 1); i++) {
        const k = j * nx + i;
        const [dx, dy, r] = [x - cxs[k], y - cys[k], radii[k]];
        const d2 = dx * dx + dy * dy;
        if (d2 < r * r) h = Math.max(h, BETWEEN + (heights[k] - BETWEEN) * (1 - Math.sqrt(d2) / r));
      }
    }
    return h;
  };
}

// Smooth noise between -1 and 1, about one unit per lump, the same every time for the place.
function valueNoise(x: number, y: number, k: number): number {
  const [x0, y0] = [Math.floor(x), Math.floor(y)];
  const s = (v: number) => v * v * (3 - 2 * v);
  const [u, v] = [s(x - x0), s(y - y0)];
  const h = (i: number, j: number) => hash(x0 + i, y0 + j, k) * 2 - 1;
  return (h(0, 0) * (1 - u) + h(1, 0) * u) * (1 - v) + (h(0, 1) * (1 - u) + h(1, 1) * u) * v;
}

// A number in [0, 1) from integers, the same every time.
function hash(x: number, y: number, k: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(k, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
