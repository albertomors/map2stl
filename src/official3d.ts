// Official 3D building models, in place of OSM's blocks: where a country or city publishes
// its buildings as measured 3D models (real roof shapes and heights), a building, or all of
// them, can take its model instead. They come as 3D Tiles: a tree of tilesets down to tiles
// of a few dozen buildings each (b3dm or glb: a glTF mesh with each vertex's building
// number). The tiles over the area are walked down to and read. They carry real coordinates,
// so they go exactly in place: no fitting (models.ts). Each model goes to the OSM building
// holding most of it.
//
// A city center is hundreds of tiles and millions of triangles (3 × 3 km of Zurich: 524
// tiles, 10.6 million): read all at once, a page holds gigabytes and the browser gives up.
// So this runs in a worker (official-worker.ts), a few tiles at a time, nearest the middle
// first: each tile is turned straight into compact per-building triangles and let go, and
// the buildings found are handed over in batches, so the view fills in as it goes.

import { Matrix4, Mesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { pointInRing, type LngLat } from './geo';
import type { ModelAsset } from './model-assets';
import type { OfficialSource } from './official-sources';

// A building's footprint, in parts.
export type Footprint = { outer: LngLat[]; holes: LngLat[][] }[];

export interface OfficialJob {
  source: OfficialSource;
  // Buildings to find models for, by edit key.
  buildings: [string, Footprint][];
  // The selection: models reaching past it are left out (they'd stick out of the print).
  within: LngLat[];
}

export type OfficialMessage =
  | { type: 'progress'; done: number; total: number; triangles: number }
  // Buildings found since the last batch. A building can come again (its model spread over
  // two tiles): its triangles are added to what it has. Empty: the building lies under
  // another's model (the two sources split blocks differently), and gives way.
  | { type: 'models'; models: ModelAsset[] }
  // `failed`: tiles that couldn't be read (skipped).
  | { type: 'done'; triangles: number; failed: number }
  | { type: 'error'; message: string };

// Tiles read at once, and how often found buildings are handed over.
const PARALLEL = 3;
const BATCH_MS = 1500;
// Buildings indexed in squares this wide (meters), to find the one under a point.
const CELL_M = 50;
// Points of a model sampled to find its building.
const VOTES = 60;

export async function loadOfficialModels(job: OfficialJob, post: (m: OfficialMessage, transfer?: ArrayBuffer[]) => void): Promise<void> {
  const { source, buildings, within } = job;
  // Everything in meters on a plane touching the Earth at the area's middle (east, north,
  // up): across a few kilometers it's off by centimeters, and float32 keeps a millimeter.
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [, parts] of buildings) {
    for (const { outer } of parts) {
      for (const [x, y] of outer) [w, e, s, n] = [Math.min(w, x), Math.max(e, x), Math.min(s, y), Math.max(n, y)];
    }
  }
  if (!Number.isFinite(w)) return post({ type: 'done', triangles: 0, failed: 0 });
  const plane = tangentPlane([(w + e) / 2, (s + n) / 2]);
  const area = within.map(plane.toPlane);

  // The buildings on the plane, each with its anchor (the footprint's middle, where its
  // model is placed), and the grid of squares each one's box touches.
  const foot = buildings.map(([key, parts]) => {
    const rings = parts.map(({ outer, holes }) => ({ outer: outer.map(plane.toPlane), holes: holes.map((h) => h.map(plane.toPlane)) }));
    const all = parts.flatMap((p) => p.outer);
    const anchor: LngLat = [all.reduce((a, p) => a + p[0], 0) / all.length, all.reduce((a, p) => a + p[1], 0) / all.length];
    return { key, parts, rings, box: boxOf(rings.flatMap((r) => r.outer)), anchor, at: plane.toPlane(anchor) };
  });
  const grid = new Map<string, number[]>();
  const cells = ([x0, y0, x1, y1]: number[], each: (k: string) => void) => {
    for (let i = Math.floor(x0 / CELL_M); i <= Math.floor(x1 / CELL_M); i++) {
      for (let j = Math.floor(y0 / CELL_M); j <= Math.floor(y1 / CELL_M); j++) each(`${i},${j}`);
    }
  };
  foot.forEach((f, i) => cells(f.box, (k) => grid.set(k, [...(grid.get(k) ?? []), i])));
  const buildingAt = ([x, y]: LngLat) => {
    for (const i of grid.get(`${Math.floor(x / CELL_M)},${Math.floor(y / CELL_M)}`) ?? []) {
      const { rings, box } = foot[i];
      if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) continue;
      if (rings.some(({ outer, holes }) => pointInRing([x, y], outer) && !holes.some((h) => pointInRing([x, y], h)))) return i;
    }
    return -1;
  };

  const tiles = await contentOver(source.tileset, [w, s, e, n]);
  // Nearest the middle first: the view fills in from where one looks.
  const mid = [((w + e) / 2) * (Math.PI / 180), ((s + n) / 2) * (Math.PI / 180)];
  tiles.sort((a, b) => far(a.at, mid) - far(b.at, mid));
  const loader = gltfLoader();
  const toPlane = plane.matrix;

  // Found since the last batch: triangles per building, and the outlines of the models (a
  // building under one, without its own, gives way).
  const pending = new Map<number, Float32Array[]>();
  const outlines: LngLat[][] = [];
  const has = new Set<number>();
  const hidden = new Set<number>();
  let [done, triangles, next] = [0, 0, 0];
  let flushed = Date.now();

  const flush = () => {
    const models: ModelAsset[] = [];
    for (const [i, chunks] of pending) {
      const triangles = chunks.length === 1 ? chunks[0] : concat(chunks);
      models.push(asset(source, foot[i].key, foot[i].anchor, triangles));
    }
    pending.clear();
    for (const outline of outlines.splice(0)) {
      const box = boxOf(outline);
      cells(box, (k) => {
        for (const i of grid.get(k) ?? []) {
          if (has.has(i) || hidden.has(i) || !pointInRing(foot[i].at, outline)) continue;
          hidden.add(i);
          models.push(asset(source, foot[i].key, foot[i].anchor, new Float32Array(0)));
        }
      });
    }
    if (models.length) post({ type: 'models', models }, models.map((m) => m.triangles.buffer as ArrayBuffer));
    flushed = Date.now();
  };

  const read = async ({ url, transform }: Tile) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${source.name} answered ${res.status}`);
    const body = await res.arrayBuffer();
    // 3D Tiles 1.0 wrap the glTF in a b3dm; 1.1 (3DBAG) serve it as it is.
    const tile = isB3dm(body) ? readB3dm(body) : { glb: body, center: [0, 0, 0] as [number, number, number] };
    // From the tile's own folder: some keep part of their mesh in files beside it (Hong Kong).
    const gltf = await loader.parseAsync(withoutTextures(tile.glb), url.slice(0, url.lastIndexOf('/') + 1));
    gltf.scene.updateMatrixWorld(true);
    // glTF is y-up; 3D Tiles are z-up, centered on the tile's center, then the tile's
    // transform; then onto the plane.
    const toEarth = toPlane
      .clone()
      .multiply(transform)
      .multiply(new Matrix4().makeTranslation(...tile.center))
      .multiply(new Matrix4().makeRotationX(Math.PI / 2));

    // Each model's triangles (east, north, up), counted first, then written: no growing arrays.
    const meshes: { pos: Float32Array; get: (i: number) => number; batch: (i: number) => number; count: number }[] = [];
    const sizes = new Map<number, number>();
    gltf.scene.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const g = o.geometry;
      const pos = g.getAttribute('position');
      // Each vertex's building: the b3dm's batch id, or 1.1's feature id (EXT_mesh_features).
      const ids = g.getAttribute('_batchid') ?? g.getAttribute('_feature_id_0');
      if (!pos || !ids) return;
      const index = g.getIndex();
      const count = index ? index.count : pos.count;
      const get = index ? (i: number) => index.getX(i) : (i: number) => i;
      const v = new Vector3();
      const m = toEarth.clone().multiply(o.matrixWorld);
      // Positions on the plane, once per vertex (shared by its triangles).
      const placed = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        [placed[i * 3], placed[i * 3 + 1], placed[i * 3 + 2]] = [v.x, v.y, v.z];
      }
      meshes.push({ pos: placed, get, batch: (i) => ids.getX(i), count });
      for (let t = 0; t < count; t += 3) {
        const b = ids.getX(get(t));
        sizes.set(b, (sizes.get(b) ?? 0) + 9);
      }
      g.dispose();
    });
    const models = new Map<number, { t: Float32Array; at: number }>();
    for (const [b, size] of sizes) models.set(b, { t: new Float32Array(size), at: 0 });
    for (const { pos, get, batch, count } of meshes) {
      for (let t = 0; t < count; t += 3) {
        const model = models.get(batch(get(t)))!;
        for (let k = 0; k < 3; k++) {
          const i = get(t + k) * 3;
          model.t[model.at++] = pos[i];
          model.t[model.at++] = pos[i + 1];
          model.t[model.at++] = pos[i + 2];
        }
      }
    }

    for (const { t } of models.values()) {
      const points: LngLat[] = [];
      for (let i = 0; i < t.length; i += 3) points.push([t[i], t[i + 1]]);
      const outline = convexHull(points);
      // Wholly inside the selection: its outline is (exact for a rectangle, hexagon or circle;
      // near enough for a free shape with a dent).
      if (!outline.every((p) => pointInRing(p, area))) continue;
      const votes = new Map<number, number>();
      const step = Math.max(1, Math.floor(points.length / VOTES));
      for (let k = 0; k < points.length; k += step) {
        const i = buildingAt(points[k]);
        if (i >= 0) votes.set(i, (votes.get(i) ?? 0) + 1);
      }
      const best = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (best === undefined) continue;
      // Into the building's own frame: meters around its anchor (x east, y up, z south).
      const [ax, ay] = foot[best].at;
      for (let i = 0; i < t.length; i += 3) {
        const [east, north, up] = [t[i], t[i + 1], t[i + 2]];
        t[i] = east - ax;
        t[i + 1] = up;
        t[i + 2] = ay - north;
      }
      pending.set(best, [...(pending.get(best) ?? []), t]);
      has.add(best);
      outlines.push(outline);
      triangles += t.length / 9;
    }
  };

  // A few tiles at a time; each next tile goes to whichever reader is free. A tile that can't
  // be read is skipped: the rest of the area is still worth having.
  let failed = 0;
  let lastError: unknown;
  const reader = async () => {
    while (next < tiles.length) {
      await read(tiles[next++]).catch((err) => {
        failed++;
        lastError = err;
      });
      post({ type: 'progress', done: ++done, total: tiles.length, triangles });
      if (Date.now() - flushed > BATCH_MS) flush();
    }
  };
  post({ type: 'progress', done: 0, total: tiles.length, triangles: 0 });
  await Promise.all(Array.from({ length: PARALLEL }, reader));
  if (failed && failed === done) throw lastError;
  flush();
  post({ type: 'done', triangles, failed });
}

// A model for a building: its triangles in meters around its anchor.
function asset(source: OfficialSource, key: string, anchor: LngLat, triangles: Float32Array): ModelAsset {
  return {
    id: `official/${source.name}/${key}`,
    triangles,
    up: 'y',
    anchor,
    source: { kind: 'official', title: source.name, url: source.url, license: source.license, author: source.author },
  };
}

function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function boxOf(points: LngLat[]): [number, number, number, number] {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) [w, e, s, n] = [Math.min(w, x), Math.max(e, x), Math.min(s, y), Math.max(n, y)];
  return [w, s, e, n];
}

// How far a tile's middle (radians) is from a point, roughly; tiles with no region last.
function far(at: number[] | null, [x, y]: number[]): number {
  return at ? Math.hypot((at[0] - x) * Math.cos(y), at[1] - y) : Infinity;
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

interface Tile {
  url: string;
  transform: Matrix4;
  // The tile's middle (radians), from its bounding volume.
  at: number[] | null;
}

// The content tiles (b3dm, glb) whose region overlaps a box, walking into external tilesets,
// with the transform each sits under. Under "REPLACE" refinement (PLATEAU) a tile's children
// redraw it in more detail, so only the leaves are read; under "ADD" (swissBUILDINGS3D)
// every level holds buildings of its own.
async function contentOver(url: string, [w, s, e, n]: [number, number, number, number]): Promise<Tile[]> {
  const box = [w, s, e, n].map((d) => (d * Math.PI) / 180);
  const out: Tile[] = [];
  interface Node {
    boundingVolume: { region?: number[]; box?: number[] };
    transform?: number[];
    refine?: string;
    content?: { uri?: string; url?: string };
    children?: Node[];
  }
  const walk = async (tile: Node, base: string, parent: Matrix4, parentRefine: string): Promise<void> => {
    const transform = tile.transform ? parent.clone().multiply(new Matrix4().fromArray(tile.transform)) : parent;
    const { region, box: obb } = tile.boundingVolume;
    const r = region ?? (obb && regionOfBox(obb, transform));
    if (r && (r[2] < box[0] || r[0] > box[2] || r[3] < box[1] || r[1] > box[3])) return;
    const refine = (tile.refine ?? parentRefine).toUpperCase();
    const uri = tile.content?.uri ?? tile.content?.url;
    const jobs: Promise<void>[] = [];
    if (uri) {
      const full = new URL(uri, base).href;
      if (/\.json(\?|$)/.test(full)) jobs.push(tileset(full).then((t) => walk(t.root, full, transform, refine)));
      else if (/\.(b3dm|glb)(\?|$)/.test(full) && !(refine === 'REPLACE' && tile.children?.length)) {
        out.push({ url: full, transform, at: r ? [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2] : null });
      }
    }
    for (const child of tile.children ?? []) jobs.push(walk(child, base, transform, refine));
    await Promise.all(jobs);
  };
  const root = await tileset(url);
  await walk(root.root, url, new Matrix4(), 'ADD');
  return out;
}

// An oriented box (center and three half-axes, in the tile's frame: 3DBAG's are Earth-
// centered) as the region around it: [west, south, east, north] in radians.
function regionOfBox(b: number[], transform: Matrix4): number[] {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  const v = new Vector3();
  for (let k = 0; k < 8; k++) {
    const [i, j, l] = [k & 1 ? 1 : -1, k & 2 ? 1 : -1, k & 4 ? 1 : -1];
    v.set(b[0] + i * b[3] + j * b[6] + l * b[9], b[1] + i * b[4] + j * b[7] + l * b[10], b[2] + i * b[5] + j * b[8] + l * b[11]).applyMatrix4(transform);
    const [lng, lat] = geodetic(v.x, v.y, v.z);
    [w, e, s, n] = [Math.min(w, lng), Math.max(e, lng), Math.min(s, lat), Math.max(n, lat)];
  }
  return [w, s, e, n].map((d) => (d * Math.PI) / 180);
}

// Tilesets once each per worker: the upper ones are shared by every area.
const tilesets = new Map<string, Promise<{ root: never }>>();
function tileset(url: string) {
  let p = tilesets.get(url);
  if (!p) {
    p = fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`tileset answered ${r.status}`))));
    p.catch(() => tilesets.delete(url));
    tilesets.set(url, p);
  }
  return p;
}

// A b3dm tile: its glTF, and the center its positions are relative to: the feature table's
// RTC_CENTER, or the glTF's own CESIUM_RTC extension (PLATEAU).
const isB3dm = (data: ArrayBuffer) => new DataView(data).getUint32(0, true) === 0x6d643362;
function readB3dm(data: ArrayBuffer): { glb: ArrayBuffer; center: [number, number, number] } {
  const view = new DataView(data);
  const [ftJson, ftBin, btJson, btBin] = [12, 16, 20, 24].map((o) => view.getUint32(o, true));
  const text = (from: number, length: number) => (length ? JSON.parse(new TextDecoder().decode(new Uint8Array(data, from, length))) : {});
  const ft = text(28, ftJson);
  const start = 28 + ftJson + ftBin + btJson + btBin;
  // The glb's JSON chunk: its length at byte 12, the text from byte 20.
  const gltf = text(start + 20, view.getUint32(start + 12, true));
  return { glb: data.slice(start), center: ft.RTC_CENTER ?? gltf.extensions?.CESIUM_RTC?.center ?? [0, 0, 0] };
}

// The glb without its images: only the shapes are kept, and a textured tile (Luxembourg's)
// would decode megabytes of photos for nothing. Its JSON is rewritten without images,
// textures and the materials' references to them; the binary chunk stays as it is.
const TEXTURE_EXTENSIONS = /^(EXT_texture_webp|KHR_texture_basisu|KHR_texture_transform|EXT_texture_avif)$/;
function withoutTextures(glb: ArrayBuffer): ArrayBuffer {
  const view = new DataView(glb);
  const length = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, length)));
  if (!json.images?.length && !json.textures?.length) return glb;
  delete json.images;
  delete json.textures;
  delete json.samplers;
  for (const m of json.materials ?? []) {
    if (m.pbrMetallicRoughness) {
      delete m.pbrMetallicRoughness.baseColorTexture;
      delete m.pbrMetallicRoughness.metallicRoughnessTexture;
    }
    delete m.normalTexture;
    delete m.occlusionTexture;
    delete m.emissiveTexture;
  }
  for (const k of ['extensionsUsed', 'extensionsRequired']) {
    if (json[k]) json[k] = json[k].filter((x: string) => !TEXTURE_EXTENSIONS.test(x));
  }
  // The JSON chunk is padded with spaces to a multiple of 4 bytes.
  let text = JSON.stringify(json);
  text += ' '.repeat((4 - (new TextEncoder().encode(text).length % 4)) % 4);
  const bytes = new TextEncoder().encode(text);
  const rest = new Uint8Array(glb, 20 + length);
  const out = new Uint8Array(20 + bytes.length + rest.length);
  out.set(new Uint8Array(glb, 0, 12));
  const head = new DataView(out.buffer);
  head.setUint32(8, out.length, true);
  head.setUint32(12, bytes.length, true);
  head.setUint32(16, 0x4e4f534a, true);
  out.set(bytes, 20);
  out.set(rest, 20 + bytes.length);
  return out.buffer;
}

// The glTF reader, with Draco (swissBUILDINGS3D, PLATEAU) and meshopt (3DBAG): the tiles'
// meshes are compressed. three brings both decoders (Draco's bundled from
// three/examples/jsm/libs/draco).
let loader: GLTFLoader | null = null;
function gltfLoader(): GLTFLoader {
  if (!loader) loader = new GLTFLoader().setDRACOLoader(new DRACOLoader()).setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

// WGS84.
const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);

// Longitude, latitude (degrees) and ellipsoidal height to Earth-centered meters.
function ecef(lng: number, lat: number, h: number): [number, number, number] {
  const [l, p] = [(lng * Math.PI) / 180, (lat * Math.PI) / 180];
  const N = A / Math.sqrt(1 - E2 * Math.sin(p) ** 2);
  return [(N + h) * Math.cos(p) * Math.cos(l), (N + h) * Math.cos(p) * Math.sin(l), (N * (1 - E2) + h) * Math.sin(p)];
}

// The plane touching the Earth at a point: Earth-centered meters to (east, north, up) there,
// as a matrix, and a longitude/latitude to (east, north).
function tangentPlane([lng, lat]: LngLat) {
  const o = ecef(lng, lat, 0);
  const [l, p] = [(lng * Math.PI) / 180, (lat * Math.PI) / 180];
  const east = [-Math.sin(l), Math.cos(l), 0];
  const north = [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)];
  const up = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const matrix = new Matrix4().set(...(east as [number, number, number]), -dot(east, o), ...(north as [number, number, number]), -dot(north, o), ...(up as [number, number, number]), -dot(up, o), 0, 0, 0, 1);
  const toPlane = ([x, y]: LngLat): LngLat => {
    const q = ecef(x, y, 0);
    const d = [q[0] - o[0], q[1] - o[1], q[2] - o[2]];
    return [dot(east, d), dot(north, d)];
  };
  return { matrix, toPlane };
}

// Earth-centered (WGS84) to longitude, latitude (degrees) and ellipsoidal height (meters).
function geodetic(x: number, y: number, z: number): [number, number, number] {
  const b = A * (1 - F);
  const ep2 = (A * A) / (b * b) - 1;
  const p = Math.hypot(x, y);
  const th = Math.atan2(A * z, b * p);
  const lat = Math.atan2(z + ep2 * b * Math.sin(th) ** 3, p - E2 * A * Math.cos(th) ** 3);
  const lng = Math.atan2(y, x);
  const N = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  const h = p / Math.cos(lat) - N;
  return [(lng * 180) / Math.PI, (lat * 180) / Math.PI, h];
}
