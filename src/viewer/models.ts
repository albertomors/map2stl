// 3D models standing in for buildings: a landmark's real shape instead of the OSM
// approximation, from the user's own file or an openly licensed one found online. Each is
// fitted to its building automatically: turned upright, its outline seen from above lined up
// with the building's footprint (the long sides together), scaled evenly to fit inside it,
// and standing on the lowest ground under it. The building's usual Size and Height edits
// still apply on top, and Turn and Up edits fix a wrong guess.

import { Color } from 'three';
import { editKey, type Edits } from '../edits';
import { modelAssets, type Axis, type ModelAsset, type ModelChoice } from '../model-assets';
import type { LocalFrame } from '../local';
import type { Building } from '../osm';
import { COLORS, type PickableMesh, type Placement } from './objects';
import { MeshBuilder, type Vec3 } from './mesh';
import { orientedBox } from './roofs';

type P = [number, number];

// The models replacing buildings, one solid per building, keyed like the buildings so they
// can be picked and edited the same way. `buildings` are the unedited ones: their footprints
// are what the models fit.
export function buildModels(buildings: Building[], edits: Edits, at: Placement, only?: string): PickableMesh | null {
  const m = new MeshBuilder();
  const keys: string[] = [];
  const parts = new Map<string, Building[]>();
  for (const b of buildings) {
    const key = editKey(b);
    if (only !== undefined && key !== only) continue;
    const choice = edits.get(key)?.model;
    if (!choice || edits.get(key)?.deleted || !modelAssets.has(choice.asset)) continue;
    parts.set(key, [...(parts.get(key) ?? []), b]);
  }
  for (const [key, bs] of parts) {
    const edit = edits.get(key)!;
    const placed = placeModel(modelAssets.get(edit.model!.asset)!, edit.model!, bs, at, edit.scale ?? 1, edit.heightScale ?? 1);
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

// The model's triangles in the scene, fitted to the building's parts, and the ground it
// stands on (scene height).
function placeModel(asset: ModelAsset, choice: ModelChoice, parts: Building[], at: Placement, size: number, height: number) {
  const f = fit(asset, choice, parts, at.frame);
  if (!f) return null;
  const { t, model, target, minY } = f;
  const s = f.scale * size;
  const turn = Math.atan2(target.longAxis[1], target.longAxis[0]) - Math.atan2(model.longAxis[1], model.longAxis[0]) + (choice.turns * Math.PI) / 2;
  const [cos, sin] = [Math.cos(turn), Math.sin(turn)];
  // Standing on the lowest ground under the building, like the building would.
  const ground = Math.min(...parts.flatMap((b) => b.outer.map((p) => at.elevation(p)))) * at.terrainScale;
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
export function fittedHeight(asset: ModelAsset, choice: ModelChoice, parts: Building[], frame: LocalFrame): number | null {
  const f = fit(asset, choice, parts, frame);
  return f && (f.maxY - f.minY) * f.scale;
}

// The model upright, its outline's fitted rectangle and the footprint's, and the even scale
// that puts the one inside the other.
function fit(asset: ModelAsset, choice: ModelChoice, parts: Building[], frame: LocalFrame) {
  const t = upright(asset.triangles, choice.up);
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
  const model = orientedBox(hull(plan));
  // The footprint: every part's outline, in local meters.
  const target = orientedBox(hull(parts.flatMap((b) => b.outer.map((p) => frame.toLocal(p)))));
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
