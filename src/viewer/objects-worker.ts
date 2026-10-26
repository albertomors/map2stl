// Builds the 3D view's objects off the page's thread (scene-objects.ts). The data comes once
// per area and stays here; each job brings the scales, the water and the edits, plus the 3D
// models the edits use that this worker hasn't seen yet.

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

let data: AreaData | null = null;
let clipped: OsmData | null = null;

self.onmessage = (e: MessageEvent<ObjectsRequest>) => {
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
