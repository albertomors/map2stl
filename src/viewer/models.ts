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

const MODEL_COLOR = new Color(COLORS.wall);

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
