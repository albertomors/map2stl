// Reads a model file off the main thread (see model-files.ts): parsing and simplifying a
// big scan takes seconds, during which the page would otherwise freeze.

import { readModel } from './model-files';
import type { ModelAsset, ModelSource } from './model-assets';

export interface ModelJob {
  data: ArrayBuffer;
  name: string;
  source: ModelSource;
}

export type ModelResult = { ok: true; asset: ModelAsset } | { ok: false; message: string };

self.onmessage = async (e: MessageEvent<ModelJob>) => {
  const { data, name, source } = e.data;
  try {
    const asset = await readModel(data, name, source);
    const result: ModelResult = { ok: true, asset };
    (self as unknown as Worker).postMessage(result, [asset.triangles.buffer as ArrayBuffer]);
  } catch (err) {
    const result: ModelResult = { ok: false, message: (err as Error).message };
    (self as unknown as Worker).postMessage(result);
  }
};
