// Reads a 3D model file into plain triangles for viewer/models.ts: STL, OBJ, and glTF (a
// .glb, or a .gltf with its data inside). Every mesh in the file is taken, with its place in
// the file's scene applied.

import { BufferGeometry, Mesh, type Object3D } from 'three';
import type { Axis, ModelAsset, ModelSource } from './model-assets';

export async function readModelFile(file: File, source: ModelSource = { kind: 'upload', title: file.name }): Promise<ModelAsset> {
  return readModel(await file.arrayBuffer(), file.name, source);
}

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
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    try {
      const gltf = await new GLTFLoader().parseAsync(data, '');
      triangles = collect(gltf.scene);
    } catch (err) {
      // Separate .bin or texture files can't come along with a single file.
      throw new Error(`couldn't read the glTF (${(err as Error).message}). Use a .glb, or a .gltf with its data inside.`);
    }
    up = 'y';
  } else {
    throw new Error(`.${ext} files aren't supported: use STL, OBJ, GLB or glTF.`);
  }
  if (!triangles.length) throw new Error('the file has no triangles.');
  return { id: crypto.randomUUID(), triangles, up, source };
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
