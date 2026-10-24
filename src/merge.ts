// The model's overlapping solids united into one watertight solid (per part for a 3MF, so the
// colors stay apart), with manifold-3d (WebAssembly, loaded on the first export). Slicers
// merge overlaps themselves; CAD tools, mesh checkers and print services want this. A solid
// manifold-3d won't take (not closed, say) is kept as it was.

import type { PrintModel, PrintPart } from './export';

export interface MergeResult {
  model: PrintModel;
  // Solids left as they were.
  skipped: number;
}

export type Wasm = Awaited<ReturnType<typeof import('manifold-3d/manifold').default>>;
let loading: Promise<Wasm> | null = null;

// manifold-3d, loaded once (the print's ground layers use its 2D geometry too).
export function loadManifold(): Promise<Wasm> {
  loading ??= (async () => {
    const [{ default: Module }, { default: wasmUrl }] = await Promise.all([import('manifold-3d/manifold'), import('manifold-3d/manifold.wasm?url')]);
    const wasm = await Module({ locateFile: () => wasmUrl });
    wasm.setup();
    return wasm;
  })();
  return loading;
}

// `whole`: everything into one solid (STL); otherwise each part on its own (3MF).
// `progress` hears how far along it is, 0 to 1.
export async function mergeModel(model: PrintModel, whole: boolean, progress: (fraction: number) => void = () => {}): Promise<MergeResult> {
  const { Manifold, Mesh } = await loadManifold();
  let skipped = 0;
  // Each solid's triangles as an indexed mesh, points shared by exact position.
  const manifolds = (part: PrintPart) => {
    const bySolid = new Map<number, number[]>();
    for (let t = 0; t < part.solids.length; t++) {
      let list = bySolid.get(part.solids[t]);
      if (!list) bySolid.set(part.solids[t], (list = []));
      list.push(t);
    }
    const ok: InstanceType<typeof Manifold>[] = [];
    const left: number[] = [];
    for (const tris of bySolid.values()) {
      // Each triangle with its own three points: manifold-3d's merge() joins the ones in the
      // same place (quicker than sharing them here). Triangles squashed flat are left out.
      const verts = new Float32Array(tris.length * 9);
      let n = 0;
      const tr = part.triangles;
      for (const t of tris) {
        const o = t * 9;
        const same = (i: number, j: number) => tr[o + i] === tr[o + j] && tr[o + i + 1] === tr[o + j + 1] && tr[o + i + 2] === tr[o + j + 2];
        if (same(0, 3) || same(3, 6) || same(0, 6)) continue;
        verts.set(tr.subarray(o, o + 9), n * 9);
        n++;
      }
      const triVerts = new Uint32Array(n * 3).map((_, i) => i);
      try {
        const mesh = new Mesh({ numProp: 3, vertProperties: verts.subarray(0, n * 9), triVerts });
        mesh.merge();
        const m = new Manifold(mesh);
        if (m.status() === 'NoError' && !m.isEmpty()) ok.push(m);
        else {
          m.delete();
          throw new Error('not manifold');
        }
      } catch {
        skipped++;
        // One by one: a big solid (the terrain) has more triangles than a spread can take.
        for (const t of tris) left.push(t);
      }
    }
    return { ok, left };
  };

  const toPart = (base: PrintPart, ok: InstanceType<typeof Manifold>[], leftovers: { part: PrintPart; tris: number[] }[]): PrintPart => {
    const chunks: Float32Array[] = [];
    const solidChunks: number[] = [];
    let solid = 0;
    if (ok.length) {
      const united = Manifold.union(ok);
      const mesh = united.getMesh();
      const p = mesh.vertProperties;
      const n = mesh.numProp;
      const out = new Float32Array(mesh.triVerts.length * 3);
      mesh.triVerts.forEach((v, i) => out.set([p[v * n], p[v * n + 1], p[v * n + 2]], i * 3));
      chunks.push(out);
      for (let t = 0; t < out.length / 9; t++) solidChunks.push(solid);
      solid++;
      united.delete();
      for (const m of ok) m.delete();
    }
    // What couldn't be merged goes in unchanged, each solid still on its own.
    for (const { part, tris } of leftovers) {
      const out = new Float32Array(tris.length * 9);
      const ids = new Map<number, number>();
      tris.forEach((t, i) => {
        out.set(part.triangles.subarray(t * 9, t * 9 + 9), i * 9);
        const s = part.solids[t];
        if (!ids.has(s)) ids.set(s, solid + ids.size);
        solidChunks.push(ids.get(s)!);
      });
      solid += ids.size;
      chunks.push(out);
    }
    const triangles = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) {
      triangles.set(c, o);
      o += c.length;
    }
    const solids = Uint32Array.from(solidChunks);
    return { name: base.name, color: base.color, triangles, solids, objects: solids };
  };

  // Progress by triangles done: the work grows with them.
  const total = model.parts.reduce((n, p) => n + p.solids.length, 0) || 1;
  let done = 0;
  const step = (part: PrintPart, share: number) => {
    done += part.solids.length;
    progress((done / total) * share);
  };
  let parts: PrintPart[];
  if (whole) {
    // Reading the solids is about half the work, uniting them all at once the other half.
    const all = model.parts.map((part) => {
      const r = { part, ...manifolds(part) };
      step(part, 0.5);
      return r;
    });
    const merged = toPart(
      model.parts[0],
      all.flatMap((a) => a.ok),
      all.map((a) => ({ part: a.part, tris: a.left })),
    );
    parts = [{ ...merged, name: 'Model' }];
  } else {
    parts = model.parts.map((part) => {
      const { ok, left } = manifolds(part);
      const merged = toPart(part, ok, [{ part, tris: left }]);
      step(part, 1);
      return merged;
    });
  }
  return {
    model: { ...model, parts, triangleCount: parts.reduce((n, p) => n + p.triangles.length / 9, 0) },
    skipped,
  };
}
