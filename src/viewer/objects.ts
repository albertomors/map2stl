// Everything that stands on the ground: buildings with roofs, structures (bridge decks, piers,
// walls, towers), road and rail bridges, and trees. Each sits on the terrain below it.

import { Color, ConeGeometry, InstancedMesh, Matrix4, MeshLambertMaterial, ShapeUtils, Vector2, type BufferGeometry } from 'three';
import type { LngLat } from '../geo';
import type { LocalFrame } from '../local';
import type { Building, Line, OsmData, StructureArea, Tower } from '../osm';
import { MeshBuilder, tagColor, type Vec3 } from './mesh';
import { buildRoof, defaultRoofHeight } from './roofs';

export const COLORS = {
  wall: new Color('#e9dfd0'),
  roof: new Color('#b5634b'),
  flatRoof: new Color('#cfc6b8'),
  structure: new Color('#a89f94'),
  road: new Color('#5b606b'),
  rail: new Color('#6e5a8a'),
  tree: new Color('#3f8a3a'),
};

const BRIDGE_DECK_M = 1.2;
const BRIDGE_CLEARANCE_M = 1;
// Thin walls vanish on screen; the export will apply its own print minimums.
const MIN_WIDTH_M = 0.8;
const TREE_HEIGHT_M = 9;
const TREE_RADIUS_M = 3;

export interface Placement {
  frame: LocalFrame;
  // Terrain height in meters at a point.
  elevation: (p: LngLat) => number;
  terrainScale: number;
  heightScale: number;
}

type P = [number, number];

export function buildBuildings(buildings: Building[], at: Placement): BufferGeometry | null {
  const m = new MeshBuilder();
  for (const b of buildings) {
    const outer = ringToLocal(b.outer, at.frame);
    if (outer.length < 3) continue;
    const holes = b.holes.map((h) => ringToLocal(h, at.frame)).filter((h) => h.length >= 3);
    // On the lowest ground under the footprint, so no corner floats on a slope.
    const ground = Math.min(...b.outer.map((p) => at.elevation(p))) * at.terrainScale;
    const base = ground + b.minHeight * at.heightScale;
    const total = (b.height - b.minHeight) * at.heightScale;
    // Courtyard roofs would cover the courtyard: those stay flat.
    const shape = holes.length ? 'flat' : b.roofShape ?? 'flat';
    const rise = Math.min((b.roofHeight ?? defaultRoofHeight(shape, outer)) * at.heightScale, total * 0.7);
    const eave = base + total - rise;
    const wall = tagColor(b.colour, COLORS.wall);
    const roof = tagColor(b.roofColour, shape === 'flat' ? COLORS.flatRoof : COLORS.roof);

    walls(m, outer, base, eave, wall);
    for (const h of holes) walls(m, h, base, eave, wall, true);
    if (!buildRoof(m, outer, eave, rise, shape, roof, wall)) {
      flatCap(m, outer, holes, base + total, roof);
      // The rise was meant for a roof this footprint can't take: walls go all the way up.
      if (rise > 0) {
        walls(m, outer, eave, base + total, wall);
        for (const h of holes) walls(m, h, eave, base + total, wall, true);
      }
    }
  }
  return m.empty ? null : m.build();
}

export function buildStructures(osm: OsmData, at: Placement): BufferGeometry | null {
  const m = new MeshBuilder();
  const c = COLORS.structure;
  for (const s of osm.structureAreas) structureArea(m, s, at, c);
  for (const s of osm.structureLines) {
    const ground = Math.min(...s.path.map((p) => at.elevation(p))) * at.terrainScale;
    ribbon(m, s.path, at, Math.max(s.width, MIN_WIDTH_M), ground, ground + s.height * at.heightScale, c);
  }
  for (const t of osm.towers) tower(m, t, at, c);
  return m.empty ? null : m.build();
}

// Road or rail bridges: a deck level with the higher bank, above the river or road below.
export function buildBridges(lines: Line[], at: Placement, color: Color): BufferGeometry | null {
  const m = new MeshBuilder();
  for (const l of lines) {
    if (!l.bridge) continue;
    const [first, last] = l.ends ?? [l.path[0], l.path[l.path.length - 1]];
    const ends = [at.elevation(first), at.elevation(last)];
    const top = (Math.max(...ends) * at.terrainScale) + BRIDGE_CLEARANCE_M * at.heightScale;
    ribbon(m, l.path, at, l.width, top - BRIDGE_DECK_M * at.heightScale, top, color);
  }
  return m.empty ? null : m.build();
}

export function buildTrees(trees: LngLat[], at: Placement): InstancedMesh | null {
  if (!trees.length) return null;
  const h = TREE_HEIGHT_M * at.heightScale;
  const cone = new ConeGeometry(TREE_RADIUS_M, h, 7);
  const mesh = new InstancedMesh(cone, new MeshLambertMaterial({ color: COLORS.tree }), trees.length);
  const matrix = new Matrix4();
  trees.forEach((p, i) => {
    const [x, z] = at.frame.toLocal(p);
    mesh.setMatrixAt(i, matrix.makeTranslation(x, at.elevation(p) * at.terrainScale + h / 2, z));
  });
  mesh.castShadow = true;
  return mesh;
}

function structureArea(m: MeshBuilder, s: StructureArea, at: Placement, color: Color) {
  const outer = ringToLocal(s.outer, at.frame);
  if (outer.length < 3) return;
  const holes = s.holes.map((h) => ringToLocal(h, at.frame)).filter((h) => h.length >= 3);
  const heights = s.outer.map((p) => at.elevation(p));
  // Bridge decks span a dip: put them level with the higher bank. Everything else stands
  // on the low point.
  const ground = (s.kind === 'bridge' ? Math.max(...heights) : Math.min(...heights)) * at.terrainScale;
  const top = ground + s.height * at.heightScale + (s.kind === 'bridge' ? BRIDGE_CLEARANCE_M * at.heightScale : 0);
  const bottom = s.kind === 'bridge' ? top - BRIDGE_DECK_M * at.heightScale : ground;
  walls(m, outer, bottom, top, color);
  for (const h of holes) walls(m, h, bottom, top, color, true);
  flatCap(m, outer, holes, top, color);
  if (s.kind === 'bridge') flatCap(m, outer, holes, bottom, color, 'down');
}

function tower(m: MeshBuilder, t: Tower, at: Placement, color: Color) {
  const [x, z] = at.frame.toLocal(t.at);
  const ground = at.elevation(t.at) * at.terrainScale;
  const top = ground + t.height * at.heightScale;
  const r = t.kind === 'mast' ? 0.6 : t.kind === 'chimney' ? 1.5 : 3;
  const n = 10;
  const ring: P[] = Array.from({ length: n }, (_, i) => [x + r * Math.cos((2 * Math.PI * i) / n), z + r * Math.sin((2 * Math.PI * i) / n)]);
  walls(m, ring, ground, top, color);
  flatCap(m, ring, [], top, color);
}

// A path widened to `width` meters, as a solid from `bottom` to `top`.
function ribbon(m: MeshBuilder, path: LngLat[], at: Placement, width: number, bottom: number, top: number, color: Color) {
  const pts = path.map((p) => at.frame.toLocal(p));
  const half = width / 2;
  for (let i = 1; i < pts.length; i++) {
    const [x0, z0] = pts[i - 1];
    const [x1, z1] = pts[i];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 1e-3) continue;
    const nx = (-(z1 - z0) / len) * half;
    const nz = ((x1 - x0) / len) * half;
    const box: P[] = [[x0 + nx, z0 + nz], [x1 + nx, z1 + nz], [x1 - nx, z1 - nz], [x0 - nx, z0 - nz]];
    walls(m, box, bottom, top, color);
    flatCap(m, box, [], top, color);
  }
}

// Faces point away from the solid: outer rings go one way round, holes the other.
function walls(m: MeshBuilder, ring: P[], bottom: number, top: number, color: Color, hole = false) {
  if (top - bottom < 1e-3) return;
  // In plan (x east, z south) a negative signed area makes these quads face outward.
  if ((signedArea(ring) < 0) === hole) ring = [...ring].reverse();
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % ring.length];
    m.quad([x0, bottom, z0], [x1, bottom, z1], [x1, top, z1], [x0, top, z0], color);
  }
}

function flatCap(m: MeshBuilder, outer: P[], holes: P[][], y: number, color: Color, facing: 'up' | 'down' = 'up') {
  const v = (p: P) => new Vector2(p[0], p[1]);
  const contour = outer.map(v);
  const holeVs = holes.map((h) => h.map(v));
  const all: Vec3[] = [...outer, ...holes.flat()].map(([x, z]) => [x, y, z]);
  for (const [a, b, c] of ShapeUtils.triangulateShape(contour, holeVs)) m.tri(all[a], all[b], all[c], color, facing);
}

function signedArea(ring: P[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % ring.length];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

// Local plan coordinates without the closing duplicate.
function ringToLocal(ring: LngLat[], frame: LocalFrame): P[] {
  const pts = ring.map((p) => frame.toLocal(p));
  const [a, b] = [pts[0], pts[pts.length - 1]];
  if (pts.length > 1 && a[0] === b[0] && a[1] === b[1]) pts.pop();
  return pts;
}
