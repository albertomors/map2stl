// Everything the 3D model is built from, for one selection: OSM features and terrain.
// The output of milestone 2 and the input of the 3D viewer.

import { depthAt, fetchBathymetry, type Bathymetry } from './bathymetry';
import { mooredBoats } from './boats';
import { forestAreas } from './forest';
import { centroid, distance, intersectsRing, pathLength, ringArea, type LngLat } from './geo';
import { buildQuery, isSea, parse, type Area, type OsmData } from './osm';
import { overpass, TooMuchData, type OverpassElement, type OverpassResponse } from './overpass';
import { describe, type Selection } from './selection';
import { withoutBuildingBumps } from './flatten';
import { fetchLidarTerrain } from './lidar';
import { fetchTerrain, lngLatPixel, pixelLngLat, type Terrain } from './terrain';
import { fetchTileData } from './vector-tiles';

export interface AreaData {
  selection: Selection;
  osm: OsmData;
  terrain: Terrain;
  // 'tiles': the quick version from the base map's vector tiles, while 'full' (Overpass:
  // roofs, colors, trees, walls…) is still on its way, or if it failed.
  detail: 'tiles' | 'full';
  // Sea depths (EMODnet in Europe, NOAA elsewhere), when the area has sea and they're available.
  bathymetry?: Bathymetry | null;
}

// The terrain with the sea floor in it: inside the map's sea (and harbors, bays), the depths
// replace the tiles' heights, which have almost none near coasts and stray a few meters
// above sea level in places (kept, they stood as plateaus over the sea floor); where the
// depths have none, sea level. The sea is taken from the map, not from heights at or below
// zero: polders are land. With water shown it's flattened to
// sea level again (scene.ts); with water off, it's the ground. The depths come in cells
// about 115 m wide: interpolated, the floor shows their facets, and where the cells end
// short of the coast it drops off a ledge; so the whole sea floor is smoothed over about a
// cell, from sea points only (land doesn't drag the coast up, and stays as it was).
// `box`: the selection's bounding box, where the sea areas are built (from coastlines cut to
// it). Past it, the grid goes on a little for the tile's edge to be cut from: there, the
// tiles' own sea level marks the sea, or the edge would climb from the floor back up to
// zero in a thin fin.
function withSeaFloor(t: Terrain, b: Bathymetry, seaAreas: Area[], [w, s, e, n]: [number, number, number, number]): Terrain {
  const heights = Float32Array.from(t.heights);
  const sea = seaMask(t, seaAreas);
  for (let row = 0; row < t.height; row++) {
    for (let col = 0; col < t.width; col++) {
      const i = row * t.width + col;
      const [lng, lat] = pixelLngLat(t, col, row);
      const past = lng < w || lng > e || lat < s || lat > n;
      if (!sea[i] && !(past && heights[i] <= 0.5)) continue;
      sea[i] = 1;
      const depth = depthAt(b, lng, lat);
      heights[i] = depth > 0 ? -depth : Math.min(heights[i], 0);
    }
  }
  // A depth cell, in terrain pixels.
  const lat = (t.bbox[1] + t.bbox[3]) / 2;
  const metersPerPx = (156_543.03 * Math.cos((lat * Math.PI) / 180)) / 2 ** t.zoom;
  const cellPx = (b.dx * 111_320 * Math.cos((lat * Math.PI) / 180)) / metersPerPx;
  smoothMasked(heights, sea, t.width, t.height, Math.max(1, Math.round(cellPx)));
  // The depths are a cell apart: a cell's depth starts right at the coastline, a sheer wall
  // the data doesn't show. Eased in instead, from 0 at the coast to full depth a cell out.
  const fromLand = distanceToUnmasked(sea, t.width, t.height);
  for (let i = 0; i < heights.length; i++) {
    if (sea[i] && heights[i] < 0) heights[i] *= Math.min(1, fromLand[i] / Math.max(1, cellPx));
  }
  let [min, max] = [Infinity, -Infinity];
  for (const h of heights) {
    min = Math.min(min, h);
    max = Math.max(max, h);
  }
  return { ...t, heights, min, max };
}

// For each masked pixel, how far (in pixels) the nearest unmasked one is: two chamfer passes.
function distanceToUnmasked(mask: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(mask.length);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? Infinity : 0;
  const diag = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1);
      if (y > 0) d[i] = Math.min(d[i], d[i - w] + 1, x > 0 ? d[i - w - 1] + diag : Infinity, x < w - 1 ? d[i - w + 1] + diag : Infinity);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      if (x < w - 1) d[i] = Math.min(d[i], d[i + 1] + 1);
      if (y < h - 1) d[i] = Math.min(d[i], d[i + w] + 1, x < w - 1 ? d[i + w + 1] + diag : Infinity, x > 0 ? d[i + w - 1] + diag : Infinity);
    }
  }
  // A grid all sea has no land to measure from: no easing.
  for (let i = 0; i < d.length; i++) if (d[i] === Infinity) d[i] = 1e9;
  return d;
}

// Which terrain pixels are sea: the areas drawn on a canvas the grid's size.
function seaMask(t: Terrain, areas: Area[]): Uint8Array {
  const canvas = new OffscreenCanvas(t.width, t.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  for (const a of areas) {
    ctx.beginPath();
    for (const ring of [a.outer, ...a.holes]) {
      ring.forEach((p, k) => {
        const [x, y] = lngLatPixel(t, p);
        // Pixel centers sit half a pixel in on the canvas.
        if (k) ctx.lineTo(x + 0.5, y + 0.5);
        else ctx.moveTo(x + 0.5, y + 0.5);
      });
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }
  const pixels = ctx.getImageData(0, 0, t.width, t.height).data;
  const mask = new Uint8Array(t.width * t.height);
  for (let i = 0; i < mask.length; i++) mask[i] = pixels[i * 4] > 127 ? 1 : 0;
  return mask;
}

// Blurs `values` where `mask` is set, from masked values only (each point the average of
// the masked points around it): three box passes each way, close to a Gaussian, fast
// whatever the radius (running sums).
function smoothMasked(values: Float32Array, mask: Uint8Array, w: number, h: number, radius: number) {
  const sum = new Float64Array(values.length);
  const weight = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    weight[i] = mask[i];
    sum[i] = mask[i] ? values[i] : 0;
  }
  const line = new Float64Array(Math.max(w, h));
  const pass = (a: Float64Array, along: 'row' | 'col') => {
    const [n, count] = along === 'row' ? [w, h] : [h, w];
    for (let k = 0; k < count; k++) {
      const at = (j: number) => (along === 'row' ? k * w + j : j * w + k);
      let acc = 0;
      for (let j = -radius; j <= radius; j++) acc += a[at(Math.min(n - 1, Math.max(0, j)))];
      for (let j = 0; j < n; j++) {
        line[j] = acc;
        acc += a[at(Math.min(n - 1, j + radius + 1))] - a[at(Math.max(0, j - radius))];
      }
      for (let j = 0; j < n; j++) a[at(j)] = line[j];
    }
  };
  for (let p = 0; p < 3; p++) {
    for (const along of ['row', 'col'] as const) {
      pass(sum, along);
      pass(weight, along);
    }
  }
  for (let i = 0; i < values.length; i++) if (mask[i] && weight[i] > 0) values[i] = sum[i] / weight[i];
}

// Progress of the detailed (Overpass) download, the only slow part.
export interface FetchProgress {
  osmServer?: string;
  osmBytes: number;
  osmCached: boolean;
  osmDone: boolean;
  // Waiting before the next try: a free server slot, or backing off after a refusal.
  osmWaitS?: number;
  // Big selections are requested in chunks, one after another: the plan (replaced when a
  // chunk is split, see TooMuchData) and where we are.
  chunks?: ChunkPlan[];
  chunk?: number;
  // The chunks answered so far, with how it went.
  answered?: ChunkResult[];
}

export interface ChunkPlan {
  bbox: [number, number, number, number];
  km2: number;
  // From the quick tile data; null when it didn't arrive.
  buildings: number | null;
  // The answer's predicted size (KB), from everything in the quick tile data; null without it.
  kb: number | null;
}

export interface ChunkResult {
  plan: ChunkPlan;
  bytes: number;
  cached: boolean;
  server?: string;
  // Seconds from sending the request that answered to its last byte, and requests it took.
  answeredS?: number;
  tries?: number;
}

// Each request costs about 44 s of server queue, whatever its size, and then time for what
// comes back, which follows how much is in the area, not its size (logged October 2026: 5.8
// km² with no buildings, 0.05 MB; 5.9 km² with 26,800, 47 MB). So chunks are planned by the
// answer's predicted size: sparse ground (islands, mountains, farmland) goes in a few big
// requests instead of many small ones. Fitted on the same fetches: per feature in the quick
// tile data, a building about 1 KB, a road about 3 KB (its nodes and tags), anything else
// about 0.5 KB.
const KB_PER_BUILDING = 1;
const KB_PER_ROAD = 3;
const KB_PER_OTHER = 0.5;
// A chunk holds at most this much: well under the server's limits (120 s, 512 MB), where the
// biggest request logged (47 MB) took 41 s of queue and 62 s of download.
const CHUNK_MAX_KB = 30_000;
// And at most this much area: with the quick data's counts, the size prediction decides
// within it. Without them (the quick data failed, or the area is too big for it) area alone
// does, as a guess for a town.
const CHUNK_MAX_KM2 = 100;
const CHUNK_MAX_KM2_BLIND = 10;
// A chunk the server gives up on is split in two and asked again, down to this size.
const CHUNK_MIN_KM2 = 0.25;

// Calls `onQuick` with the tile version as soon as it's ready (a second or two), then
// resolves with the full version, requested chunk by chunk. If the full version fails, the
// quick one stays usable.
export async function fetchAreaData(
  selection: Selection,
  signal: AbortSignal,
  onProgress: (p: FetchProgress) => void,
  onQuick: (data: AreaData) => void,
): Promise<AreaData> {
  const { ring, bbox } = describe(selection);
  const progress: FetchProgress = { osmBytes: 0, osmCached: false, osmDone: false };
  const report = (change: Partial<FetchProgress>) => onProgress(Object.assign(progress, change));

  const terrain = fetchTerrain(bbox, signal, () => {});
  // LiDAR where a country publishes it (lidar.ts), in the background: the quick version uses
  // the tiles, the detailed one the sharper heights.
  const sharper = terrain.then(async (tiles) => (await fetchLidarTerrain(tiles, signal)) ?? tiles);
  // The quick data also tells how dense each part of the area is, to plan the chunks.
  const quick = await fetchTileData(bbox, ring, signal).catch((err) => {
    if (signal.aborted) throw err;
    console.warn('Quick tile data failed', err);
    return null;
  });
  let fullArrived = false;
  if (quick) terrain.then((t) => fullArrived || onQuick({ selection, osm: quick, terrain: withoutBuildingBumps(t, quick.buildings), detail: 'tiles' })).catch(() => {});

  const features = quick ? weighFeatures(quick) : null;
  const chunks = planChunks(bbox, ring, features);
  report({ chunks, chunk: 1, answered: [] });

  // One chunk at a time: parallel requests would use up our share of the server.
  const seen = new Set<string>();
  const elements: OverpassElement[] = [];
  let bytes = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    report({ chunk: i + 1, osmServer: undefined, osmWaitS: undefined });
    const result: ChunkResult = { plan: chunk, bytes: 0, cached: false };
    let res: OverpassResponse;
    try {
      res = await overpass(buildQuery(chunk.bbox), signal, ({ server, bytes: b, cached, waitS, answeredS, tries }) => {
        Object.assign(result, { server, bytes: b, cached, answeredS, tries });
        report({ osmServer: server, osmBytes: bytes + b, osmCached: cached && (i === 0 || progress.osmCached), osmWaitS: waitS });
      });
    } catch (err) {
      // Too much for one request after all: the two halves, one after the other.
      if (!(err instanceof TooMuchData) || chunk.km2 / 2 < CHUNK_MIN_KM2) throw err;
      chunks.splice(i, 1, ...planChunks(chunk.bbox, ring, features, true));
      report({ chunks: [...chunks] });
      i--;
      continue;
    }
    bytes = progress.osmBytes;
    report({ answered: [...progress.answered!, result] });
    // Ways and relations crossing a chunk border come back from both sides.
    for (const el of res.elements) {
      const id = `${el.type}/${el.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      elements.push(el);
    }
  }
  report({ osmDone: true, osmWaitS: undefined });
  const osm = parse(elements, ring);
  fullArrived = true;
  // Sea depths, only for areas with sea; without them the sea prints at its usual depth.
  const sea = osm.waterAreas.some(isSea);
  const bathymetry = sea ? await fetchBathymetry(bbox, signal).catch(() => null) : null;
  // LiDAR terrain where there is some (else the tiles, with big buildings' bumps taken out),
  // then the sea floor in it.
  const ground = withoutBuildingBumps(await sharper, osm.buildings);
  return { selection, osm, terrain: bathymetry ? withSeaFloor(ground, bathymetry, osm.waterAreas.filter(isSea), bbox) : ground, detail: 'full', bathymetry };
}

// Whether a chunk's box and the selection overlap. Edges count: the selection's corners lie
// exactly on its own bounding box (a rectangle or hexagon fetched as a single chunk), and a
// strict point-in-polygon test would drop the only chunk.
function touches([w, s, e, n]: [number, number, number, number], ring: LngLat[]): boolean {
  if (ring.some(([x, y]) => x >= w && x <= e && y >= s && y <= n)) return true;
  const corners: LngLat[] = [[w, s], [e, s], [e, n], [w, n], [w, s]];
  return intersectsRing(corners, ring, true);
}

// Every feature in the quick tile data, where it is and its predicted share of the answer.
interface Weighed {
  at: LngLat;
  kb: number;
  building: boolean;
}

function weighFeatures(osm: OsmData): Weighed[] {
  const middle = (path: LngLat[]) => path[path.length >> 1];
  const other = (at: LngLat) => ({ at, kb: KB_PER_OTHER, building: false });
  return [
    ...osm.buildings.map((b) => ({ at: centroid(b.outer), kb: KB_PER_BUILDING, building: true })),
    ...osm.roads.map((l) => ({ at: middle(l.path), kb: KB_PER_ROAD, building: false })),
    ...[...osm.railways, ...osm.waterways, ...osm.structureLines, ...osm.pavedLines].map((l) => other(middle(l.path))),
    ...[...osm.waterAreas, ...osm.green, ...osm.structureAreas, ...osm.surfaces, ...osm.pavedAreas].map((a) => other(a.outer[0])),
    ...osm.towers.map((t) => other(t.at)),
    ...osm.trees.map(other),
  ];
}

// Splits the box in halves (along its longer side) until each piece is within the limits,
// and keeps the pieces that touch the selection. `split`: halve the box even if it's within
// them (the server gave up on it).
function planChunks(
  bbox: [number, number, number, number],
  ring: LngLat[],
  features: Weighed[] | null,
  split = false,
): ChunkPlan[] {
  const out: ChunkPlan[] = [];
  const maxKm2 = features ? CHUNK_MAX_KM2 : CHUNK_MAX_KM2_BLIND;
  const plan = (box: [number, number, number, number], inside: Weighed[] | null, force: boolean) => {
    const [w, s, e, n] = box;
    const wide = distance([w, (s + n) / 2], [e, (s + n) / 2]);
    const tall = distance([(w + e) / 2, s], [(w + e) / 2, n]);
    const km2 = (wide * tall) / 1e6;
    const kb = inside ? inside.reduce((sum, f) => sum + f.kb, 0) : null;
    if (!force && km2 <= maxKm2 && (kb === null || kb <= CHUNK_MAX_KB)) {
      const buildings = inside ? inside.filter((f) => f.building).length : null;
      if (touches(box, ring)) out.push({ bbox: box, km2, buildings, kb });
      return;
    }
    const halves: [number, number, number, number][] =
      wide >= tall
        ? [[w, s, (w + e) / 2, n], [(w + e) / 2, s, e, n]]
        : [[w, s, e, (s + n) / 2], [w, (s + n) / 2, e, n]];
    for (const h of halves) {
      plan(h, inside?.filter(({ at: [x, y] }) => x >= h[0] && x < h[2] && y >= h[1] && y < h[3]) ?? null, false);
    }
  };
  const [w, s, e, n] = bbox;
  plan(bbox, features?.filter(({ at: [x, y] }) => x >= w && x <= e && y >= s && y <= n) ?? null, split);
  return out;
}

export type Layer = 'buildings' | 'structures' | 'roads' | 'railways' | 'paved' | 'water' | 'green' | 'surfaces' | 'trees';

export interface LayerSummary {
  layer: Layer;
  label: string;
  count: number;
  detail: string;
}

export function summarize({ osm, detail }: AreaData): LayerSummary[] {
  const km = (lines: { path: [number, number][] }[]) =>
    `${(lines.reduce((sum, l) => sum + pathLength(l.path), 0) / 1000).toFixed(1)} km`;
  const pct = (n: number) => (osm.buildings.length ? Math.round((100 * n) / osm.buildings.length) : 0);
  const bridges = (lines: { bridge?: boolean }[]) => {
    const n = lines.filter((l) => l.bridge).length;
    return n ? `, ${n} on bridges` : '';
  };
  const sea = osm.waterAreas.some(isSea);
  const water = osm.waterAreas.filter((a) => !isSea(a)).length;
  const boats = mooredBoats(osm).length;
  return [
    {
      layer: 'buildings',
      label: 'Buildings',
      count: osm.buildings.length,
      detail:
        detail === 'tiles'
          ? 'heights from map tiles, flat roofs'
          : `${pct(osm.buildings.filter((b) => b.heightFrom !== 'estimate').length)}% real heights, ` +
            `${pct(osm.buildings.filter((b) => b.roofShape && b.roofShape !== 'flat').length)}% shaped roofs`,
    },
    {
      layer: 'structures',
      label: 'Bridges, piers, walls, towers',
      count: osm.structureLines.length + osm.structureAreas.length + osm.towers.length,
      detail: kinds([...osm.structureLines, ...osm.structureAreas, ...osm.towers]),
    },
    { layer: 'roads', label: 'Roads & paths', count: osm.roads.length, detail: km(osm.roads) + bridges(osm.roads) },
    { layer: 'railways', label: 'Railways & trams', count: osm.railways.length, detail: km(osm.railways) + bridges(osm.railways) },
    {
      layer: 'paved',
      label: 'Squares, parking, sports',
      count: osm.pavedAreas.length + osm.pavedLines.length,
      detail: kinds([...osm.pavedAreas, ...osm.pavedLines]),
    },
    {
      layer: 'water',
      label: 'Water',
      count: osm.waterAreas.length + osm.waterways.length,
      detail: [sea && 'sea', water && `${water} areas`, osm.waterways.length && `${osm.waterways.length} streams`, boats && `${boats} boats at piers`]
        .filter(Boolean)
        .join(', '),
    },
    { layer: 'green', label: 'Green areas', count: osm.green.length, detail: kinds(osm.green) },
    { layer: 'surfaces', label: 'Sand, rock, glacier', count: osm.surfaces.length, detail: kinds(osm.surfaces) },
    (() => {
      // Forests count too: a wooded island has trees though OSM maps none one by one.
      const woods = forestAreas(osm);
      const single = osm.trees.length;
      const m2 = woods.reduce((n, a) => n + ringArea(a.outer) - a.holes.reduce((h, r) => h + ringArea(r), 0), 0);
      const forest = woods.length ? `${woods.length} ${woods.length === 1 ? 'forest' : 'forests'}, ${m2 >= 1e4 ? `${(m2 / 1e4).toFixed(1)} ha` : `${Math.round(m2)} m²`}` : '';
      const detail = [single && `${single.toLocaleString()} single`, forest].filter(Boolean).join(', ');
      return { layer: 'trees' as const, label: 'Trees & forests', count: single + woods.length, detail };
    })(),
  ];
}

// "12 wall, 3 pier" style breakdown, most common first, at most four kinds.
function kinds(items: { kind: string }[]): string {
  const counts = new Map<string, number>();
  for (const { kind } of items) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`)
    .join(', ');
}
