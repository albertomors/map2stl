// Builds the print off the main thread, so the page stays responsive while it runs (seconds
// for a big area): the model for the preview, or the merged model written to a file for a
// download. One job per worker; the page ends a worker whose job went stale.

import type { AreaData, Layer } from './area-data';
import type { Edits } from './edits';
import { buildPrintModel, findThinObjects, type PrintModel, type PrintOptions, type ThinObjects } from './export';
import { to3MF, toSTL } from './export-files';
import { loadManifold, mergeModel } from './merge';
import { modelAssets, type ModelAsset } from './model-assets';
import type { ViewScales } from './viewer/viewer';

export interface PrintJob {
  kind: 'preview' | 'stl' | '3mf';
  data: AreaData;
  edits: Edits;
  scales: ViewScales;
  visible: Layer[];
  options: PrintOptions;
  nozzleMm: number;
  // File name without extension (downloads).
  name: string;
  // The 3D models the edits use.
  models: ModelAsset[];
}

export type PrintResult =
  | { ok: true; model: PrintModel; thin: ThinObjects; file?: Blob; skipped?: number; credits?: string[] }
  | { ok: false; message: string };

// Sent while it works: how far along (0 to 1) and what it's doing.
export interface PrintProgress {
  progress: number;
  label: string;
}

// Each stage's share of the whole job, from timings on a 1 km² city center.
const SHARES = {
  preview: { build: 0.85, thin: 0.15, merge: 0, write: 0 },
  file: { build: 0.25, thin: 0.05, merge: 0.5, write: 0.2 },
};

self.onmessage = async (e: MessageEvent<PrintJob>) => {
  const job = e.data;
  const share = SHARES[job.kind === 'preview' ? 'preview' : 'file'];
  let start = 0;
  const report = (stage: keyof typeof share, fraction: number, label: string) => {
    const p: PrintProgress = { progress: start + share[stage] * fraction, label };
    (self as unknown as Worker).postMessage(p);
  };
  const next = (stage: keyof typeof share) => (start += share[stage]);
  for (const m of job.models) modelAssets.set(m.id, m);
  try {
    report('build', 0, 'Starting');
    const wasm = await loadManifold();
    const model = buildPrintModel(wasm, job.data, job.edits, job.scales, new Set(job.visible), job.options, (f, label) => report('build', f, label));
    next('build');
    report('thin', 0, 'Checking thin details');
    const thin = findThinObjects(model, job.nozzleMm);
    next('thin');
    if (job.kind === 'preview') {
      reply({ ok: true, model, thin }, model);
      return;
    }
    // Overlaps united into one watertight solid (one per colored part in a 3MF): what CAD
    // tools, mesh checkers and print services expect. The preview skips this: it looks the same.
    const label = job.kind === 'stl' ? 'Merging into one solid' : 'Merging each color';
    const merged = await mergeModel(model, job.kind === 'stl', (f) => report('merge', f, label));
    next('merge');
    report('write', 0, 'Writing the file');
    // Models found online came with a license asking for credit.
    const credits = job.models.flatMap((m) => (m.source.kind !== 'upload' ? [`3D model "${m.source.title}" by ${m.source.author}, ${m.source.license}, ${m.source.url}`] : []));
    const file = job.kind === 'stl' ? toSTL(merged.model) : to3MF(merged.model, job.name, credits);
    // The unmerged model's size and counts are what the page reports; no need to send its
    // triangles back.
    reply({ ok: true, model: { ...merged.model, parts: [] }, thin: { objects: new Map(), counts: thin.counts }, file, skipped: merged.skipped, credits }, null);
  } catch (err) {
    console.error('Print build failed', err);
    reply({ ok: false, message: (err as Error).message }, null);
  }
};

// The triangle arrays move to the page instead of being copied.
function reply(result: PrintResult, model: PrintModel | null) {
  const buffers = model ? model.parts.flatMap((p) => [p.triangles.buffer, p.solids.buffer, p.objects.buffer]) : [];
  (self as unknown as Worker).postMessage(result, [...new Set(buffers)] as ArrayBuffer[]);
}
