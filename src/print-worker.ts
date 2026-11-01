// Builds the print off the main thread, so the page stays responsive while it runs (seconds
// for a big area): the model for the preview, or the merged model written to a file for a
// download. One job per worker; the page ends a worker whose job went stale.

import type { AreaData, Layer } from './area-data';
import type { Edits } from './edits';
import { buildPrintModel, findThinObjects, type PrintModel, type PrintOptions, type ThinObjects } from './export';
import { sourceCredits } from './credits';
import { to3MF, to3MFPieces, toSTL, toSTLPieces } from './export-files';
import { loadManifold, mergeModel } from './merge';
import { outlineMm } from './pieces';
import { cutPieces, piecesForPreview, type PieceSpec, type ShownPart } from './pieces-cut';
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
  // A download of the model the preview built: no need to build it again.
  previewed?: { model: PrintModel; thin: ThinObjects['counts'] };
  // Printed in pieces (pieces.ts), when the grid has more than one.
  pieces?: PieceSpec;
}

export type PrintResult =
  // `shown`: the preview's pieces, pulled apart in the view (the model itself stays whole,
  // for the download); `pieces`: how many the file has.
  | { ok: true; model: PrintModel; thin: ThinObjects; file?: Blob; skipped?: number; credits?: string[]; shown?: { parts: ShownPart[]; offsets: [number, number][] }; pieces?: number }
  | { ok: false; message: string };

// Sent while it works: how far along (0 to 1) and what it's doing.
export interface PrintProgress {
  progress: number;
  label: string;
}

// Each stage's share of the whole job, from timings on a 1 km² city center.
const SHARES = {
  preview: { build: 0.85, thin: 0.15, merge: 0, write: 0 },
  file: { build: 0.25, thin: 0.05, merge: 0.5, cut: 0, write: 0.2 },
  // From the previewed model: merging and writing only.
  previewed: { build: 0, thin: 0, merge: 0.7, cut: 0, write: 0.3 },
};
// In pieces, cutting takes about as long again as merging.
const CUT = { merge: 0.45, cut: 0.35, write: 0.2 };

self.onmessage = async (e: MessageEvent<PrintJob>) => {
  const job = e.data;
  const inPieces = !!job.pieces && job.pieces.grid.cols * job.pieces.grid.rows > 1;
  const base = SHARES[job.kind === 'preview' ? 'preview' : job.previewed ? 'previewed' : 'file'];
  // In pieces, what's left after building goes to merging, cutting and writing.
  const rest = 1 - base.build - base.thin;
  const share: Record<string, number> =
    job.kind !== 'preview' && inPieces ? { ...base, merge: CUT.merge * rest, cut: CUT.cut * rest, write: CUT.write * rest } : base;
  let start = 0;
  const report = (stage: string, fraction: number, label: string) => {
    const p: PrintProgress = { progress: start + (share[stage] ?? 0) * fraction, label };
    (self as unknown as Worker).postMessage(p);
  };
  const next = (stage: string) => (start += share[stage] ?? 0);
  for (const m of job.models) modelAssets.set(m.id, m);
  try {
    report('build', 0, 'Starting');
    const wasm = await loadManifold();
    let model: PrintModel;
    let thin: ThinObjects;
    if (job.previewed) {
      // The preview's model, as previewed.
      model = job.previewed.model;
      thin = { objects: new Map(), counts: job.previewed.thin };
      next('build');
      next('thin');
    } else {
      model = buildPrintModel(wasm, job.data, job.edits, job.scales, new Set(job.visible), job.options, (f, label) => report('build', f, label));
      next('build');
      report('thin', 0, 'Checking thin details');
      thin = findThinObjects(model, job.nozzleMm);
      next('thin');
    }
    // The joints go in the base: the terrain's, or the whole model's in an STL (one solid).
    const outline = inPieces ? outlineMm(job.data.selection, job.options.sizeMm) : [];
    const jointPart = job.kind === 'stl' ? 'Model' : 'Terrain';
    if (job.kind === 'preview') {
      const shown = inPieces ? piecesForPreview(wasm, model, outline, job.pieces!, job.options.baseMm, 'Terrain') : undefined;
      reply({ ok: true, model, thin, shown }, model, shown?.parts);
      return;
    }
    // Overlaps united into one watertight solid (one per colored part in a 3MF): what CAD
    // tools, mesh checkers and print services expect. The preview skips this: it looks the same.
    const label = job.kind === 'stl' ? 'Merging into one solid' : 'Merging each color';
    const merged = await mergeModel(model, job.kind === 'stl', (f) => report('merge', f, label));
    next('merge');
    const credits = sourceCredits(job.data, job.models, job.visible);
    let file: Blob;
    let pieces: number | undefined;
    if (inPieces) {
      report('cut', 0, 'Cutting the pieces');
      const cut = cutPieces(wasm, merged.model, outline, job.pieces!, job.options.baseMm, jointPart, (f) => report('cut', f, 'Cutting the pieces')).filter((c) => c.model.parts.length);
      next('cut');
      report('write', 0, 'Writing the files');
      const named = cut.map(({ piece, model }) => ({ name: `${job.name}-r${piece.row + 1}c${piece.col + 1}`, model }));
      // On the plate a little apart, as on the map, so they don't overlap.
      const GAP = 10;
      file =
        job.kind === 'stl'
          ? toSTLPieces(named)
          : to3MFPieces(
              named.map((n, i) => ({ ...n, offset: [cut[i].piece.col * GAP, -cut[i].piece.row * GAP] })),
              job.name,
              credits,
            );
      pieces = cut.length;
    } else {
      report('write', 0, 'Writing the file');
      file = job.kind === 'stl' ? toSTL(merged.model) : to3MF(merged.model, job.name, credits);
    }
    // The unmerged model's size and counts are what the page reports; no need to send its
    // triangles back.
    reply({ ok: true, model: { ...merged.model, parts: [] }, thin: { objects: new Map(), counts: thin.counts }, file, skipped: merged.skipped, credits, pieces }, null);
  } catch (err) {
    console.error('Print build failed', err);
    reply({ ok: false, message: (err as Error).message }, null);
  }
};

// The triangle arrays move to the page instead of being copied.
function reply(result: PrintResult, model: PrintModel | null, shown: ShownPart[] = []) {
  const buffers = [...(model?.parts ?? []), ...shown].flatMap((p) => [p.triangles.buffer, p.solids.buffer, p.objects.buffer]);
  (self as unknown as Worker).postMessage(result, [...new Set(buffers)] as ArrayBuffer[]);
}
