// Builds the print off the main thread, so the page stays responsive while it runs (seconds
// for a big area): the model for the preview, or the merged model written to a file for a
// download. One job per worker; the page ends a worker whose job went stale.

import type { AreaData, Layer } from './area-data';
import type { Edits } from './edits';
import { buildPrintModel, buildPrintPieces, combinePieces, findThinObjects, pieceOf, type PrintModel, type PrintOptions, type ThinObjects } from './export';
import { sourceCredits } from './credits';
import { to3MF, to3MFPieces, toSTL, toSTLPieces } from './export-files';
import { loadManifold, mergeModel } from './merge';
import type { PieceSpec } from './pieces';
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
  // `pieces`: how many the file has.
  | { ok: true; model: PrintModel; thin: ThinObjects; file?: Blob; skipped?: number; credits?: string[]; pieces?: number }
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


self.onmessage = async (e: MessageEvent<PrintJob>) => {
  const job = e.data;
  const inPieces = !!job.pieces && job.pieces.grid.cols * job.pieces.grid.rows > 1;
  const base = SHARES[job.kind === 'preview' ? 'preview' : job.previewed ? 'previewed' : 'file'];
  const share: Record<string, number> = base;
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
      // In pieces, each built on its own outline (export.ts), as one model of tagged parts.
      model = inPieces
        ? combinePieces(buildPrintPieces(wasm, job.data, job.edits, job.scales, new Set(job.visible), job.options, job.pieces, (f, label) => report('build', f, label)), job.pieces!.grid)
        : buildPrintModel(wasm, job.data, job.edits, job.scales, new Set(job.visible), job.options, (f, label) => report('build', f, label));
      next('build');
      report('thin', 0, 'Checking thin details');
      thin = findThinObjects(model, job.nozzleMm);
      next('thin');
    }
    if (job.kind === 'preview') {
      reply({ ok: true, model, thin }, model);
      return;
    }
    // Overlaps united into one watertight solid (one per colored part in a 3MF): what CAD
    // tools, mesh checkers and print services expect. The preview skips this: it looks the same.
    // In pieces, each piece on its own.
    const label = job.kind === 'stl' ? 'Merging into one solid' : 'Merging each color';
    const credits = sourceCredits(job.data, job.models, job.visible);
    let file: Blob;
    let pieces: number | undefined;
    let merged: { model: PrintModel; skipped: number };
    if (model.pieces) {
      const list = model.pieces;
      const done: { name: string; model: PrintModel; offset: [number, number] }[] = [];
      let skipped = 0;
      // On the plate a little apart, as on the map, so they don't overlap.
      const GAP = 10;
      for (let i = 0; i < list.length; i++) {
        const { col, row, keys } = list[i];
        // The keys laid out in rows for one plate, before they're merged into one solid.
        const piece = keys ? packKeys(pieceOf(model, i)) : pieceOf(model, i);
        const m = await mergeModel(piece, job.kind === 'stl', (f) => report('merge', (i + f) / list.length, label));
        skipped += m.skipped;
        if (!m.model.parts.length) continue;
        done.push({ name: keys ? `${job.name}-keys` : `${job.name}-r${row + 1}c${col + 1}`, model: m.model, offset: keys ? [model.sizeMm[0] / 2 + (model.grid?.cols ?? 1) * GAP + 10, 0] : [col * GAP, -row * GAP] });
      }
      next('merge');
      report('write', 0, 'Writing the files');
      file = job.kind === 'stl' ? toSTLPieces(done) : to3MFPieces(done, job.name, credits);
      pieces = done.length;
      const triangleCount = done.reduce((n, d) => n + d.model.triangleCount, 0);
      merged = { model: { ...model, parts: [], triangleCount }, skipped };
    } else {
      merged = await mergeModel(model, job.kind === 'stl', (f) => report('merge', f, label));
      next('merge');
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

// The joints' keys, in place in the model (each a solid of its own), laid out in rows of up to
// 150 mm from the origin, 4 mm apart: one small plate.
function packKeys(model: PrintModel): PrintModel {
  const parts = model.parts.map((part) => {
    const bySolid = new Map<number, number[]>();
    for (let t = 0; t < part.solids.length; t++) bySolid.set(part.solids[t], [...(bySolid.get(part.solids[t]) ?? []), t]);
    const out = new Float32Array(part.triangles.length);
    let [x, y, rowH] = [0, 0, 0];
    let o = 0;
    const solids: number[] = [];
    for (const [solid, tris] of bySolid) {
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const t of tris) {
        for (let v = 0; v < 3; v++) {
          const [px, py] = [part.triangles[t * 9 + v * 3], part.triangles[t * 9 + v * 3 + 1]];
          [x0, y0, x1, y1] = [Math.min(x0, px), Math.min(y0, py), Math.max(x1, px), Math.max(y1, py)];
        }
      }
      if (x && x + (x1 - x0) > 150) [x, y, rowH] = [0, y + rowH + 4, 0];
      for (const t of tris) {
        for (let v = 0; v < 3; v++) {
          const k = t * 9 + v * 3;
          out.set([part.triangles[k] - x0 + x, part.triangles[k + 1] - y0 + y, part.triangles[k + 2]], o);
          o += 3;
        }
        solids.push(solid);
      }
      x += x1 - x0 + 4;
      rowH = Math.max(rowH, y1 - y0);
    }
    const ids = Uint32Array.from(solids);
    return { ...part, triangles: out, solids: ids, objects: ids };
  });
  return { ...model, parts };
}

// The triangle arrays move to the page instead of being copied.
function reply(result: PrintResult, model: PrintModel | null) {
  const buffers = (model?.parts ?? []).flatMap((p) => [p.triangles.buffer, p.solids.buffer, p.objects.buffer]);
  (self as unknown as Worker).postMessage(result, [...new Set(buffers)] as ArrayBuffer[]);
}
