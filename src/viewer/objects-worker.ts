// Builds the 3D view's objects off the page's thread (scene-objects.ts). The data comes once
// per area and stays here; each job brings the scales, the water and the edits, plus the 3D
// models the edits use that this worker hasn't seen yet. It also keeps the official models
// (objects-host.ts): handed over as they're found, joined, dropped, and lent back as copies.

import type { AreaData } from '../area-data';
import { clipToSelection } from '../clip';
import { modelAssets, type ModelAsset } from '../model-assets';
import type { OsmData } from '../osm';
import { describe } from '../selection';
import { buildSceneObjects, transferables, type ObjectsJob, type SceneObjects } from './scene-objects';

export interface ObjectsRequest {
  id: number;
  job: ObjectsJob;
  // New data, when the area changed since the last request.
  data?: AreaData;
  models: ModelAsset[];
}

export type ObjectsReply = { id: number; ok: true; objects: SceneObjects } | { id: number; ok: false; message: string };

// Keeping the official models: `join` [new, old] adds the old one's triangles to the new
// one's (a model spread over two tiles), and drops the old.
export type ModelsRequest =
  | { type: 'store'; models: ModelAsset[]; join: [string, string][] }
  | { type: 'forget'; ids: string[] }
  | { type: 'lend'; id: number; ids: string[] };
export type LentReply = { type: 'lent'; id: number; models: ModelAsset[] };

let data: AreaData | null = null;
let clipped: OsmData | null = null;

self.onmessage = (e: MessageEvent<ObjectsRequest | ModelsRequest>) => {
  if ('type' in e.data) return keep(e.data);
  const { id, job, models } = e.data;
  try {
    if (e.data.data) {
      data = e.data.data;
      clipped = clipToSelection(data.osm, describe(data.selection).ring);
    }
    for (const m of models) modelAssets.set(m.id, m);
    const objects = buildSceneObjects(data!, clipped!, job);
    (self as unknown as Worker).postMessage({ id, ok: true, objects } satisfies ObjectsReply, transferables(objects));
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, message: (err as Error).message } satisfies ObjectsReply);
  }
};

function keep(r: ModelsRequest) {
  if (r.type === 'store') {
    for (const m of r.models) modelAssets.set(m.id, m);
    for (const [to, from] of r.join) {
      const [a, b] = [modelAssets.get(from), modelAssets.get(to)];
      modelAssets.delete(from);
      if (!a || !b) continue;
      const t = new Float32Array(a.triangles.length + b.triangles.length);
      t.set(a.triangles);
      t.set(b.triangles, a.triangles.length);
      modelAssets.set(to, { ...b, triangles: t });
    }
  } else if (r.type === 'forget') {
    for (const id of r.ids) modelAssets.delete(id);
  } else {
    // Copies: the page holds them only while it needs them (a highlight, a print).
    const models = r.ids.flatMap((id) => {
      const m = modelAssets.get(id);
      return m ? [{ ...m, triangles: m.triangles.slice() }] : [];
    });
    const reply: LentReply = { type: 'lent', id: r.id, models };
    (self as unknown as Worker).postMessage(reply, models.map((m) => m.triangles.buffer as ArrayBuffer));
  }
}
