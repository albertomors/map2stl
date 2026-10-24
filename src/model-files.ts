// Reads a 3D model file into plain triangles for viewer/models.ts: STL, OBJ, and glTF (a
// .glb, a .gltf with its data inside, or a zip with a .gltf and its files, as Sketchfab
// sends). Every mesh in the file is taken, with its place in the file's scene applied.
// Textures are skipped (a print has no use for them), and huge scans are simplified to what
// a print can hold.

import { BufferGeometry, LoadingManager, Mesh, type Object3D } from 'three';
import type { Axis, ModelAsset, ModelSource } from './model-assets';

export async function readModel(data: ArrayBuffer, name: string, source: ModelSource): Promise<ModelAsset> {
  const ext = name.toLowerCase().split('.').pop();
  let triangles: Float32Array;
  let up: Axis;
  if (ext === 'stl') {
    const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
    triangles = flatten(new STLLoader().parse(data));
    up = 'z';
  } else if (ext === 'obj') {
    const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
    triangles = collect(new OBJLoader().parse(new TextDecoder().decode(data)));
    up = 'y';
  } else if (ext === 'glb' || ext === 'gltf') {
    triangles = await readGltf(data);
    up = 'y';
  } else if (ext === 'zip') {
    triangles = await readZippedGltf(data);
    up = 'y';
  } else {
    throw new Error(`.${ext} files aren't supported: use STL, OBJ, GLB or glTF.`);
  }
  if (!triangles.length) throw new Error('the file has no triangles.');
  return { id: crypto.randomUUID(), triangles: simplify(triangles, MAX_TRIANGLES), up, source };
}

// Images (embedded ones come to the loader as blob: or data: URLs, a zip's as paths) are
// replaced by a blank pixel: a print has no use for them, and decoding a scan's 8K texture
// takes seconds. `files`: a zip's other files, served from memory.
async function readGltf(data: ArrayBuffer | string, files: Record<string, Uint8Array> = {}, dir = ''): Promise<Float32Array> {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const urls = new Map<string, string>();
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('blob:') || url.startsWith('data:image/')) return BLANK_PIXEL;
    const path = decodeURIComponent(url).replace(/^\.\//, '');
    if (/\.(png|jpe?g|webp|ktx2|basis)$/i.test(path)) return BLANK_PIXEL;
    const file = files[dir + path] ?? files[path];
    if (!file) return url;
    if (!urls.has(path)) urls.set(path, URL.createObjectURL(new Blob([file as BlobPart])));
    return urls.get(path)!;
  });
  try {
    const gltf = await new GLTFLoader(manager).parseAsync(data, '');
    return collect(gltf.scene);
  } catch (err) {
    // Separate .bin or texture files can't come along with a single file.
    throw new Error(`couldn't read the glTF (${(err as Error).message}). Use a .glb, or a .gltf with its data inside.`);
  } finally {
    for (const u of urls.values()) URL.revokeObjectURL(u);
  }
}

// A zip holding a .gltf and the files it points to (or a .glb).
async function readZippedGltf(data: ArrayBuffer): Promise<Float32Array> {
  const { unzipSync, strFromU8 } = await import('fflate');
  const files = unzipSync(new Uint8Array(data));
  const names = Object.keys(files);
  const main = names.find((n) => /\.glb$/i.test(n)) ?? names.find((n) => /\.gltf$/i.test(n));
  if (!main) throw new Error('the zip has no glTF in it.');
  if (/\.glb$/i.test(main)) return readGltf(files[main].slice().buffer);
  return readGltf(strFromU8(files[main]), files, main.includes('/') ? main.slice(0, main.lastIndexOf('/') + 1) : '');
}

const BLANK_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// Above this, a model is simplified: a printed landmark is a few centimeters tall, and a
// million-triangle scan only slows everything down.
const MAX_TRIANGLES = 300_000;

// Vertex clustering: points snapped to a grid, each cell's points merged into their average,
// triangles squashed by the merge dropped. Works on any triangles (scans are rarely closed);
// the grid is made coarser until the model fits the budget.
function simplify(t: Float32Array, max: number): Float32Array {
  if (t.length / 9 <= max) return t;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], t[i]);
    hi[i % 3] = Math.max(hi[i % 3], t[i]);
  }
  const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  // About max / 2 cells' worth of surface to start with.
  let cells = Math.sqrt(max / 2);
  for (;;) {
    const size = extent / cells;
    // Cell index as one number (cells per side stays small enough to be exact).
    const side = Math.ceil(cells) + 2;
    const ids = new Map<number, number>();
    const sums: number[] = [];
    const cellOf = new Uint32Array(t.length / 3);
    for (let v = 0; v < t.length / 3; v++) {
      const key = Math.floor((t[v * 3] - lo[0]) / size) + side * (Math.floor((t[v * 3 + 1] - lo[1]) / size) + side * Math.floor((t[v * 3 + 2] - lo[2]) / size));
      let id = ids.get(key);
      if (id === undefined) {
        id = ids.size;
        ids.set(key, id);
        sums.push(0, 0, 0, 0);
      }
      sums[id * 4] += t[v * 3];
      sums[id * 4 + 1] += t[v * 3 + 1];
      sums[id * 4 + 2] += t[v * 3 + 2];
      sums[id * 4 + 3]++;
      cellOf[v] = id;
    }
    const kept: number[] = [];
    // Seen triangles by their first two cells (an exact number), then the third.
    const seen = new Map<number, Set<number>>();
    const n = ids.size;
    for (let f = 0; f < t.length / 9; f++) {
      const [a, b, c] = [cellOf[f * 3], cellOf[f * 3 + 1], cellOf[f * 3 + 2]];
      if (a === b || b === c || a === c) continue;
      // The same three cells twice (two triangles merged into one): keep one.
      const [x, y, z] = [a, b, c].sort((p, q) => p - q);
      const pair = x * n + y;
      const thirds = seen.get(pair) ?? new Set<number>();
      if (thirds.has(z)) continue;
      thirds.add(z);
      seen.set(pair, thirds);
      kept.push(a, b, c);
    }
    if (kept.length / 3 <= max || cells < 8) {
      const out = new Float32Array(kept.length * 3);
      kept.forEach((id, i) => out.set([sums[id * 4] / sums[id * 4 + 3], sums[id * 4 + 1] / sums[id * 4 + 3], sums[id * 4 + 2] / sums[id * 4 + 3]], i * 3));
      return out;
    }
    cells *= 0.75;
  }
}

// Every mesh's triangles, placed where the file's scene puts them.
function collect(root: Object3D): Float32Array {
  root.updateMatrixWorld(true);
  const chunks: Float32Array[] = [];
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const g = (o.geometry as BufferGeometry).clone().applyMatrix4(o.matrixWorld);
    const t = flatten(g);
    g.dispose();
    // A mirrored mesh comes out inside out: turn each triangle back.
    if (o.matrixWorld.determinant() < 0) {
      for (let i = 0; i < t.length; i += 9) {
        const b = t.slice(i + 3, i + 6);
        t.copyWithin(i + 3, i + 6, i + 9);
        t.set(b, i + 6);
      }
    }
    chunks.push(t);
  });
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function flatten(g: BufferGeometry): Float32Array {
  const flat = g.index ? g.toNonIndexed() : g;
  const pos = flat.getAttribute('position');
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) out.set([pos.getX(i), pos.getY(i), pos.getZ(i)], i * 3);
  if (flat !== g) flat.dispose();
  return out;
}
