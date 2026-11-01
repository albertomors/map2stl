// The 3D objects' worker (objects-worker.ts), one per page: it builds the 3D view's objects,
// and keeps the official models. Those come by the million triangles (5 km of Zurich: 15
// million, half a gigabyte), so they're handed to it as they're found, not copied: the page
// keeps only a stub of each (its source, place and height span), and borrows the triangles
// back when it needs them (a highlight, a print). It outlives the 3D view: Back to map and in
// again keeps them. Free of three.js: the page loads it without the 3D code.

import type { AreaData } from '../area-data';
import { modelAssets, type ModelAsset } from '../model-assets';
import type { LentReply, ModelsRequest } from './objects-worker';

let worker: Worker | null = null;
export function objectsWorker(): Worker {
  return (worker ??= new Worker(new URL('./objects-worker.ts', import.meta.url), { type: 'module' }));
}

// What the worker has already: the area's data, and the models (by id).
export const sent: { data: AreaData | null; models: Set<string> } = { data: null, models: new Set() };

// Official models found, handed to the worker; `join` [new, old]: the new one carries the old
// one's triangles too (a model spread over two tiles), and the old is dropped.
export function storeModels(models: ModelAsset[], join: [string, string][] = []) {
  const stubs = models.map((m) => ({ ...m, triangles: new Float32Array(0), stored: true, span: span(m.triangles) }));
  for (const [to, from] of join) {
    const [a, b] = [modelAssets.get(from)?.span, stubs.find((s) => s.id === to)];
    if (a && b) b.span = b.span ? [Math.min(a[0], b.span[0]), Math.max(a[1], b.span[1])] : a;
    modelAssets.delete(from);
    sent.models.delete(from);
  }
  const request: ModelsRequest = { type: 'store', models, join };
  // Each buffer once: one listed twice can't be handed over.
  objectsWorker().postMessage(request, [...new Set(models.map((m) => m.triangles.buffer as ArrayBuffer))]);
  for (const s of stubs) {
    modelAssets.set(s.id, s);
    sent.models.add(s.id);
  }
}

export function forgetModels(ids: string[]) {
  if (!ids.length) return;
  for (const id of ids) {
    modelAssets.delete(id);
    sent.models.delete(id);
  }
  const request: ModelsRequest = { type: 'forget', ids };
  objectsWorker().postMessage(request);
}

// The models with their triangles: the stored ones borrowed back from the worker (copies).
let lent = 0;
export function withTriangles(models: ModelAsset[]): Promise<ModelAsset[]> {
  const away = models.filter((m) => m.stored && !m.triangles.length && m.span);
  if (!away.length) return Promise.resolve(models);
  const id = ++lent;
  const w = objectsWorker();
  return new Promise((resolve) => {
    const reply = (e: MessageEvent<LentReply | { type?: undefined }>) => {
      if (e.data.type !== 'lent' || e.data.id !== id) return;
      w.removeEventListener('message', reply);
      const back = new Map(e.data.models.map((m) => [m.id, m]));
      resolve(models.map((m) => back.get(m.id) ?? m));
    };
    w.addEventListener('message', reply);
    const request: ModelsRequest = { type: 'lend', id, ids: away.map((m) => m.id) };
    w.postMessage(request);
  });
}

// The lowest and highest point of a model (y), or none if it's empty.
function span(t: Float32Array): [number, number] | undefined {
  if (!t.length) return undefined;
  let [low, high] = [Infinity, -Infinity];
  for (let i = 1; i < t.length; i += 3) [low, high] = [Math.min(low, t[i]), Math.max(high, t[i])];
  return [low, high];
}
