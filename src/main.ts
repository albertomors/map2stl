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
import { modelAssets, type ModelAsset, type ModelChoice } from './model-assets';
import type { ObjectPick, Viewer, ViewScales } from './viewer/viewer';
import type { Edits } from './edits';
import type { ThinObjects } from './export';
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

// Object editing in the 3D view.
for (const [id, field] of [['object-size', 'scale'], ['object-height', 'heightScale']] as const) {
  let timer: number | undefined;
  // Instant stretch of the lifted object while dragging; rebuild just that object on release.
  $(id).addEventListener('input', () => {
    if (!picked) return;
    edits.set(picked.key, { ...edits.get(picked.key), [field]: Number($<HTMLInputElement>(id).value) });
    showPickValues();
    showEditsSummary();
    viewer?.previewEdit(edits.get(picked.key));
  });
  $(id).addEventListener('change', () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => viewer?.setEdits(edits, { selectedOnly: true }), 0);
  });
}
$('object-delete').addEventListener('click', () => deletePicked());
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
    const { readModelFile } = await import('./model-files');
    useModel(key, await readModelFile(file));
    status.textContent = '';
  } catch (err) {
    status.textContent = `Couldn't use ${file.name}: ${(err as Error).message}`;
  }
});
// Openly licensed models of the landmark on Wikimedia Commons (see commons.ts).
let modelSearch: AbortController | null = null;
$('object-model-find').addEventListener('click', async () => {
  if (!picked) return;
  const { key, landmark } = picked;
  const status = $('object-model-status');
  const list = $('object-model-results');
  modelSearch?.abort();
  const search = (modelSearch = new AbortController());
  list.hidden = true;
  status.textContent = 'Searching Wikimedia Commons…';
  try {
    const { findCommonsModels } = await import('./commons');
    const found = await findCommonsModels(landmark ?? {}, search.signal);
    if (search !== modelSearch || picked?.key !== key) return;
    status.textContent = found.length
      ? 'Openly licensed models on Wikimedia Commons. Check that it is this building before using one.'
      : `No openly licensed 3D model of ${landmark?.name ?? 'this building'} on Wikimedia Commons. You can use your own file instead.`;
    list.replaceChildren(
      ...found.map((m) => {
        const li = document.createElement('li');
        const name = document.createElement('a');
        name.href = m.pageUrl;
        name.target = '_blank';
        name.rel = 'noopener';
        name.textContent = m.name;
        const meta = document.createElement('span');
        meta.className = 'meta';
        const how = { wikidata: 'its Wikidata model', depicts: 'depicts it', name: 'name match' }[m.match];
        meta.textContent = `${m.license} · ${m.author} · ${formatBytes(m.bytes)} · ${how}`;
        const use = document.createElement('button');
        use.textContent = 'Use';
        use.addEventListener('click', () => useCommonsModel(key, m));
        li.append(name, use, meta);
        return li;
      }),
    );
    list.hidden = !found.length;
  } catch (err) {
    if (search.signal.aborted) return;
    status.textContent = `The search failed: ${(err as Error).message}`;
  }
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
  for (const [key, edit] of edits) if (edit.deleted) edits.delete(key);
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
  $('data-terrain').textContent =
    `Terrain ${Math.round(t.min)}–${Math.round(t.max)} m above sea level, ${t.width}×${t.height} grid (≈${spacing.toFixed(0)} m).`;
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
  edits.set(picked.key, { deleted: true });
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
    $('object-model-status').textContent = '';
  }
  $('object-model').hidden = !pick.canModel;
  $('object-model-current').hidden = !pick.model;
  $('object-model-name').textContent = pick.model ?? '';
  $('object-model-upload').textContent = pick.model ? 'Use another 3D model…' : 'Replace with a 3D model…';
  showPickValues();
}

function useModel(key: string, asset: ModelAsset) {
  modelAssets.set(asset.id, asset);
  edits.set(key, { ...edits.get(key), model: { asset: asset.id, up: asset.up, turns: 0 } });
  refreshModel(key);
}

async function useCommonsModel(key: string, m: CommonsModel) {
  const status = $('object-model-status');
  status.textContent = `Downloading ${m.name} (${formatBytes(m.bytes)})…`;
  try {
    const res = await fetch(m.url);
    if (!res.ok) throw new Error(`Commons answered ${res.status}`);
    const { readModel } = await import('./model-files');
    const source = { kind: 'commons' as const, title: m.name, url: m.pageUrl, license: m.license, author: m.author };
    useModel(key, await readModel(await res.arrayBuffer(), m.title, source));
    $('object-model-results').hidden = true;
    status.textContent = `${m.license} by ${m.author}: the export credits it.`;
  } catch (err) {
    status.textContent = `Couldn't use ${m.name}: ${(err as Error).message}`;
  }
}

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

function showPickValues() {
  $('object-size-value').textContent = `×${Number($<HTMLInputElement>('object-size').value).toFixed(1)}`;
  $('object-height-value').textContent = `×${Number($<HTMLInputElement>('object-height').value).toFixed(1)}`;
}

function showEditsSummary() {
  let deleted = 0;
  let changed = 0;
  let models = 0;
  for (const e of edits.values()) {
    if (e.deleted) deleted++;
    else {
      if ((e.scale ?? 1) !== 1 || (e.heightScale ?? 1) !== 1) changed++;
      if (e.model) models++;
    }
  }
  const parts = [deleted && `${deleted} deleted`, changed && `${changed} resized`, models && `${models} with a 3D model`].filter(Boolean);
  $('edits-count').textContent = parts.length ? parts.join(', ') : 'No edits';
  $<HTMLButtonElement>('restore-deleted').disabled = !deleted;
  const defaults = scales().terrain === 1.5 && scales().heights === 1;
  $<HTMLButtonElement>('reset-all').disabled = !edits.size && defaults;
}

// Selecting waits for the detailed data (see Viewer.canSelect).
function showSelectHint() {
  $('select-hint').textContent = printPreview
    ? 'Editing is paused while the print preview is on.'
    : viewer?.canSelect
      ? 'Click a building, tree, bridge or structure to edit it.'
      : 'Selecting and editing become available when the detailed data arrives.';
}

// Print settings have a minimum and no maximum; a value below the minimum is refused, not
// clamped, so what's printed is always what the field says.
class SettingError extends Error {}
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
function runPrintJob(kind: PrintJob['kind'], data: AreaData, own?: (w: Worker) => void): Promise<{ result: Extract<PrintResult, { ok: true }>; nozzle: number; minFeatureMm: number }> {
  const options = {
    sizeMm: printNumber('print-size', 'Longest side', 1),
    baseMm: printNumber('print-base', 'Base thickness', 1),
    minFeatureMm: printNumber('print-min', 'Thinnest detail', 0.01),
  };
  const nozzleMm = printNumber('print-nozzle', 'Nozzle', 0.01);
  const [lng, lat] = data.selection.center;
  const models = [...edits.values()].flatMap((e) => (e.model && modelAssets.has(e.model.asset) ? [modelAssets.get(e.model.asset)!] : []));
  const job: PrintJob = { kind, data, edits, scales: scales(), visible: [...visibleLayers], options, nozzleMm, name: printName(lat, lng), models };
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
  button.textContent = printPreview ? 'Back to the 3D view' : 'Preview print';
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
async function updatePrintPreview() {
  if (!printPreview || !viewer || !areaData) return;
  printProgress.cancel(previewWorker);
  previewWorker?.terminate();
  const status = $('export-status');
  status.textContent = 'Building the preview…';
  let mine: Worker | null = null;
  try {
    const { result, nozzle, minFeatureMm } = await runPrintJob('preview', areaData, (w) => (previewWorker = mine = w));
    if (previewWorker !== mine || !printPreview) return;
    previewWorker = null;
    viewer?.showPrint(result.model, result.thin, exportFormat === 'stl');
    showThinWarning(result.thin, nozzle, minFeatureMm);
    const [x, y, z] = result.model.sizeMm.map((v) => Math.round(v));
    status.textContent = `${x} × ${y} × ${z} mm · ${result.model.triangleCount.toLocaleString()} triangles.`;
  } catch (err) {
    if (mine && previewWorker !== mine) return;
    if (!(err instanceof SettingError)) console.error('Preview failed', err);
    status.textContent = failure('The preview', err);
  }
}

async function downloadModel() {
  if (!areaData) return;
  const button = $<HTMLButtonElement>('download');
  const status = $('export-status');
  button.disabled = true;
  status.textContent = 'Building the model…';
  try {
    const format = exportFormat;
    const { result, nozzle, minFeatureMm } = await runPrintJob(format, areaData);
    showThinWarning(result.thin, nozzle, minFeatureMm);
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
    button.disabled = false;
  }
}

// The export card floats over the 3D view, and only once the detailed data is in: the quick
// tile data has no roofs, trees or walls and isn't worth printing.
function showExport() {
  $('export').hidden = !(viewer && areaData?.detail === 'full');
  if ($('export').hidden && printPreview) setPrintPreview(false);
}
