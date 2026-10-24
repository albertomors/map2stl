import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import './style.css';
import { fetchAreaData, summarize, type AreaData, type FetchProgress, type Layer } from './area-data';
import { DrawController } from './draw';
import { countBuildings, estimateSeconds, recordSample, type EtaInput } from './eta';
import { distance } from './geo';
import { setupNavigation } from './nav';
import { DataPreview, LAYER_COLORS } from './preview';
import { setupSearch } from './search';
import { describe, loadSelection, saveSelection, type Selection, type ShapeKind } from './selection';
import type { CommonsModel } from './commons';
import type { SketchfabModel } from './sketchfab';
import { modelAssets, type ModelAsset, type ModelChoice, type ModelSource } from './model-assets';
import type { ModelJob, ModelResult } from './model-worker';
import type { ObjectPick, Viewer, ViewScales } from './viewer/viewer';
import type { Edits, GroundKind } from './edits';
import type { PrintModel, ThinObjects } from './export';
import type { PrintJob, PrintProgress, PrintResult } from './print-worker';

// Above this, OSM downloads in dense cities get slow and the print loses detail.
const LARGE_AREA_M2 = 10e6;

const HINTS: Record<ShapeKind, string> = {
  rectangle: 'Drag from one corner to the opposite corner.',
  hexagon: 'Drag from the center outward. Up on screen becomes the flat top.',
  circle: 'Drag from the center outward.',
  polygon: 'Click to add points; double-click, or click the first point, to finish.',
};

const SHAPE_NAMES: Record<ShapeKind, string> = { rectangle: 'Rectangle', hexagon: 'Hexagon', circle: 'Circle', polygon: 'Free shape' };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// MapLibre looks for its worker next to its own bundle, which Vite moves: point at it explicitly.
maplibregl.setWorkerUrl(workerUrl);

const map = new maplibregl.Map({
  container: 'map',
  // OpenFreeMap: free OSM vector tiles, no API key, no usage limits.
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [10, 45],
  zoom: 3,
  hash: true,
  attributionControl: { customAttribution: 'Search © <a href="https://photon.komoot.io">Photon</a>' },
});
setupNavigation(map);
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

setupSearch(map, $('search'), $('search-input'), $('search-results'));

const toolButtons = document.querySelectorAll<HTMLButtonElement>('[data-tool]');
let draw: DrawController | null = null;
let preview: DataPreview | null = null;
let selection: Selection | null = null;
// The download in progress, if any.
let loading: AbortController | null = null;
let areaData: AreaData | null = null;
const visibleLayers = new Set<Layer>();
// Layers with something in them, in the data last shown.
const shownLayers = new Set<Layer>();
let viewer: Viewer | null = null;
// Object edits in the 3D view (delete, enlarge, height), for the current area; the export uses them.
const edits: Edits = new Map();
let picked: ObjectPick | null = null;

// Wired right away: a click before the map is ready says so instead of doing nothing.
toolButtons.forEach((btn) =>
  btn.addEventListener('click', () => {
    if (!draw) return void ($('tool-hint').textContent = 'The map is still loading…');
    const tool = btn.dataset.tool as ShapeKind;
    draw.setTool(btn.classList.contains('active') ? null : tool);
  }),
);
$('clear').addEventListener('click', () => draw?.clear());
$('fetch').addEventListener('click', () => (loading ? loading.abort() : selection && fetchData(selection)));
$('open-3d').addEventListener('click', () => open3d());
$('close-3d').addEventListener('click', () => close3d());
for (const id of ['terrain-scale', 'height-scale']) {
  let timer: number | undefined;
  // Instant stretch while dragging; one real rebuild when the slider is let go.
  $(id).addEventListener('input', () => {
    showScales();
    showEditsSummary();
    viewer?.previewScales(scales());
  });
  $(id).addEventListener('change', () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => (viewer?.setScales(scales()), updatePrintPreview()), 0);
  });
}
showScales();

// Export: what's in the 3D view (edits, multipliers, visible layers), in millimeters.
let exportFormat: 'stl' | '3mf' = 'stl';
const FORMAT_HINTS = {
  stl: 'One watertight solid, for any slicer.',
  '3mf': 'One colored part per layer (terrain, water, streets, squares, parks, sand, buildings, structures, trees), for multi-color printers.',
};
function showFormat() {
  for (const f of ['stl', '3mf'] as const) $(`format-${f}`).setAttribute('aria-pressed', String(f === exportFormat));
  $('format-hint').textContent = FORMAT_HINTS[exportFormat];
  $('download').textContent = `Download ${exportFormat.toUpperCase()}`;
  // The preview shows what the file will print: one color for an STL, the parts' for a 3MF.
  viewer?.setPrintMonochrome(exportFormat === 'stl');
}
for (const f of ['stl', '3mf'] as const) $(`format-${f}`).addEventListener('click', () => ((exportFormat = f), showFormat()));
showFormat();
$('download').addEventListener('click', () => downloadModel());
// Print preview: the exported model in the 3D view, rebuilt when anything it depends on changes.
let printPreview = false;
$('preview-print').addEventListener('click', () => setPrintPreview(!printPreview));
for (const id of ['print-size', 'print-base', 'print-min', 'print-nozzle']) $(id).addEventListener('change', () => updatePrintPreview());
// Thinnest detail and nozzle step by 0.1 mm, and by 0.01 mm below 0.1 (0.1 up is 0.2, not
// 0.11; 0.1 down is 0.09): their own arrows and keys, since a number field's step is fixed.
for (const stepper of document.querySelectorAll<HTMLElement>('.stepper')) {
  const input = stepper.querySelector('input')!;
  const step = (dir: number) => {
    const min = Number(input.min) || 0;
    const v = Number(input.value) || min;
    const next = fineStep(v, dir);
    input.value = String(Math.max(min, next));
    input.dispatchEvent(new Event('change'));
  };
  for (const b of stepper.querySelectorAll<HTMLButtonElement>('button')) b.addEventListener('click', () => step(Number(b.dataset.step)));
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    step(e.key === 'ArrowUp' ? 1 : -1);
  });
}

// Object editing in the 3D view.
for (const [id, field] of [['object-size', 'scale'], ['object-height', 'heightScale']] as const) {
  let timer: number | undefined;
  // Instant stretch of the lifted object while dragging; rebuild just that object on release.
  $(id).addEventListener('input', () => {
    if (!picked) return;
    edits.set(picked.key, { ...edits.get(picked.key), [field]: Number($<HTMLInputElement>(id).value) });
    showPickValues();
    showModelFit(picked);
    showEditsSummary();
    viewer?.previewEdit(edits.get(picked.key));
  });
  $(id).addEventListener('change', () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => viewer?.setEdits(edits, { selectedOnly: true }), 0);
  });
}
$('object-delete').addEventListener('click', () => deletePicked());
// Streets, railways, rivers: wider or narrower (shown on release: the ground is repainted).
$('object-width').addEventListener('input', () => {
  if (!picked) return;
  edits.set(picked.key, { ...edits.get(picked.key), width: Number($<HTMLInputElement>('object-width').value) });
  showPickValues();
  showEditsSummary();
});
$('object-width').addEventListener('change', () => picked && refreshModel(picked.key));
// Areas: print as another kind (a car park as plain square, a fountain as water…).
$('object-ground').addEventListener('change', () => {
  if (!picked) return;
  edits.set(picked.key, { ...edits.get(picked.key), ground: $<HTMLSelectElement>('object-ground').value as GroundKind });
  refreshModel(picked.key);
});
// A 3D model in place of the selected building (fitted to it: see viewer/models.ts).
$('object-model-upload').addEventListener('click', () => $<HTMLInputElement>('object-model-file').click());
$('object-model-file').addEventListener('change', async () => {
  const input = $<HTMLInputElement>('object-model-file');
  const file = input.files?.[0];
  input.value = '';
  if (!file || !picked) return;
  const key = picked.key;
  const status = $('object-model-status');
  status.textContent = `Reading ${file.name}…`;
  try {
    useModel(key, await readModelInWorker(await file.arrayBuffer(), file.name, { kind: 'upload', title: file.name }));
    status.textContent = '';
  } catch (err) {
    status.textContent = `Couldn't use ${file.name}: ${(err as Error).message}`;
  }
});
// Openly licensed models of the landmark online: Wikimedia Commons first (its matches are
// exact: the landmark's own Wikidata model), then Sketchfab's much bigger catalog by name.
// Every result shows its license; NonCommercial and ShareAlike ones are marked, not hidden.
let modelSearch: AbortController | null = null;
$('object-model-find').addEventListener('click', () => picked && searchModels(picked.key, { landmark: picked.landmark ?? {} }));
// Or by hand: whatever the user types, on both sites.
$('model-search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const query = $<HTMLInputElement>('model-search').value.trim();
  if (picked && query) searchModels(picked.key, { query });
});

// Searches both sites for the selected building: by its landmark (its Wikidata model and
// names, English first) or by a query typed in.
async function searchModels(key: string, by: { landmark: { wikidata?: string; name?: string } } | { query: string }) {
  const status = $('object-model-status');
  const list = $('object-model-results');
  modelSearch?.abort();
  const search = (modelSearch = new AbortController());
  list.hidden = true;
  $('sketchfab-login').hidden = true;
  $('model-search-form').hidden = false;
  status.textContent = 'Searching Wikimedia Commons and Sketchfab…';
  const [{ findCommonsModels, wikidataEnglishName }, { searchSketchfabNames }] = await Promise.all([import('./commons'), import('./sketchfab')]);
  const landmark = 'landmark' in by ? by.landmark : { name: by.query };
  // Sketchfab by name: the English one first (from Wikidata), then the local one from OSM.
  const names = async () => {
    const english = landmark.wikidata ? await wikidataEnglishName(landmark.wikidata, search.signal).catch(() => undefined) : undefined;
    return [...new Set([english, landmark.name].filter((n): n is string => !!n))];
  };
  const searched = await names();
  // The names searched, in the box: to refine by hand.
  $<HTMLInputElement>('model-search').value = searched[0] ?? '';
  // One failing source doesn't hide the other's results.
  const [commons, sketchfab] = await Promise.all([
    findCommonsModels(landmark, search.signal).catch(() => null),
    (searched.length ? searchSketchfabNames(searched, search.signal) : Promise.resolve([])).catch(() => null),
  ]);
  if (search !== modelSearch || picked?.key !== key) return;
  const rows = [
    ...(commons ?? []).map((m) =>
      resultRow({ source: 'Wikimedia Commons', name: m.name, pageUrl: m.pageUrl, license: m.license, restricted: false, author: m.author, size: formatBytes(m.bytes), how: { wikidata: 'its Wikidata model', depicts: 'depicts it', name: 'name match' }[m.match] }, (row) => useCommonsModel(key, m, row)),
    ),
    ...(sketchfab ?? []).map((m) =>
      resultRow({ source: 'Sketchfab', name: m.name, pageUrl: m.pageUrl, license: m.license, restricted: m.restricted, author: m.author, size: m.bytes ? formatBytes(m.bytes) : '', how: m.faces ? `${m.faces.toLocaleString()} triangles` : '', thumbnail: m.thumbnail }, (row) => useSketchfabModel(key, m, row)),
    ),
  ];
  const failed = [commons === null && 'Wikimedia Commons', sketchfab === null && 'Sketchfab'].filter(Boolean).join(' and ');
  const what = 'query' in by ? `"${by.query}"` : (landmark.name ?? 'this building');
  status.textContent = rows.length
    ? `Check that it's ${'query' in by ? (picked?.title ?? 'this building') : what} before using one. NonCommercial and ShareAlike licenses are highlighted: how you use the print is up to you.${failed ? ` (${failed} didn't answer.)` : ''}`
    : failed
      ? `The search failed: ${failed} didn't answer.`
      : searched.length || landmark.wikidata
        ? `No downloadable 3D model found for ${what}. Try other words in the box, or use your own file.`
        : 'This building has no name or Wikidata tag in OpenStreetMap to search by: type what it is in the box, or use your own file.';
  list.replaceChildren(...rows);
  list.hidden = !rows.length;
  showSketchfabForget();
}

// One search result: thumbnail (if any), name linking to its page, license and the rest.
function resultRow(
  r: { source: string; name: string; pageUrl: string; license: string; restricted: boolean; author: string; size: string; how: string; thumbnail?: string },
  use: (row: HTMLLIElement) => void,
): HTMLLIElement {
  const li = document.createElement('li');
  if (r.thumbnail) {
    li.classList.add('with-thumb');
    const img = document.createElement('img');
    img.src = r.thumbnail;
    img.alt = '';
    img.loading = 'lazy';
    li.append(img);
  }
  const name = document.createElement('a');
  name.href = r.pageUrl;
  name.target = '_blank';
  name.rel = 'noopener';
  name.textContent = r.name;
  const button = document.createElement('button');
  button.textContent = 'Use';
  // While this row's model loads, the button cancels it.
  button.addEventListener('click', () => {
    if (modelLoad?.row !== li) return use(li);
    cancelModelLoad();
    $('object-model-status').textContent = 'Cancelled.';
  });
  const meta = document.createElement('span');
  meta.className = 'meta';
  const source = document.createElement('span');
  source.className = 'source';
  source.textContent = `${r.source} · `;
  const license = document.createElement('span');
  license.className = r.restricted ? 'restricted' : '';
  license.textContent = r.license;
  meta.append(source, license, ` · ${[r.author, r.size, r.how].filter(Boolean).join(' · ')}`);
  li.append(name, button, meta);
  return li;
}

// Sketchfab downloads need the user's own account: their API token, asked for once.
let pendingSketchfab: (() => void) | null = null;
$('sketchfab-token-save').addEventListener('click', async () => {
  const token = $<HTMLInputElement>('sketchfab-token').value.trim();
  if (!token) return;
  const { setSketchfabToken } = await import('./sketchfab');
  setSketchfabToken(token);
  $<HTMLInputElement>('sketchfab-token').value = '';
  $('sketchfab-login').hidden = true;
  pendingSketchfab?.();
  pendingSketchfab = null;
});
$('sketchfab-forget').addEventListener('click', async () => {
  const { setSketchfabToken } = await import('./sketchfab');
  setSketchfabToken(null);
  showSketchfabForget();
  $('object-model-status').textContent = 'Your Sketchfab token is no longer kept in this browser.';
});
const AXES = ['y', 'z', 'x'] as const;
$('object-model-turn').addEventListener('click', () => changeModel((m) => ({ ...m, turns: (m.turns + 1) % 4 })));
$('object-model-up').addEventListener('click', () => changeModel((m) => ({ ...m, up: AXES[(AXES.indexOf(m.up) + 1) % AXES.length], turns: 0 })));
$('object-model-remove').addEventListener('click', () => {
  if (!picked) return;
  const { model: _, ...rest } = edits.get(picked.key) ?? {};
  edits.set(picked.key, rest);
  refreshModel(picked.key);
});
$('object-reset').addEventListener('click', () => {
  if (!picked) return;
  edits.delete(picked.key);
  viewer?.setEdits(edits);
  showPick(picked);
  showEditsSummary();
});
$('restore-deleted').addEventListener('click', () => {
  // Back as they were before: size, height and 3D model kept through the delete.
  for (const [key, edit] of edits) {
    if (!edit.deleted && !edit.noTrees) continue;
    const { deleted: _, noTrees: __, ...rest } = edit;
    if (Object.keys(rest).length) edits.set(key, rest);
    else edits.delete(key);
  }
  viewer?.setEdits(edits);
  showEditsSummary();
});
// Everything back to how it was fetched: edits and both height multipliers.
$('reset-all').addEventListener('click', () => {
  edits.clear();
  $<HTMLInputElement>('terrain-scale').value = '1.5';
  $<HTMLInputElement>('height-scale').value = '1';
  showScales();
  viewer?.select(null);
  viewer?.setEdits(edits);
  viewer?.setScales(scales());
  updatePrintPreview();
  showEditsSummary();
});
window.addEventListener('keydown', (e) => {
  if (!picked || (e.target as HTMLElement).closest('input, textarea')) return;
  if (e.key === 'Delete' || e.key === 'Backspace') deletePicked();
  else if (e.key === 'Escape') viewer?.select(null);
});

map.on('error', (e) => console.error('Map error', e.error));

map.on('load', () => {
  draw = new DrawController(map, showTool, (sel, final) => {
    // Data fetched for the old shape no longer matches.
    if (sel !== selection) resetData();
    selection = sel;
    showSelection(sel);
    if (final) saveSelection(sel);
  }, (message) => (message ? ($('tool-hint').textContent = message) : showTool(draw?.activeTool ?? null)));

  const saved = loadSelection();
  preview = new DataPreview(map, 'selection-fill');
  if (saved) {
    selection = saved;
    draw.show(saved);
    showSelection(saved);
    // Only jump to the saved area when the URL doesn't already say where to look.
    if (!location.hash) map.fitBounds(describe(saved).bbox as [number, number, number, number], { padding: 80, duration: 0 });
  }
});

function showTool(tool: ShapeKind | null) {
  toolButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.tool === tool));
  $('tool-hint').textContent = tool ? `${HINTS[tool]} Esc to cancel.` : 'Pick a shape, then drag on the map.';
}

function showSelection(sel: Selection | null) {
  $('selection').hidden = !sel;
  if (!sel) return;
  const info = describe(sel);
  const rows: [string, string][] = [
    ['Shape', SHAPE_NAMES[sel.kind]],
    ['Size', `${formatLength(info.widthM)} × ${formatLength(info.heightM)}`],
    ['Area', formatArea(info.areaM2)],
  ];
  if (sel.kind === 'hexagon' || sel.kind === 'circle') rows.splice(2, 0, ['Radius', formatLength(sel.halfWidth)]);
  rows.push(['Rotation', `${Math.round(((sel.rotation % 360) + 360) % 360)}°`]);
  rows.push(['Center', `${sel.center[1].toFixed(5)}, ${sel.center[0].toFixed(5)}`]);
  $('selection-info').replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }),
  );
  $('selection-warning').hidden = info.areaM2 <= LARGE_AREA_M2;
}

function formatLength(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

function formatArea(m2: number): string {
  return m2 < 1e6 ? `${(m2 / 1e4).toFixed(1)} ha` : `${(m2 / 1e6).toFixed(2)} km²`;
}

async function fetchData(sel: Selection) {
  // Counted from the base map before the preview of old data (which hides it) is cleared.
  const info = describe(sel);
  const etaInput: EtaInput = { km2: info.areaM2 / 1e6, buildings: countBuildings(map, info.ring) };
  resetData();
  const controller = new AbortController();
  loading = controller;
  $('fetch').textContent = 'Cancel';
  $('data').hidden = false;
  const status = $('data-status');
  status.classList.remove('error');
  status.textContent = 'Loading map data…';
  $('data-progress').hidden = false;
  // Re-render every second too, so a slow server shows a running clock instead of looking stuck.
  const wait: ServerWait = { since: Date.now(), eta: estimateSeconds(etaInput) };
  let last: FetchProgress = { osmBytes: 0, osmCached: false, osmDone: false };
  const render = () => showProgress(last, wait);
  render();
  const clock = setInterval(render, 1000);
  try {
    const data = await fetchAreaData(
      sel,
      controller.signal,
      (p) => {
        last = p;
        render();
      },
      // The quick version from the map tiles: usable right away, replaced when the full one lands.
      (quick) => {
        status.textContent = 'Quick version from the map tiles. Roofs, colors, trees and walls are on their way.';
        showData(quick);
      },
    );
    $('data-progress').hidden = true;
    status.textContent = '';
    // Teach the estimate how long a single request really took (cache hits, chunked
    // requests and waits for the server say nothing clean about one request).
    if (!last.osmCached && wait.doneAt && last.chunks?.length === 1 && !wait.waited) {
      // The same building count the estimate uses: the quick data's.
      recordSample({ km2: last.chunks[0].km2, buildings: last.chunks[0].buildings }, (wait.doneAt - wait.since) / 1000);
    }
    showData(data);
  } catch (err) {
    if (controller.signal.aborted) {
      // Cancelled, or replaced by a new selection: resetData() already tidied up.
      if (loading === controller) resetData();
      return;
    }
    console.error('Fetching 3D data failed', err);
    $('data-progress').hidden = true;
    status.classList.add('error');
    status.textContent = areaData
      ? `Detailed data failed (${(err as Error).message}): showing the quick version from the map tiles. Fetch again in a minute for roofs, colors, trees and walls.`
      : `${(err as Error).message}. Try again in a minute.`;
  } finally {
    clearInterval(clock);
    if (loading === controller) {
      loading = null;
      $('fetch').textContent = 'Fetch 3D data';
    }
  }
}

function resetData() {
  loading?.abort();
  loading = null;
  close3d();
  areaData = null;
  edits.clear();
  showEditsSummary();
  $('open-3d').hidden = true;
  $('fetch').textContent = 'Fetch 3D data';
  preview?.clear();
  $('data').hidden = true;
  $('data-progress').hidden = true;
  $('data-layers').replaceChildren();
  $('data-terrain').textContent = '';
}

// Also called a second time when the full version replaces the quick one: layers the user
// switched off stay off, and an open 3D view updates in place.
function showData(data: AreaData) {
  const replacing = areaData !== null;
  areaData = data;
  preview?.show(data);
  // Only layers that had something to show can have been switched off.
  const hidden = new Set(replacing ? [...shownLayers].filter((l) => !visibleLayers.has(l)) : []);
  visibleLayers.clear();
  shownLayers.clear();
  $('open-3d').hidden = false;
  $('data-layers').replaceChildren(
    ...summarize(data).map(({ layer, label, count, detail }) => {
      const li = document.createElement('li');
      li.classList.toggle('empty', count === 0);
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !hidden.has(layer);
      box.disabled = count === 0;
      if (count) shownLayers.add(layer);
      if (count && box.checked) visibleLayers.add(layer);
      else preview?.setVisible(layer, false);
      box.addEventListener('change', () => {
        if (box.checked) visibleLayers.add(layer);
        else visibleLayers.delete(layer);
        preview?.setVisible(layer, box.checked);
        viewer?.setLayerVisible(layer, box.checked);
        updatePrintPreview();
      });
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = LAYER_COLORS[layer];
      const name = document.createElement('span');
      name.textContent = label;
      const num = document.createElement('span');
      num.className = 'count';
      num.textContent = count.toLocaleString();
      const label_ = document.createElement('label');
      label_.append(box, swatch, name, num);
      if (detail && count) {
        const sub = document.createElement('span');
        sub.className = 'detail';
        sub.textContent = detail;
        label_.append(sub);
      }
      li.append(label_);
      return li;
    }),
  );
  const t = data.terrain;
  const midLat = (t.bbox[1] + t.bbox[3]) / 2;
  const spacing = distance([t.bbox[0], midLat], [t.bbox[2], midLat]) / t.width;
  // With sea depths, the deepest point there too, and their source.
  const deepest = data.bathymetry ? data.bathymetry.heights.reduce((low, h) => (Number.isFinite(h) && h < low ? h : low), 0) : 0;
  const sea = deepest < 0 ? ` Sea down to ${Math.round(-deepest)} m (EMODnet Bathymetry, CC BY 4.0).` : '';
  // Which heights: national LiDAR where there is some, else the worldwide tiles.
  const from = t.source ? `${t.source.name}, ≈${t.source.resolutionM.toFixed(1)} m` : `AWS Terrain Tiles, ≈${spacing.toFixed(0)} m`;
  $('data-terrain').textContent = `Terrain ${Math.round(t.min)}–${Math.round(t.max)} m above sea level, ${t.width}×${t.height} grid (${from}).${sea}`;
  if (replacing) viewer?.show(data, visibleLayers, scales(), { keepCamera: true, edits });
  showExport();
  updatePrintPreview();
  showSelectHint();
}

// Which Overpass server we're waiting on, and since when (reset when it moves to a mirror).
interface ServerWait {
  server?: string;
  previous?: string;
  since: number;
  // Expected seconds for the whole OSM download (all chunks), and when it actually arrived.
  eta: number;
  doneAt?: number;
  // Set once the chunk plan is known and the estimate has been redone per chunk.
  planned?: boolean;
  chunk?: number;
  // Whether any wait for a slot or a back-off happened: those samples don't teach the ETA.
  waited?: boolean;
}

function showProgress(p: FetchProgress, wait: ServerWait) {
  // Once the chunks are planned, the estimate is the sum over them (each is one request).
  if (p.chunks && !wait.planned) {
    wait.planned = true;
    wait.eta = p.chunks.reduce((sum, c) => sum + estimateSeconds({ km2: c.km2, buildings: c.buildings }), 0);
  }
  // Each part starts fresh: "server X was busy" is about the part being requested.
  if (p.chunk !== wait.chunk) {
    wait.chunk = p.chunk;
    wait.previous = undefined;
    wait.server = p.osmServer;
  }
  if (p.osmServer && p.osmServer !== wait.server) {
    wait.previous = wait.server;
    wait.server = p.osmServer;
  }
  if (p.osmWaitS) wait.waited = true;
  if (p.osmDone && !wait.doneAt) wait.doneAt = Date.now();
  const seconds = Math.round((Date.now() - wait.since) / 1000);
  const many = (p.chunks?.length ?? 1) > 1;
  const part = many ? `Part ${p.chunk} of ${p.chunks!.length}. ` : '';
  const fraction = many ? ((p.chunk ?? 1) - 1) / p.chunks!.length : 0;
  if (p.osmDone) {
    setBar('progress-osm', p.osmCached ? 'From cache' : 'Done', 1, '');
  } else if (!wait.planned) {
    // The parts are planned from the quick data, a second or two in.
    setBar('progress-osm', 'Preparing the request…', null, '');
  } else if (p.osmWaitS) {
    // Refused or no free slot: waiting, as the server asks, before trying again.
    const note = `${part}${wait.server ?? 'The server'} is at capacity; trying again in ${p.osmWaitS} s.`;
    setBar('progress-osm', `Waiting for the server… ${formatDuration(seconds)}`, many ? fraction : null, note);
  } else if (p.osmBytes && !many) {
    // The server doesn't say how big the answer is: count the bytes instead of a percentage.
    setBar('progress-osm', `Downloading ${formatBytes(p.osmBytes)}`, null, `from ${wait.server}`);
  } else if (seconds < wait.eta) {
    // Fills toward the estimate but never claims to be finished before the data arrives.
    const note = wait.previous
      ? `${part}${wait.previous} was busy, now asking ${wait.server}.`
      : `${part}${wait.server ?? 'The server'} is collecting every feature in the area.`;
    setBar('progress-osm', `About ${formatDuration(wait.eta - seconds)} left`, Math.min(Math.max(seconds / wait.eta, fraction), 0.95), note);
  } else {
    const note = `${part}${wait.server ?? 'The server'} is busier than usual.`;
    setBar('progress-osm', `Taking longer than usual… ${formatDuration(seconds)}`, many ? fraction : null, note);
  }
}

// `fraction` null = unknown length: the bar animates instead of filling.
function setBar(id: string, text: string, fraction: number | null, note: string) {
  const row = $(id);
  row.querySelector('.progress-text')!.textContent = text;
  row.querySelector('.progress-note')!.textContent = note;
  row.classList.toggle('busy', fraction === null);
  row.classList.toggle('done', fraction === 1);
  (row.querySelector('.bar > div') as HTMLElement).style.width = fraction === null ? '' : `${fraction * 100}%`;
}

function formatDuration(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

function formatBytes(n: number): string {
  return n < 1e6 ? `${Math.round(n / 1e3)} kB` : `${(n / 1e6).toFixed(1)} MB`;
}

// Three.js is loaded only when the 3D view is first opened.
async function open3d() {
  if (!areaData || viewer) return;
  const button = $<HTMLButtonElement>('open-3d');
  button.disabled = true;
  button.textContent = 'Building 3D view…';
  try {
    const { Viewer } = await import('./viewer/viewer');
    document.body.classList.add('mode-3d');
    $('viewer').hidden = false;
    viewer = new Viewer($('viewer'), showPick);
    viewer.show(areaData, visibleLayers, scales(), { edits });
    showExport();
    showSelectHint();
    showEditsSummary();
  } catch (err) {
    console.error('3D view failed', err);
    close3d();
    $('data-status').classList.add('error');
    $('data-status').textContent = `The 3D view failed to start: ${(err as Error).message}`;
  } finally {
    button.disabled = false;
    button.textContent = 'Open 3D view';
  }
}

function close3d() {
  setPrintPreview(false);
  viewer?.dispose();
  viewer = null;
  showExport();
  showPick(null);
  $('viewer').hidden = true;
  document.body.classList.remove('mode-3d');
}

function scales(): ViewScales {
  return {
    terrain: Number($<HTMLInputElement>('terrain-scale').value),
    heights: Number($<HTMLInputElement>('height-scale').value),
  };
}

function showScales() {
  const { terrain, heights } = scales();
  $('terrain-scale-value').textContent = `×${terrain.toFixed(1)}`;
  $('height-scale-value').textContent = `×${heights.toFixed(1)}`;
}

function deletePicked() {
  if (!picked) return;
  // The other edits stay, for Restore deleted. A wood loses its trees, not itself.
  edits.set(picked.key, { ...edits.get(picked.key), ...(picked.forest ? { noTrees: true } : { deleted: true }) });
  viewer?.setEdits(edits);
  viewer?.select(null);
  showEditsSummary();
}

let shownModelKey: string | null = null;
function showPick(pick: ObjectPick | null) {
  picked = pick;
  $('object-edit').hidden = !pick;
  if (!pick) return;
  $('object-title').textContent = pick.title;
  $('object-info').textContent = pick.info;
  $('object-size-row').hidden = !pick.canSize;
  $('object-height-row').hidden = !pick.canHeight;
  const e = edits.get(pick.key);
  $<HTMLInputElement>('object-size').value = String(e?.scale ?? 1);
  $<HTMLInputElement>('object-height').value = String(e?.heightScale ?? 1);
  if (pick.key !== shownModelKey) {
    // Another object: its own search, not the last one's.
    shownModelKey = pick.key;
    modelSearch?.abort();
    $('object-model-results').hidden = true;
    $('sketchfab-login').hidden = true;
    pendingSketchfab = null;
    $<HTMLInputElement>('model-search').value = '';
    $('model-search-form').hidden = true;
    $('object-model-status').textContent = '';
  }
  // Buildings drawn over each other in OSM: the others here, one click away.
  const also = $('object-also');
  also.replaceChildren();
  also.hidden = !pick.alsoHere?.length;
  if (pick.alsoHere?.length) {
    also.append('Also here: ');
    pick.alsoHere.forEach((o, i) => {
      const link = document.createElement('button');
      link.className = 'link';
      link.textContent = o.title;
      link.addEventListener('click', () => viewer?.select(o.key));
      also.append(...(i ? [', ', link] : [link]));
    });
  }
  $('object-delete').textContent = pick.forest ? 'Delete trees' : 'Delete';
  $('object-width-row').hidden = !pick.canWidth;
  $<HTMLInputElement>('object-width').value = String(e?.width ?? 1);
  $('object-ground-row').hidden = !pick.ground;
  if (pick.ground) $<HTMLSelectElement>('object-ground').value = pick.ground;
  $('object-model').hidden = !pick.canModel;
  $('object-model-current').hidden = !pick.model;
  $('object-model-name').textContent = pick.model ?? '';
  showModelFit(pick);
  $('object-model-upload').textContent = pick.model ? 'Use another 3D model…' : 'Replace with a 3D model…';
  showPickValues();
}

// Model files are read in a worker (model-worker.ts): a big scan takes seconds.
function readModelInWorker(data: ArrayBuffer, name: string, source: ModelSource, signal?: AbortSignal): Promise<ModelAsset> {
  const worker = new Worker(new URL('./model-worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    // Cancelled: the worker stops where it is.
    signal?.addEventListener('abort', () => {
      worker.terminate();
      reject(signal.reason);
    });
    worker.onmessage = (e: MessageEvent<ModelResult>) => {
      worker.terminate();
      if (e.data.ok) resolve(e.data.asset);
      else reject(new Error(e.data.message));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'reading the file stopped'));
    };
    const job: ModelJob = { data, name, source };
    worker.postMessage(job, [data]);
  });
}

// The model on its object: shown at once if that's still selected, else just placed (the
// download may have outlived the selection).
function useModel(key: string, asset: ModelAsset) {
  modelAssets.set(asset.id, asset);
  edits.set(key, { ...edits.get(key), model: { asset: asset.id, up: viewer?.suggestModelUp(key, asset) ?? asset.up, turns: 0 } });
  if (picked?.key === key) refreshModel(key);
  else {
    viewer?.setEdits(edits);
    showEditsSummary();
  }
}

// A message about a model for an object: in its card if it's selected, else in the line at
// the top right.
function sayModel(key: string, text: string) {
  if (picked?.key === key) $('object-model-status').textContent = text;
  else modelTask.say(text);
}

async function showSketchfabForget() {
  const { sketchfabToken } = await import('./sketchfab');
  $('sketchfab-forget').hidden = !sketchfabToken();
}

// The model download in progress (one at a time: using another cancels it).
let modelLoad: { row: HTMLLIElement; abort: AbortController } | null = null;
function cancelModelLoad() {
  modelLoad?.abort.abort();
  modelLoad = null;
}

async function useSketchfabModel(key: string, m: SketchfabModel, row: HTMLLIElement) {
  const { sketchfabToken, setSketchfabToken, downloadSketchfab, TokenRejected } = await import('./sketchfab');
  const status = $('object-model-status');
  const target = picked?.title ?? 'the building';
  const token = sketchfabToken();
  if (!token) {
    pendingSketchfab = () => useSketchfabModel(key, m, row);
    $('sketchfab-login').hidden = false;
    $('sketchfab-login').scrollIntoView({ block: 'nearest' });
    $<HTMLInputElement>('sketchfab-token').focus();
    status.textContent = `To download ${m.name}, Sketchfab needs you logged in.`;
    return;
  }
  status.textContent = '';
  const bar = modelProgress(row, m.name, target);
  try {
    const file = await downloadSketchfab(m.uid, token, bar.bytes, bar.signal);
    bar.reading();
    const source = { kind: 'sketchfab' as const, title: m.name, url: m.pageUrl, license: m.license, author: m.author };
    useModel(key, await readModelInWorker(file.data, file.name, source, bar.signal));
    if (picked?.key === key) $('object-model-results').hidden = true;
    bar.done();
    sayModel(key, `${m.name} is on ${target}. ${m.license} by ${m.author}: the export credits it.`);
    showSketchfabForget();
  } catch (err) {
    if (bar.signal.aborted) return;
    if (err instanceof TokenRejected) {
      // A wrong or revoked token: forget it and ask again.
      setSketchfabToken(null);
      if (picked?.key !== key) return modelTask.say('Sketchfab didn\'t accept your token: select the building again to paste it.');
      pendingSketchfab = () => useSketchfabModel(key, m, row);
      $('sketchfab-login').hidden = false;
      $('sketchfab-login').scrollIntoView({ block: 'nearest' });
      status.textContent = 'Sketchfab didn\'t accept that token. Paste it again (Password & API in your Sketchfab settings).';
      showSketchfabForget();
      return;
    }
    sayModel(key, `Couldn't use ${m.name}: ${(err as Error).message}`);
  } finally {
    bar.end();
  }
}

async function useCommonsModel(key: string, m: CommonsModel, row: HTMLLIElement) {
  const target = picked?.title ?? 'the building';
  $('object-model-status').textContent = '';
  const bar = modelProgress(row, m.name, target);
  try {
    const { fetchWithProgress } = await import('./sketchfab');
    const data = await fetchWithProgress(m.url, bar.bytes, bar.signal);
    bar.reading();
    const source = { kind: 'commons' as const, title: m.name, url: m.pageUrl, license: m.license, author: m.author };
    useModel(key, await readModelInWorker(data, m.title, source, bar.signal));
    if (picked?.key === key) $('object-model-results').hidden = true;
    bar.done();
    sayModel(key, `${m.name} is on ${target}. ${m.license} by ${m.author}: the export credits it.`);
  } catch (err) {
    if (bar.signal.aborted) return;
    sayModel(key, `Couldn't use ${m.name}: ${(err as Error).message}`);
  } finally {
    bar.end();
  }
}

// A bar inside the clicked result while its model downloads (then reads, in the
// background): right where the click was, even far down a scrolled list.
let progressRows = 0;
function modelProgress(row: HTMLLIElement, name: string, target: string) {
  const id = `model-progress-${++progressRows}`;
  const bar = document.createElement('div');
  bar.className = 'progress';
  bar.id = id;
  bar.innerHTML = '<div class="progress-head"><span class="progress-label">Downloading</span><span class="progress-text"></span></div><div class="bar"><div></div></div><p class="progress-note"></p>';
  row.append(bar);
  // One download at a time: this one replaces any other.
  cancelModelLoad();
  const load = (modelLoad = { row, abort: new AbortController() });
  const button = row.querySelector('button')!;
  button.textContent = 'Cancel';
  setBar(id, '', null, '');
  bar.scrollIntoView({ block: 'nearest' });
  modelTask.show(`Downloading ${name} for ${target}…`);
  return {
    bytes: (bytes: number, total?: number) => {
      const amount = total ? `${formatBytes(bytes)} of ${formatBytes(total)}` : formatBytes(bytes);
      setBar(id, amount, total ? bytes / total : null, '');
      modelTask.show(`Downloading ${name} for ${target}: ${amount}`);
    },
    reading: () => {
      bar.querySelector('.progress-label')!.textContent = 'Reading';
      setBar(id, '', null, 'Big models are simplified to what a print can hold.');
      modelTask.show(`Reading ${name} for ${target}…`);
    },
    signal: load.abort.signal,
    // Placed: the line's message follows (sayModel), not the progress.
    done: () => modelTask.hide(),
    // Done, failed or cancelled: the row as it was.
    end: () => {
      bar.remove();
      button.textContent = 'Use';
      if (modelLoad === load) {
        modelLoad = null;
        if (!modelTask.saying) modelTask.hide();
      }
    },
  };
}

// The line at the top right about a model download: it goes on whatever is selected
// meanwhile, and its Cancel works from anywhere.
const modelTask = (() => {
  const line = $('model-task');
  const text = $('model-task-text');
  const cancel = $('model-task-cancel');
  let timer: number | undefined;
  const api = {
    saying: false,
    show(t: string) {
      clearTimeout(timer);
      api.saying = false;
      text.textContent = t;
      cancel.hidden = false;
      line.hidden = false;
    },
    // A message that fades after a while (no Cancel: nothing is running).
    say(t: string) {
      api.show(t);
      api.saying = true;
      cancel.hidden = true;
      timer = window.setTimeout(api.hide, 8000);
    },
    hide() {
      clearTimeout(timer);
      api.saying = false;
      line.hidden = true;
    },
  };
  cancel.addEventListener('click', () => {
    cancelModelLoad();
    api.say('Download cancelled.');
  });
  return api;
})();

function changeModel(change: (m: ModelChoice) => ModelChoice) {
  const e = picked && edits.get(picked.key);
  if (!picked || !e?.model) return;
  edits.set(picked.key, { ...e, model: change(e.model) });
  refreshModel(picked.key);
}

// After a model change: rebuild, and show the selected building's card again.
function refreshModel(key: string) {
  viewer?.setEdits(edits);
  viewer?.select(key);
  showEditsSummary();
}

// How the model came out fitted to the footprint, against the building's height: far off,
// it likely shows more than this building (a whole square) or only part of it.
const FIT_TOLERANCE = 1.6;
function showModelFit(pick: ObjectPick) {
  const line = $('object-model-fit');
  const f = pick.modelFit;
  line.classList.remove('warning');
  line.replaceChildren();
  if (!f) return;
  const m = (v: number) => `${Math.round(v)} m`;
  // As it stands now: fitted, then Size and Height.
  const e = edits.get(pick.key);
  const height = f.height * (e?.scale ?? 1) * (e?.heightScale ?? 1);
  // Bridges and the like have no height in OSM to compare with.
  if (!f.building) {
    line.append(`${m(height)} tall.`);
    return;
  }
  const building = f.building;
  const off = Math.max(height / building, building / height) > FIT_TOLERANCE;
  if (f.known && off) {
    line.classList.add('warning');
    const why =
      height < building
        ? 'its outline seen from above is wider than the building: a base or a square around it, a lean, or a whole scene'
        : 'it may show only part of the building, or something else';
    line.append(`It's ${m(height)} tall, but this building is ${m(building)}: ${why}. `);
    // One click to the building's height (Size scales it evenly, so the footprint follows).
    const fix = document.createElement('button');
    fix.className = 'link';
    fix.textContent = `Make it ${m(building)} tall`;
    fix.addEventListener('click', () => {
      const now = edits.get(pick.key);
      if (!now) return;
      edits.set(pick.key, { ...now, scale: Math.round((building / f.height) * 100) / 100, heightScale: 1 });
      refreshModel(pick.key);
    });
    line.append(fix, ', or try another model.');
  } else {
    line.append(`${m(height)} tall (OpenStreetMap ${f.known ? 'says' : 'estimates'} ${m(building)}).`);
  }
}

function showPickValues() {
  $('object-size-value').textContent = `×${Number($<HTMLInputElement>('object-size').value).toFixed(1)}`;
  $('object-height-value').textContent = `×${Number($<HTMLInputElement>('object-height').value).toFixed(1)}`;
  $('object-width-value').textContent = `×${Number($<HTMLInputElement>('object-width').value).toFixed(2)}`;
}

function showEditsSummary() {
  let deleted = 0;
  let changed = 0;
  let models = 0;
  for (const e of edits.values()) {
    if (e.deleted || e.noTrees) deleted++;
    else {
      if ((e.scale ?? 1) !== 1 || (e.heightScale ?? 1) !== 1 || (e.width ?? 1) !== 1 || e.ground) changed++;
      if (e.model) models++;
    }
  }
  const parts = [deleted && `${deleted} deleted`, changed && `${changed} changed`, models && `${models} with a 3D model`].filter(Boolean);
  $('edits-count').textContent = parts.length ? parts.join(', ') : 'No edits';
  $<HTMLButtonElement>('restore-deleted').disabled = !deleted;
  const defaults = scales().terrain === 1.5 && scales().heights === 1;
  $<HTMLButtonElement>('reset-all').disabled = !edits.size && defaults;
}

// Selecting waits for the detailed data (see Viewer.canSelect).
function showSelectHint() {
  $('select-hint').textContent = printPreview
    ? 'Editing is paused while you preview the export.'
    : viewer?.canSelect
      ? 'Click a building, tree, bridge, street, river or park to edit it.'
      : 'Selecting and editing become available when the detailed data arrives.';
}

// Print settings have a minimum and no maximum; a value below the minimum is refused, not
// clamped, so what's printed is always what the field says.
class SettingError extends Error {}
// One step up or down: by 0.1 from 0.1 up (to the next tenth), by 0.01 below.
function fineStep(v: number, dir: number): number {
  const EPS = 1e-9;
  // Two decimals, so 0.7 + 0.1 shows as 0.8, not 0.7999999999999999.
  const round = (x: number) => Math.round(x * 100) / 100;
  if (dir > 0) return round(v < 0.1 - EPS ? v + 0.01 : Math.floor(v * 10 + EPS) / 10 + 0.1);
  if (v > 0.1 + EPS) return round(Math.max(0.1, Math.ceil(v * 10 - EPS) / 10 - 0.1));
  return round(v - 0.01);
}

function printNumber(id: string, label: string, min: number): number {
  const v = Number($<HTMLInputElement>(id).value);
  if (!Number.isFinite(v) || v < min) throw new SettingError(`${label} must be at least ${min} mm.`);
  return v;
}

function failure(what: string, err: unknown): string {
  return err instanceof SettingError ? err.message : `${what} failed: ${(err as Error).message}`;
}

// The print is built in a worker (see print-worker.ts), so the page stays responsive. The
// preview has its own, ended when a newer preview is asked for; a download gets a fresh one.
let previewWorker: Worker | null = null;
function runPrintJob(kind: PrintJob['kind'], data: AreaData, own?: (w: Worker) => void, previewed?: PrintJob['previewed']): Promise<{ result: Extract<PrintResult, { ok: true }>; nozzle: number; minFeatureMm: number }> {
  const options = {
    sizeMm: printNumber('print-size', 'Longest side', 1),
    baseMm: printNumber('print-base', 'Base thickness', 1),
    minFeatureMm: printNumber('print-min', 'Thinnest detail', 0.01),
  };
  const nozzleMm = printNumber('print-nozzle', 'Nozzle', 0.1);
  const [lng, lat] = data.selection.center;
  const models = [...edits.values()].flatMap((e) => (e.model && modelAssets.has(e.model.asset) ? [modelAssets.get(e.model.asset)!] : []));
  const job: PrintJob = { kind, data, edits, scales: scales(), visible: [...visibleLayers], options, nozzleMm, name: printName(lat, lng), models, previewed };
  const worker = new Worker(new URL('./print-worker.ts', import.meta.url), { type: 'module' });
  own?.(worker);
  const bar = printProgress.start(worker);
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<PrintResult | PrintProgress>) => {
      if ('progress' in e.data) return bar.update(e.data);
      worker.terminate();
      bar.end();
      if (e.data.ok) resolve({ result: e.data, nozzle: nozzleMm, minFeatureMm: options.minFeatureMm });
      else reject(new Error(e.data.message));
    };
    worker.onerror = (e) => {
      worker.terminate();
      bar.end();
      reject(new Error(e.message || 'the build stopped'));
    };
    worker.postMessage(job);
  });
}

// The progress bar under the export buttons, for the print job that started last. It shows
// only once a job has run a second: quick ones finish without it flashing up.
const PROGRESS_AFTER_MS = 1000;
const printProgress = (() => {
  let current: Worker | null = null;
  let timer: number | undefined;
  let since = 0;
  const row = $('print-progress');
  const hide = () => {
    clearTimeout(timer);
    row.hidden = true;
  };
  return {
    start(worker: Worker) {
      hide();
      current = worker;
      since = Date.now();
      setBar('print-progress', '', 0, '');
      row.querySelector('.progress-label')!.textContent = 'Starting';
      timer = window.setTimeout(() => current === worker && (row.hidden = false), PROGRESS_AFTER_MS);
      return {
        update: ({ progress, label }: PrintProgress) => {
          if (current !== worker) return;
          row.querySelector('.progress-label')!.textContent = label;
          setBar('print-progress', `${Math.round(progress * 100)}% · ${formatDuration((Date.now() - since) / 1000)}`, progress, '');
        },
        end: () => {
          if (current !== worker) return;
          current = null;
          hide();
        },
      };
    },
    // A job ended from outside (a newer preview, or the preview switched off).
    cancel(worker: Worker | null) {
      if (worker && current === worker) {
        current = null;
        hide();
      }
    },
  };
})();

function printName(lat: number, lng: number): string {
  return `map2stl-${lat.toFixed(4)}-${lng.toFixed(4)}`;
}

// What in the model is too thin for the nozzle, under the Preview button.
function showThinWarning(thin: ThinObjects, nozzle: number, minFeatureMm: number) {
  const warning = $('print-warning');
  const total = thin.counts.reduce((n, [, c]) => n + c, 0);
  const list = thin.counts.map(([name, c]) => `${c.toLocaleString()} ${name.toLowerCase()}`).join(', ');
  const below = minFeatureMm < nozzle ? ` Thinnest detail is below the nozzle width: set it to at least ${nozzle} mm.` : '';
  warning.textContent = total
    ? `${total.toLocaleString()} ${total === 1 ? 'object is' : 'objects are'} narrower than the ${nozzle} mm nozzle (${list}), shown in red in the preview: they may print as blobs, or not at all. Make the model bigger, or enlarge or delete them.${below}`
    : below.trim();
  warning.hidden = !warning.textContent;
}

function setPrintPreview(on: boolean) {
  printPreview = on && !!viewer;
  const button = $('preview-print');
  button.setAttribute('aria-pressed', String(printPreview));
  button.textContent = printPreview ? 'Back to the 3D view' : 'Preview export';
  // The file comes from the model previewed: only in the preview.
  $('export-files').hidden = !printPreview;
  previewed = null;
  if (!printPreview) {
    printProgress.cancel(previewWorker);
    previewWorker?.terminate();
    previewWorker = null;
    viewer?.showPrint(null);
    $('export-status').textContent = '';
  }
  showSelectHint();
  updatePrintPreview();
}

// Rebuilds the preview, if it's on: a build still running for older settings is ended.
// The model the preview shows, kept for the download: the same settings, already built.
let previewed: { model: PrintModel; thin: ThinObjects; nozzle: number; minFeatureMm: number } | null = null;

async function updatePrintPreview() {
  if (!printPreview || !viewer || !areaData) return;
  printProgress.cancel(previewWorker);
  previewWorker?.terminate();
  // Settings changed: the download waits for the new preview.
  previewed = null;
  $<HTMLButtonElement>('download').disabled = true;
  const status = $('export-status');
  status.textContent = 'Building the preview…';
  let mine: Worker | null = null;
  try {
    const { result, nozzle, minFeatureMm } = await runPrintJob('preview', areaData, (w) => (previewWorker = mine = w));
    if (previewWorker !== mine || !printPreview) return;
    previewWorker = null;
    viewer?.showPrint(result.model, result.thin, exportFormat === 'stl');
    showThinWarning(result.thin, nozzle, minFeatureMm);
    previewed = { model: result.model, thin: result.thin, nozzle, minFeatureMm };
    $<HTMLButtonElement>('download').disabled = false;
    const [x, y, z] = result.model.sizeMm.map((v) => Math.round(v));
    status.textContent = `${x} × ${y} × ${z} mm · ${result.model.triangleCount.toLocaleString()} triangles.`;
  } catch (err) {
    if (mine && previewWorker !== mine) return;
    if (!(err instanceof SettingError)) console.error('Preview failed', err);
    status.textContent = failure('The preview', err);
  }
}

async function downloadModel() {
  if (!areaData || !previewed) return;
  const button = $<HTMLButtonElement>('download');
  const status = $('export-status');
  button.disabled = true;
  status.textContent = 'Writing the file…';
  try {
    const format = exportFormat;
    // The model previewed: merged and written, not built again.
    const { result } = await runPrintJob(format, areaData, undefined, { model: previewed.model, thin: previewed.thin.counts });
    const file = result.file!;
    const [lng, lat] = areaData.selection.center;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = `${printName(lat, lng)}.${format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    const skipped = result.skipped ?? 0;
    const merged = skipped ? ` · ${skipped.toLocaleString()} ${skipped === 1 ? 'solid' : 'solids'} couldn't be merged and ${skipped === 1 ? 'is' : 'are'} included as ${skipped === 1 ? 'it is' : 'they are'}` : '';
    const [x, y, z] = result.model.sizeMm.map((v) => Math.round(v));
    const credits = result.credits?.length ? ` and ${result.credits.join('; ')}` : '';
    status.textContent = `${x} × ${y} × ${z} mm · ${result.model.triangleCount.toLocaleString()} triangles · ${formatBytes(file.size)}${merged}. Credit "© OpenStreetMap contributors"${credits} when you share it.`;
  } catch (err) {
    if (!(err instanceof SettingError)) console.error('Export failed', err);
    status.textContent = failure('The export', err);
  } finally {
    // Settings changed meanwhile: the new preview must finish first.
    button.disabled = !previewed;
  }
}

// The cards at the top right stop above the export card, however tall it gets (a warning,
// the progress bar): its height, kept in a CSS variable.
new ResizeObserver(() => {
  const card = $('export');
  document.body.style.setProperty('--export-space', card.hidden ? '0px' : `${card.offsetHeight + 12}px`);
}).observe($('export'));

// The export card floats over the 3D view, and only once the detailed data is in: the quick
// tile data has no roofs, trees or walls and isn't worth printing.
function showExport() {
  $('export').hidden = !(viewer && areaData?.detail === 'full');
  if ($('export').hidden && printPreview) setPrintPreview(false);
}
