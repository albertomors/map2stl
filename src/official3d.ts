// Official 3D building models, in place of OSM's blocks: where a country or city publishes
// its buildings as measured 3D models (real roof shapes and heights), a building, or all of
// them, can take its model instead. They come as 3D Tiles: a tree of tilesets down to tiles
// of a few dozen buildings each (b3dm: a table of the buildings, and a glTF mesh with each
// vertex's building number). The tiles over the area are walked down to and read. They
// carry real coordinates, so they go exactly in place: no fitting (models.ts). Each model goes
// to the OSM building holding most of it.

import { Matrix4, Mesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { pointInRing, type LngLat } from './geo';
import { LocalFrame } from './local';
import type { ModelAsset } from './model-assets';
import type { OfficialSource } from './official-sources';

// Buildings to find models for: footprints by edit key.
export type Footprints = Map<string, { outer: LngLat[]; holes: LngLat[][] }[]>;

// A model for each building it has one for, by edit key. `onProgress`: tiles read so far, of
// how many.
export async function fetchOfficialModels(
  source: OfficialSource,
  buildings: Footprints,
  // The selection: models reaching past it are left out (they'd stick out of the print).
  within: LngLat[],
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<Map<string, ModelAsset>> {
  // The area: every footprint's box.
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const parts of buildings.values()) {
    for (const { outer } of parts) {
      for (const [x, y] of outer) [w, e, s, n] = [Math.min(w, x), Math.max(e, x), Math.min(s, y), Math.max(n, y)];
    }
  }
  const tiles = await contentOver(source.tileset, [w, s, e, n], signal);
  onProgress(0, tiles.length);
  const loader = gltfLoader();
  // Each model's triangles as lon, lat, height (meters), by tile and model number.
  const models = new Map<string, number[]>();
  let done = 0;
  await Promise.all(
    tiles.map(async ({ url, transform }, tileIndex) => {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`${source.name} answered ${res.status}`);
      const tile = readB3dm(await res.arrayBuffer());
      const gltf = await loader.parseAsync(tile.glb, '');
      gltf.scene.updateMatrixWorld(true);
      // glTF is y-up; 3D Tiles are z-up, centered on RTC_CENTER, then the tile's transform.
      const toEarth = transform
        .clone()
        .multiply(new Matrix4().makeTranslation(...tile.center))
        .multiply(new Matrix4().makeRotationX(Math.PI / 2));
      const v = new Vector3();
      gltf.scene.traverse((o) => {
        if (!(o instanceof Mesh)) return;
        const g = o.geometry;
        const pos = g.getAttribute('position');
        const batch = g.getAttribute('_batchid');
        if (!pos || !batch) return;
        const m = toEarth.clone().multiply(o.matrixWorld);
        const index = g.getIndex();
        const count = index ? index.count : pos.count;
        for (let t = 0; t < count; t += 3) {
          const ids = [0, 1, 2].map((k) => (index ? index.getX(t + k) : t + k));
          const id = `${tileIndex}/${batch.getX(ids[0])}`;
          const list = models.get(id) ?? (models.set(id, []), models.get(id)!);
          for (const i of ids) {
            v.fromBufferAttribute(pos, i).applyMatrix4(m);
            list.push(...geodetic(v.x, v.y, v.z));
          }
        }
      });
      onProgress(++done, tiles.length);
    }),
  );

  // Each model goes to the building holding most of its points (sampled), if it lies wholly
  // inside the selection. Several models can go to one building (merged).
  const inside = (p: LngLat, parts: { outer: LngLat[]; holes: LngLat[][] }[]) =>
    parts.some(({ outer, holes }) => pointInRing(p, outer) && !holes.some((h) => pointInRing(p, h)));
  const boxes = [...buildings].map(([key, parts]) => ({ key, parts, box: boxOf(parts.flatMap((p) => p.outer)) }));
  const found = new Map<string, number[]>();
  const hulls: LngLat[][] = [];
  for (const tri of models.values()) {
    const points: LngLat[] = [];
    for (let i = 0; i < tri.length; i += 3) points.push([tri[i], tri[i + 1]]);
    if (!points.every((p) => pointInRing(p, within))) continue;
    const votes = new Map<string, number>();
    const step = Math.max(1, Math.floor(points.length / 60));
    for (let i = 0; i < points.length; i += step) {
      const p = points[i];
      const hit = boxes.find(({ parts, box: [bw, bs, be, bn] }) => p[0] >= bw && p[0] <= be && p[1] >= bs && p[1] <= bn && inside(p, parts));
      if (hit) votes.set(hit.key, (votes.get(hit.key) ?? 0) + 1);
    }
    const best = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!best) continue;
    const list = found.get(best) ?? (found.set(best, []), found.get(best)!);
    for (let i = 0; i < tri.length; i++) list.push(tri[i]);
    hulls.push(convexHull(points));
  }
  const out = new Map<string, ModelAsset>();
  for (const [key, tri] of found) out.set(key, toAsset(key, tri, buildings.get(key)!, source));
  // A building another's model covers (the two sources split blocks differently) gives way:
  // an empty model hides it, and Remove brings it back.
  for (const { key, parts } of boxes) {
    if (out.has(key)) continue;
    const pts = parts.flatMap((p) => p.outer);
    const center: LngLat = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
    if (hulls.some((h) => pointInRing(center, h))) out.set(key, toAsset(key, [], parts, source));
  }
  return out;
}

// A building's triangles (lon, lat, height) as a model placed at its footprint's center:
// local meters there (x east, y up, z south), its lowest point at 0.
function toAsset(key: string, tri: number[], parts: { outer: LngLat[] }[], source: OfficialSource): ModelAsset {
  const all = parts.flatMap((p) => p.outer);
  const anchor: LngLat = [all.reduce((a, p) => a + p[0], 0) / all.length, all.reduce((a, p) => a + p[1], 0) / all.length];
  const frame = new LocalFrame(anchor);
  const triangles = new Float32Array(tri.length);
  let minY = Infinity;
  for (let i = 0; i < tri.length; i += 3) {
    const [x, z] = frame.toLocal([tri[i], tri[i + 1]]);
    triangles.set([x, tri[i + 2], z], i);
    minY = Math.min(minY, tri[i + 2]);
  }
  for (let i = 1; i < triangles.length; i += 3) triangles[i] -= minY;
  return {
    id: `official/${source.name}/${key}`,
    triangles,
    up: 'y',
    anchor,
    source: { kind: 'official', title: source.name, url: source.url, license: source.license, author: source.author },
  };
}

function boxOf(points: LngLat[]): [number, number, number, number] {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) [w, e, s, n] = [Math.min(w, x), Math.max(e, x), Math.min(s, y), Math.max(n, y)];
  return [w, s, e, n];
}

// Convex hull (monotone chain), counterclockwise.
function convexHull(points: LngLat[]): LngLat[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: LngLat, a: LngLat, b: LngLat) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: LngLat[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: LngLat[] = [];
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// The content tiles (finest, b3dm) whose region overlaps a box, walking into external
// tilesets, with the transform each sits under.
async function contentOver(url: string, [w, s, e, n]: [number, number, number, number], signal: AbortSignal) {
  const box = [w, s, e, n].map((d) => (d * Math.PI) / 180);
  const out: { url: string; transform: Matrix4 }[] = [];
  interface Tile {
    boundingVolume: { region?: number[] };
    transform?: number[];
    content?: { uri?: string; url?: string };
    children?: Tile[];
  }
  const walk = async (tile: Tile, base: string, parent: Matrix4): Promise<void> => {
    const r = tile.boundingVolume.region;
    if (r && (r[2] < box[0] || r[0] > box[2] || r[3] < box[1] || r[1] > box[3])) return;
    const transform = tile.transform ? parent.clone().multiply(new Matrix4().fromArray(tile.transform)) : parent;
    const uri = tile.content?.uri ?? tile.content?.url;
    const jobs: Promise<void>[] = [];
    if (uri) {
      const full = new URL(uri, base).href;
      if (/\.json(\?|$)/.test(full)) jobs.push(tileset(full, signal).then((t) => walk(t.root, full, transform)));
      else if (/\.b3dm(\?|$)/.test(full)) out.push({ url: full, transform });
    }
    for (const child of tile.children ?? []) jobs.push(walk(child, base, transform));
    await Promise.all(jobs);
  };
  const root = await tileset(url, signal);
  await walk(root.root, url, new Matrix4());
  return out;
}

// Tilesets once each per page: the upper ones are shared by every area.
const tilesets = new Map<string, Promise<{ root: never }>>();
function tileset(url: string, signal: AbortSignal) {
  let p = tilesets.get(url);
  if (!p) {
    p = fetch(url, { signal }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`tileset answered ${r.status}`))));
    p.catch(() => tilesets.delete(url));
    tilesets.set(url, p);
  }
  return p;
}

// A b3dm tile: its glTF, and the RTC_CENTER its positions are relative to.
function readB3dm(data: ArrayBuffer): { glb: ArrayBuffer; center: [number, number, number] } {
  const view = new DataView(data);
  if (view.getUint32(0, true) !== 0x6d643362) throw new Error('not a b3dm tile');
  const [ftJson, ftBin, btJson, btBin] = [12, 16, 20, 24].map((o) => view.getUint32(o, true));
  const text = (from: number, length: number) => (length ? JSON.parse(new TextDecoder().decode(new Uint8Array(data, from, length))) : {});
  const ft = text(28, ftJson);
  return { glb: data.slice(28 + ftJson + ftBin + btJson + btBin), center: ft.RTC_CENTER ?? [0, 0, 0] };
}

// The glTF reader, with Draco (the tiles' meshes are compressed): its decoder is served from
// public/draco.
let loader: GLTFLoader | null = null;
function gltfLoader(): GLTFLoader {
  if (!loader) {
    const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
    loader = new GLTFLoader().setDRACOLoader(draco);
  }
  return loader;
}

// Earth-centered (WGS84) to longitude, latitude (degrees) and ellipsoidal height (meters).
function geodetic(x: number, y: number, z: number): [number, number, number] {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const b = a * (1 - f);
  const e2 = 1 - (b * b) / (a * a);
  const ep2 = (a * a) / (b * b) - 1;
  const p = Math.hypot(x, y);
  const th = Math.atan2(a * z, b * p);
  const lat = Math.atan2(z + ep2 * b * Math.sin(th) ** 3, p - e2 * a * Math.cos(th) ** 3);
  const lng = Math.atan2(y, x);
  const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  const h = p / Math.cos(lat) - N;
  return [(lng * 180) / Math.PI, (lat * 180) / Math.PI, h];
}
