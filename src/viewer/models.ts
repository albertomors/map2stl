// 3D models standing in for buildings and bridges: a landmark's real shape instead of the
// OSM approximation, from the user's own file or an openly licensed one found online. Each
// is fitted to its object automatically: turned upright, its outline seen from above lined
// up with the object's footprint (the long sides together), scaled evenly to fit inside it,
// and standing on the lowest ground under it (for a bridge, the river bed). The usual Size
// and Height edits still apply on top, and Turn and Up edits fix a wrong guess.

import { Color } from 'three';
import { editKey, type Edits } from '../edits';
import { modelAssets, type Axis, type ModelAsset, type ModelChoice } from '../model-assets';
import type { LngLat } from '../geo';
import type { LocalFrame } from '../local';
import type { OsmData } from '../osm';
import { COLORS, type PickableMesh, type Placement } from './objects';
import { MeshBuilder, type Vec3 } from './mesh';
import { orientedBox } from './roofs';

type P = [number, number];

// What a model can stand in for, and its footprint: points on the map it must fit in.
export type ModelTarget = 'buildings' | 'bridges';

// The footprint of each object a model can replace, by its edit key: a building's parts
// (its tallest height known or not), a bridge deck's outline, a road or rail bridge's line
// widened to its width.
export function footprints(osm: OsmData, which: ModelTarget, only?: string): Map<string, { points: LngLat[]; height?: number; known?: boolean }> {
  const out = new Map<string, { points: LngLat[]; height?: number; known?: boolean }>();
  const add = (key: string, points: LngLat[], height?: number, known?: boolean) => {
    if (only !== undefined && key !== only) return;
    const f = out.get(key);
    if (!f) out.set(key, { points: [...points], height, known });
    else {
      f.points.push(...points);
      if (height !== undefined && height > (f.height ?? 0)) Object.assign(f, { height, known });
    }
  };
  if (which === 'buildings') {
    for (const b of osm.buildings) add(editKey(b), b.outer, b.height, b.heightFrom !== 'estimate');
  } else {
    for (const a of osm.structureAreas) if (a.kind === 'bridge') add(a.id, a.outer);
    for (const l of [...osm.roads, ...osm.railways]) if (l.bridge) add(l.id, widenedLine(l.path, l.width));
  }
  return out;
}

// A line's outline at its width: each point pushed out to both sides (the fit takes the
// hull, so this is enough).
function widenedLine(path: LngLat[], width: number): LngLat[] {
  const out: LngLat[] = [];
  // Degrees per meter, near enough over a bridge's length.
  const lat = path[0]?.[1] ?? 0;
  const kLat = 1 / 111320;
  const kLng = kLat / Math.cos((lat * Math.PI) / 180);
  for (let i = 0; i < path.length; i++) {
    const [a, b] = [path[Math.max(0, i - 1)], path[Math.min(path.length - 1, i + 1)]];
    const dx = (b[0] - a[0]) / kLng;
    const dy = (b[1] - a[1]) / kLat;
    const len = Math.hypot(dx, dy) || 1;
    const [nx, ny] = [(-dy / len) * (width / 2), (dx / len) * (width / 2)];
    out.push([path[i][0] + nx * kLng, path[i][1] + ny * kLat], [path[i][0] - nx * kLng, path[i][1] - ny * kLat]);
  }
  return out;
}

// The models replacing objects of one kind, one solid per object, keyed like the objects so
// they can be picked and edited the same way. `osm` is the unedited data: its footprints are
// what the models fit.
export function buildModels(osm: OsmData, edits: Edits, at: Placement, which: ModelTarget, only?: string): PickableMesh | null {
  const m = new MeshBuilder();
  const keys: string[] = [];
  for (const [key, foot] of footprints(osm, which, only)) {
    const edit = edits.get(key);
    const asset = edit?.model && modelAssets.get(edit.model.asset);
    if (!asset || edit.deleted) continue;
    const placed = placeModel(asset, edit.model!, foot.points, at, edit.scale ?? 1, edit.heightScale ?? 1);
    if (!placed) continue;
    m.owner = keys.push(key) - 1;
    m.ground = placed.ground;
    const t = placed.triangles;
    for (let i = 0; i < t.length; i += 9) {
      m.tri([t[i], t[i + 1], t[i + 2]], [t[i + 3], t[i + 4], t[i + 5]], [t[i + 6], t[i + 7], t[i + 8]], MODEL_COLOR);
    }
  }
  return m.empty ? null : { geometry: m.build(), owners: m.owners, keys };
}

export const MODEL_COLOR = new Color(COLORS.wall);

// The models for the 3D view, lighter than buildModels' (which the print and the selected
// object's highlight use): an official city is millions of triangles, and as plain triangles
// with a normal and a color at each corner, 5 km of Zurich (15 million) made a 1.8 GB mesh
// no graphics card held. Here each model's corners are stored once and its triangles point
// at them, with no normals (the GPU shades each face flat) and no colors (one for the mesh):
// about a sixth of the memory. Straight into typed arrays, in pieces of at most a million
// triangles: old graphics cards refuse one huge buffer even when the total would fit.
export interface LeanSolid {
  positions: Float32Array;
  grounds: Float32Array;
  index: Uint32Array;
  // Which object each triangle belongs to: keys[owners[triangle]].
  owners: Uint32Array;
  keys: string[];
}

const PIECE_TRIANGLES = 1_000_000;

export function buildModelSolids(osm: OsmData, edits: Edits, at: Placement, which: ModelTarget): LeanSolid[] {
  const out: LeanSolid[] = [];
  let piece = new LeanPiece();
  for (const [key, foot] of footprints(osm, which)) {
    const edit = edits.get(key);
    const asset = edit?.model && modelAssets.get(edit.model.asset);
    if (!asset || edit.deleted) continue;
    const placed = placeModel(asset, edit.model!, foot.points, at, edit.scale ?? 1, edit.heightScale ?? 1);
    if (!placed || !placed.triangles.length) continue;
    if (piece.triangles && piece.triangles + placed.triangles.length / 9 > PIECE_TRIANGLES) {
      out.push(piece.done());
      piece = new LeanPiece();
    }
    piece.add(key, placed.triangles, placed.ground);
  }
  if (piece.triangles) out.push(piece.done());
  return out;
}

// Growing typed arrays for one piece.
class LeanPiece {
  private positions = new Float32Array(3 << 14);
  private grounds = new Float32Array(1 << 14);
  private index = new Uint32Array(3 << 14);
  private owners = new Uint32Array(1 << 14);
  private keys: string[] = [];
  private vertices = 0;
  triangles = 0;

  // A model's triangles (9 floats each), each corner kept once: found again by its exact
  // position in a small hash table of the model's own corners.
  add(key: string, t: Float32Array, ground: number) {
    const owner = this.keys.push(key) - 1;
    const corners = t.length / 3;
    const bits = new Uint32Array(t.buffer, t.byteOffset, t.length);
    let size = 16;
    while (size < corners * 2) size <<= 1;
    const table = new Int32Array(size).fill(-1);
    this.grow(corners, corners / 3);
    for (let c = 0; c < corners; c++) {
      const [x, y, z] = [t[c * 3], t[c * 3 + 1], t[c * 3 + 2]];
      let h = (Math.imul(bits[c * 3], 73856093) ^ Math.imul(bits[c * 3 + 1], 19349663) ^ Math.imul(bits[c * 3 + 2], 83492791)) & (size - 1);
      let found = -1;
      for (let i = table[h]; i !== -1; h = (h + 1) & (size - 1), i = table[h]) {
        if (this.positions[i * 3] === x && this.positions[i * 3 + 1] === y && this.positions[i * 3 + 2] === z) {
          found = i;
          break;
        }
      }
      if (found === -1) {
        found = this.vertices++;
        this.positions.set([x, y, z], found * 3);
        this.grounds[found] = ground;
        table[h] = found;
      }
      this.index[this.triangles * 3 + (c % 3)] = found;
      if (c % 3 === 2) this.owners[this.triangles++] = owner;
    }
  }

  // Room for this many more corners and triangles.
  private grow(corners: number, triangles: number) {
    const fit = <T extends Float32Array | Uint32Array>(a: T, need: number): T => {
      if (need <= a.length) return a;
      let n = a.length;
      while (n < need) n *= 2;
      const b = new (a.constructor as new (n: number) => T)(n);
      b.set(a);
      return b;
    };
    this.positions = fit(this.positions, (this.vertices + corners) * 3);
    this.grounds = fit(this.grounds, this.vertices + corners);
    this.index = fit(this.index, (this.triangles + triangles) * 3);
    this.owners = fit(this.owners, this.triangles + triangles);
  }

  done(): LeanSolid {
    return {
      positions: this.positions.slice(0, this.vertices * 3),
      grounds: this.grounds.slice(0, this.vertices),
      index: this.index.slice(0, this.triangles * 3),
      owners: this.owners.slice(0, this.triangles),
      keys: this.keys,
    };
  }
}

// The model's triangles in the scene, fitted to the footprint, and the ground it stands on
// (scene height).
function placeModel(asset: ModelAsset, choice: ModelChoice, points: LngLat[], at: Placement, size: number, height: number) {
  const f = fit(asset, choice, points, at.frame);
  if (!f) return null;
  const { t, model, target, minY } = f;
  const s = f.scale * size;
  const turn = asset.anchor ? 0 : Math.atan2(target.longAxis[1], target.longAxis[0]) - Math.atan2(model.longAxis[1], model.longAxis[0]) + (choice.turns * Math.PI) / 2;
  const [cos, sin] = [Math.cos(turn), Math.sin(turn)];
  // Standing on the lowest ground under the building, like the building would.
  const ground = points.reduce((low, p) => Math.min(low, at.elevation(p)), Infinity) * at.terrainScale;
  const bottom = ground - (at.sink ?? 0);
  const vertical = s * at.heightScale * height;
  const out = new Float32Array(t.length);
  for (let i = 0; i < t.length; i += 3) {
    const x = (t[i] - model.center[0]) * s;
    const z = (t[i + 2] - model.center[1]) * s;
    out[i] = target.center[0] + x * cos - z * sin;
    out[i + 1] = (t[i + 1] - minY) * vertical + (t[i + 1] === minY ? bottom : ground);
    out[i + 2] = target.center[1] + x * sin + z * cos;
  }
  return { triangles: out, ground };
}

// How tall the model comes out (meters) once fitted to the building's footprint, before any
// Size or Height edit: far off the building's known height, the model likely shows more
// than the building (a whole square scanned around it) or only part of it.
export function fittedHeight(asset: ModelAsset, choice: ModelChoice, points: LngLat[], frame: LocalFrame): number | null {
  const f = fit(asset, choice, points, frame);
  return f && (f.maxY - f.minY) * f.scale;
}

// The model upright, its outline's fitted rectangle and the footprint's, and the even scale
// that puts the one inside the other.
function fit(asset: ModelAsset, choice: ModelChoice, points: LngLat[], frame: LocalFrame) {
  const t = asset.anchor ? asset.triangles : upright(asset.triangles, choice.up);
  // An official model kept by the objects' worker (objects-host.ts): here only its height
  // span, which is all that's asked of it outside the worker (how tall it stands).
  if (!t.length && asset.anchor && asset.span) {
    const box = { center: [0, 0] as P, longAxis: [1, 0] as P, halfL: 1, halfW: 1 };
    return { t, model: box, target: { ...box, center: frame.toLocal(asset.anchor) }, minY: asset.span[0], maxY: asset.span[1], scale: 1 };
  }
  if (!t.length) return null;
  // The model's outline seen from above, and how tall it is.
  let minY = Infinity;
  let maxY = -Infinity;
  const plan: P[] = [];
  const stride = Math.max(1, Math.floor(t.length / 3 / 20000));
  for (let i = 0; i < t.length; i += 3) {
    minY = Math.min(minY, t[i + 1]);
    maxY = Math.max(maxY, t[i + 1]);
    if ((i / 3) % stride === 0) plan.push([t[i], t[i + 2]]);
  }
  // An official model goes where its coordinates say, as it is.
  if (asset.anchor) {
    const at = frame.toLocal(asset.anchor);
    const box = { center: [0, 0] as P, longAxis: [1, 0] as P, halfL: 1, halfW: 1 };
    return { t, model: box, target: { ...box, center: at }, minY, maxY, scale: 1 };
  }
  const model = orientedBox(hull(plan));
  // The footprint, in local meters.
  const target = orientedBox(hull(points.map((p) => frame.toLocal(p))));
  if (!model.halfL || !target.halfL) return null;
  const scale = Math.min(target.halfL / model.halfL, target.halfW / (model.halfW || model.halfL));
  return { t, model, target, minY, maxY, scale };
}

// The file's triangles turned so `up` points up (+y), as rotations only, so faces keep
// their winding.
function upright(t: Float32Array, up: Axis): Float32Array {
  if (up === 'y') return t;
  const out = new Float32Array(t.length);
  for (let i = 0; i < t.length; i += 3) {
    const [x, y, z] = [t[i], t[i + 1], t[i + 2]];
    const v: Vec3 = up === 'z' ? [x, z, -y] : [-y, x, z];
    out.set(v, i);
  }
  return out;
}

// Convex hull (Andrew's monotone chain), counterclockwise.
function hull(points: P[]): P[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: P, a: P, b: P) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const out: P[] = [];
  for (const pass of [pts, [...pts].reverse()]) {
    const start = out.length;
    for (const p of pass) {
      while (out.length >= start + 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
  }
  return out;
}
