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
import type { Viewer, ViewScales } from './viewer/viewer';

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
  // Rebuilding takes a moment on big areas: wait until the slider rests.
  let timer: number | undefined;
  $(id).addEventListener('input', () => {
    showScales();
    clearTimeout(timer);
    timer = window.setTimeout(() => viewer?.setScales(scales()), 120);
  });
}
showScales();

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
    // Teach the estimate how long this server really took (cache hits say nothing).
    if (!last.osmCached && wait.doneAt) recordSample(etaInput, (wait.doneAt - wait.since) / 1000);
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
  if (replacing) viewer?.show(data, visibleLayers, scales(), { keepCamera: true });
}

// Which Overpass server we're waiting on, and since when (reset when it moves to a mirror).
interface ServerWait {
  server?: string;
  previous?: string;
  since: number;
  // Expected seconds for the OSM answer, and when it actually arrived.
  eta: number;
  doneAt?: number;
}

function showProgress(p: FetchProgress, wait: ServerWait) {
  if (p.osmServer && p.osmServer !== wait.server) {
    wait.previous = wait.server;
    wait.server = p.osmServer;
    wait.since = Date.now();
  }
  if (p.osmDone && !wait.doneAt) wait.doneAt = Date.now();
  const seconds = Math.round((Date.now() - wait.since) / 1000);
  if (p.osmDone || p.osmCached) {
    setBar('progress-osm', p.osmCached ? 'From cache' : 'Done', 1, '');
  } else if (p.osmBytes) {
    // The server doesn't say how big the answer is: count the bytes instead of a percentage.
    setBar('progress-osm', `Downloading ${formatBytes(p.osmBytes)}`, null, `from ${wait.server}`);
  } else if (seconds < wait.eta) {
    // Fills toward the estimate but never claims to be finished before the data arrives.
    const note = wait.previous
      ? `${wait.previous} was busy, now asking ${wait.server}.`
      : `${wait.server ?? 'The server'} is collecting every feature in the area.`;
    setBar('progress-osm', `About ${formatDuration(wait.eta - seconds)} left`, Math.min(seconds / wait.eta, 0.95), note);
  } else {
    const note = `${wait.server ?? 'The server'} is busier than usual. It gives up after 100 s and the next server is tried.`;
    setBar('progress-osm', `Taking longer than usual… ${formatDuration(seconds)}`, null, note);
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
    viewer = new Viewer($('viewer'));
    viewer.show(areaData, visibleLayers, scales());
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
  viewer?.dispose();
  viewer = null;
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
