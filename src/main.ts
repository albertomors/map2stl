import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import './style.css';
import { fetchAreaData, summarize, type AreaData, type FetchProgress } from './area-data';
import { DrawController } from './draw';
import { distance } from './geo';
import { setupNavigation } from './nav';
import { DataPreview, LAYER_COLORS } from './preview';
import { setupSearch } from './search';
import { describe, loadSelection, saveSelection, type Selection, type ShapeKind } from './selection';

// Above this, OSM downloads in dense cities get slow and the print loses detail.
const LARGE_AREA_M2 = 10e6;

const HINTS: Record<ShapeKind, string> = {
  rectangle: 'Drag from one corner to the opposite corner.',
  hexagon: 'Drag from the center outward. Up on screen becomes the flat top.',
  circle: 'Drag from the center outward.',
};

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

map.on('error', (e) => console.error('Map error', e.error));

map.on('load', () => {
  draw = new DrawController(map, showTool, (sel, final) => {
    // Data fetched for the old shape no longer matches.
    if (sel !== selection) resetData();
    selection = sel;
    showSelection(sel);
    if (final) saveSelection(sel);
  });

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
    ['Shape', sel.kind[0].toUpperCase() + sel.kind.slice(1)],
    ['Size', `${formatLength(info.widthM)} × ${formatLength(info.heightM)}`],
    ['Area', formatArea(info.areaM2)],
  ];
  if (sel.kind !== 'rectangle') rows.splice(2, 0, ['Radius', formatLength(sel.halfWidth)]);
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
  resetData();
  const controller = new AbortController();
  loading = controller;
  $('fetch').textContent = 'Cancel';
  $('data').hidden = false;
  const status = $('data-status');
  status.classList.remove('error');
  status.textContent = 'Starting…';
  // Re-render every second too, so a slow server shows a running clock instead of looking stuck.
  const started = Date.now();
  let last: FetchProgress | null = null;
  const render = () => last && (status.textContent = formatProgress(last, (Date.now() - started) / 1000));
  const clock = setInterval(render, 1000);
  try {
    const data = await fetchAreaData(sel, controller.signal, (p) => {
      last = p;
      render();
    });
    status.textContent = '';
    showData(data);
  } catch (err) {
    if (controller.signal.aborted) {
      // Cancelled, or replaced by a new selection: resetData() already tidied up.
      if (loading === controller) resetData();
      return;
    }
    console.error('Fetching 3D data failed', err);
    status.classList.add('error');
    status.textContent = `${(err as Error).message}. Try again in a minute.`;
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
  $('fetch').textContent = 'Fetch 3D data';
  preview?.clear();
  $('data').hidden = true;
  $('data-layers').replaceChildren();
  $('data-terrain').textContent = '';
}

function showData(data: AreaData) {
  preview?.show(data);
  $('data-layers').replaceChildren(
    ...summarize(data).map(({ layer, label, count, detail }) => {
      const li = document.createElement('li');
      li.classList.toggle('empty', count === 0);
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = true;
      box.disabled = count === 0;
      box.addEventListener('change', () => preview?.setVisible(layer, box.checked));
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
}

function formatProgress(p: FetchProgress, seconds: number): string {
  const waiting = `waiting for ${p.osmServer ?? 'server'} (${Math.round(seconds)} s)…`;
  const osm = p.osmDone ? 'done' : p.osmCached ? 'from cache' : p.osmBytes ? formatBytes(p.osmBytes) : waiting;
  const terrain = p.tilesTotal ? `${p.tilesDone}/${p.tilesTotal} tiles` : '…';
  return `OpenStreetMap: ${osm} · Terrain: ${terrain}`;
}

function formatBytes(n: number): string {
  return n < 1e6 ? `${Math.round(n / 1e3)} kB` : `${(n / 1e6).toFixed(1)} MB`;
}
