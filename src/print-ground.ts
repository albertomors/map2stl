// The flat map layers in the print, carved into the ground like a relief: squares, parks and
// sand flush with it, streets and water a step below (bridges rise above both). Each is carved one step deeper still and filled back with its own colored part, so
// a 3MF can print it in its own filament. A step is the thinnest detail: nothing smaller
// would print.
//
// Each spot belongs to one layer only, so multi-color prints get clean borders: water wins
// (a road crossing a river without a bridge is cut there), then streets, squares, sand, rock
// (steep ground, as the 3D view shades it) and parks. The 2D work (unions, cuts) is done by Clipper2, through manifold-3d's
// CrossSection: fast, and exact (integer coordinates inside), where float polygon clipping
// fails on near-degenerate city data.

import type { CrossSection as CS } from 'manifold-3d/manifold';
import type { Layer } from './area-data';
import type { LngLat } from './geo';
import type { LocalFrame } from './local';
import type { Wasm } from './merge';
import type { Line, OsmData, Polygon } from './osm';
import { lngLatPixel, pixelLngLat, type Terrain } from './terrain';
import { carvedTerrain, drapeContext, drapedSolids, type Poly, type Solids } from './viewer/drape';
import { terrainGrid, type Grid } from './viewer/terrain-mesh';

export interface GroundSolids {
  water: Solids;
  streets: Solids;
  squares: Solids;
  parks: Solids;
  sand: Solids;
  rock: Solids;
  // The terrain tile with all of them carved in; null when there's nothing to carve.
  terrain: { positions: number[]; baseY: number } | null;
}

// How deep each kind lies below the ground, in steps (its top), and how deep it's carved
// (its fill's bottom edge sits there, overlapping the terrain a step more). Water and streets
// are one step down alike: where a street meets water they're one groove in a one-color
// print (a 3MF tells them apart by color); bridges rise above both.
const DEPTH = { flush: 0, streets: 1, water: 1 };
// Ground this steep (as shown, with the terrain exaggeration) is rock: the middle of the 3D
// view's blend from ground to rock (relief.ts).
const ROCK_DEG = 37.5;
// Paths, tracks and steps print only at their real width, if that's wide enough: widened,
// a footpath network covers a city center in thick bands. Streets of any kind are widened
// when they're too narrow, so the street network stays connected.
const MINOR = /^(footway|path|cycleway|steps|bridleway|track|platform|corridor)$/;

type Pair = [number, number];

// Bends of widened lines get a rounded joint, like the map draws them; nearly straight ones
// don't need it (the notch left is far below printable), and every joint adds outline.
const ROUND_SIDES = 8;
const JOINT_MIN_TURN = (20 * Math.PI) / 180;
// Outlines are simplified to this fraction of the thinnest detail: invisible in print, and
// far fewer points (OSM ways have a node every few meters).
const SIMPLIFY = 0.1;
// Each layer is closed and opened by this fraction of the thinnest detail: gaps and slivers
// narrower than twice that (far too thin to print) go, and so do pieces touching only at a
// corner, which no solid can have (four walls would meet on one edge).
const TIDY = 0.2;
// Shapes are cut into tiles of this many grid cells a side before they're triangulated, so
// the triangles stay small: a road network is one polygon with a hole per block, and its
// triangles would otherwise reach across blocks and be cut at every cell they cross.
const TILE_CELLS = 8;

export function buildGroundSolids(
  wasm: Wasm,
  osm: OsmData,
  t: Terrain,
  ring: LngLat[],
  frame: LocalFrame,
  ground: (h: number) => number,
  show: (layer: Layer) => boolean,
  // Thinnest detail, in scene units: the step height and the narrowest line.
  stepUnits: number,
  baseDepth: number,
  // Hears how far along it is (0 to 1) and what it's doing.
  progress: (fraction: number, label: string) => void = () => {},
): GroundSolids {
  const { CrossSection } = wasm;
  const grid = terrainGrid(t);
  // Scene units per terrain meter (the exaggeration), to judge flatness in steps: a flat
  // cell's blended surface strays at most a quarter of its corner sum from the true one,
  // kept under a quarter step.
  const perMeter = Math.abs(ground(t.max) - ground(t.max - 1)) || 1;
  const ctx = drapeContext(t, grid, frame, ground, stepUnits / perMeter);
  // Meters per grid pixel (Web Mercator pixels are square, so one number does).
  const mid = [t.width / 2, t.height / 2];
  const [ax, az] = frame.toLocal(pixelLngLat(t, mid[0], mid[1]));
  const [bx, bz] = frame.toLocal(pixelLngLat(t, mid[0] + 1, mid[1]));
  const metersPerPx = Math.hypot(bx - ax, bz - az);
  const minWidthPx = stepUnits / metersPerPx;
  const px = (p: LngLat): Pair => lngLatPixel(t, p);
  // Everything made here is freed at the end: WebAssembly memory isn't garbage collected.
  const made: CS[] = [];
  const keep = (cs: CS) => (made.push(cs), cs);
  const selection = keep(new CrossSection([ring.map(px)], 'EvenOdd'));

  const areas = (list: Polygon[]): CS[] =>
    list.map((a) => keep(new CrossSection([a.outer.map(px), ...a.holes.map((h) => h.map(px))], 'EvenOdd')));
  // All strokes in one shape: each piece wound counterclockwise, so the Positive fill rule
  // is their union. Minor ways too narrow to print are left out rather than widened.
  const lines = (list: Line[]): CS[] => {
    const contours = list.flatMap((l) => {
      const width = l.width / metersPerPx;
      if (MINOR.test(l.kind) && width < minWidthPx) return [];
      return strokePolygons(l.path.map(px), Math.max(width, minWidthPx) / 2);
    });
    return contours.length ? [keep(new CrossSection(contours, 'Positive'))] : [];
  };
  // Union, cut to the selection, minus what's already taken; specks too small to print go.
  // Null for nothing (manifold-3d won't make an empty shape from no contours).
  let taken: CS | null = null;
  const claim = (parts: CS[]): CS | null => {
    if (!parts.length) return null;
    // Simplified before the cut, so a border shared with an earlier layer is exactly that
    // layer's: the two never overlap.
    const e = minWidthPx * TIDY;
    const tidy = keep(keep(keep(keep(CrossSection.union(parts)).offset(e, 'Miter')).offset(-2 * e, 'Miter')).offset(e, 'Miter'));
    let shape = keep(keep(CrossSection.intersection(tidy, selection)).simplify(minWidthPx * SIMPLIFY));
    if (taken) shape = keep(CrossSection.difference(shape, taken));
    const pieces = shape.decompose().map(keep).filter((p) => p.area() >= minWidthPx * minWidthPx);
    if (!pieces.length) return null;
    shape = keep(CrossSection.compose(pieces));
    taken = taken ? keep(CrossSection.union(taken, shape)) : shape;
    return shape;
  };

  const none = (): CS[] => [];
  progress(0, 'Tracing water, roads and parks');
  const water = claim(show('water') ? [...areas(osm.waterAreas), ...lines(osm.waterways)] : none());
  const roads = claim([...(show('roads') ? lines(osm.roads.filter((l) => !l.bridge)) : []), ...(show('railways') ? lines(osm.railways.filter((l) => !l.bridge)) : [])]);
  const paved = claim(show('paved') ? [...areas(osm.pavedAreas), ...lines(osm.pavedLines)] : none());
  const sand = claim(show('surfaces') ? areas(osm.surfaces) : none());
  const rock = claim(show('surfaces') ? steepGround(wasm, grid, (h) => ground(h), metersPerPx, keep) : none());
  const parks = claim(show('green') ? areas(osm.green) : none());
  const land = taken ? keep(CrossSection.difference(selection, taken)) : null;
  const tiles = (cs: CS | null) => (cs ? tiled(cs, grid, keep) : []);

  // Each kind's fill: from its depth down to a step below its carve, so it overlaps the
  // terrain under it instead of merely touching it.
  const step = stepUnits;
  const fill = (polys: Poly[], depth: number) => drapedSolids(ctx, polys, -depth * step, -(depth + 2) * step);
  progress(0.2, 'Laying the streets');
  const shapes = { water: tiles(water), streets: tiles(roads), squares: tiles(paved), sand: tiles(sand), rock: tiles(rock), parks: tiles(parks) };
  const streets = fill(shapes.streets, DEPTH.streets);
  progress(0.55, 'Laying squares, parks and sand');
  const squares = fill(shapes.squares, DEPTH.flush);
  const sandSolids = fill(shapes.sand, DEPTH.flush);
  const rockSolids = fill(shapes.rock, DEPTH.flush);
  const parkSolids = fill(shapes.parks, DEPTH.flush);
  const waterSolids = fill(shapes.water, DEPTH.water);
  progress(0.7, 'Carving the terrain');
  // Carved a step below each fill's top: the fill takes that step back.
  const terrain = land
    ? carvedTerrain(
        ctx,
        [
          { polys: tiles(land), depth: 0 },
          { polys: shapes.water, depth: (DEPTH.water + 1) * step },
          { polys: shapes.streets, depth: (DEPTH.streets + 1) * step },
          { polys: shapes.squares, depth: (DEPTH.flush + 1) * step },
          { polys: shapes.sand, depth: (DEPTH.flush + 1) * step },
          { polys: shapes.rock, depth: (DEPTH.flush + 1) * step },
          { polys: shapes.parks, depth: (DEPTH.flush + 1) * step },
        ],
        baseDepth,
      )
    : null;
  for (const cs of made) cs.delete();
  return { water: waterSolids, streets, squares, parks: parkSolids, sand: sandSolids, rock: rockSolids, terrain };
}

// The grid cells steeper than ROCK_DEG (in the scene, exaggeration included), as one shape:
// each row's runs of steep cells a rectangle, all of them united.
function steepGround(wasm: Wasm, grid: Grid, ground: (h: number) => number, metersPerPx: number, keep: (cs: CS) => CS): CS[] {
  const { cols, rows, colX, rowY, height } = grid;
  const limit = Math.tan((ROCK_DEG * Math.PI) / 180);
  const rects: Pair[][] = [];
  for (let r = 0; r < rows - 1; r++) {
    let start = -1;
    for (let c = 0; c <= cols - 1; c++) {
      let steep = false;
      if (c < cols - 1) {
        const [a, b, d, e] = [ground(height(c, r)), ground(height(c + 1, r)), ground(height(c, r + 1)), ground(height(c + 1, r + 1))];
        const w = (colX(c + 1) - colX(c)) * metersPerPx;
        const h = (rowY(r + 1) - rowY(r)) * metersPerPx;
        steep = w > 0 && h > 0 && Math.hypot((b - a + e - d) / (2 * w), (d - a + e - b) / (2 * h)) > limit;
      }
      if (steep && start < 0) start = c;
      if (!steep && start >= 0) {
        const [x0, x1, y0, y1] = [colX(start), colX(c), rowY(r), rowY(r + 1)];
        rects.push([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
        start = -1;
      }
    }
  }
  if (!rects.length) return [];
  // All wound the same way, so the Positive fill rule is their union.
  return [keep(new wasm.CrossSection(rects.map((q) => (signedArea(q) > 0 ? q : [...q].reverse())), 'Positive'))];
}

// The shape cut into tiles along grid lines (halving it again and again: each round cuts
// all of it once), as polygons with their holes.
function tiled(cs: CS, grid: Grid, keep: (cs: CS) => CS): Poly[] {
  const out: Poly[] = [];
  const size = TILE_CELLS * grid.step;
  const BIG = 1e7;
  const rect = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as Pair[];
  const split = (s: CS, x0: number, y0: number, x1: number, y1: number) => {
    if (s.isEmpty()) return;
    const nx = Math.round((x1 - x0) / size);
    const ny = Math.round((y1 - y0) / size);
    if (nx <= 1 && ny <= 1) {
      for (const piece of s.decompose().map(keep)) out.push(toPoly(piece.toPolygons()));
      return;
    }
    // Cut across the longer side, on a tile boundary (a grid line).
    if (nx >= ny) {
      const xm = x0 + Math.floor(nx / 2) * size;
      split(keep(s.intersect(rect(-BIG, -BIG, xm, BIG))), x0, y0, xm, y1);
      split(keep(s.intersect(rect(xm, -BIG, BIG, BIG))), xm, y0, x1, y1);
    } else {
      const ym = y0 + Math.floor(ny / 2) * size;
      split(keep(s.intersect(rect(-BIG, -BIG, BIG, ym))), x0, y0, x1, ym);
      split(keep(s.intersect(rect(-BIG, ym, BIG, BIG))), x0, ym, x1, y1);
    }
  };
  const tilesX = Math.ceil(grid.colX(grid.cols - 1) / size);
  const tilesY = Math.ceil(grid.rowY(grid.rows - 1) / size);
  split(cs, 0, 0, Math.max(1, tilesX) * size, Math.max(1, tilesY) * size);
  return out;
}

// One piece's contours: the counterclockwise one is the outline, the others its holes.
function toPoly(contours: Pair[][]): Poly {
  let outer: Pair[] = [];
  const holes: Pair[][] = [];
  for (const c of contours) {
    if (signedArea(c) > 0 && signedArea(c) > signedArea(outer)) {
      if (outer.length) holes.push(outer);
      outer = c;
    } else {
      holes.push(c);
    }
  }
  return { outer, holes };
}

// A line of the given half width as polygons, all counterclockwise: a rectangle per segment,
// and a round joint where it bends. Ends stay square: a road ending at a junction ends on the
// other road's middle line, well inside it.
function strokePolygons(path: Pair[], half: number): Pair[][] {
  const out: Pair[][] = [];
  for (let i = 1; i < path.length; i++) {
    const [x0, y0] = path[i - 1];
    const [x, y] = path[i];
    const len = Math.hypot(x - x0, y - y0);
    if (!len) continue;
    const nx = (-(y - y0) / len) * half;
    const ny = ((x - x0) / len) * half;
    const quad: Pair[] = [[x0 + nx, y0 + ny], [x + nx, y + ny], [x - nx, y - ny], [x0 - nx, y0 - ny]];
    out.push(signedArea(quad) > 0 ? quad : quad.reverse());
    if (i === path.length - 1) continue;
    const [x2, y2] = path[i + 1];
    const turn = Math.abs(Math.atan2((x - x0) * (y2 - y) - (y - y0) * (x2 - x), (x - x0) * (x2 - x) + (y - y0) * (y2 - y)));
    if (turn < JOINT_MIN_TURN) continue;
    const joint: Pair[] = [];
    for (let k = 0; k < ROUND_SIDES; k++) {
      const a = (k / ROUND_SIDES) * 2 * Math.PI;
      joint.push([x + half * Math.cos(a), y + half * Math.sin(a)]);
    }
    out.push(joint);
  }
  return out;
}

function signedArea(r: Pair[]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x0, y0] = r[i];
    const [x1, y1] = r[(i + 1) % r.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}
