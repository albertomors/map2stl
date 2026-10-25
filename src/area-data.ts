// Everything the 3D model is built from, for one selection: OSM features and terrain.
// The output of milestone 2 and the input of the 3D viewer.

import { depthAt, fetchBathymetry, type Bathymetry } from './bathymetry';
import { mooredBoats } from './boats';
import { forestAreas } from './forest';
import { centroid, distance, intersectsRing, pathLength, ringArea, type LngLat } from './geo';
import { buildQuery, isSea, parse, type Area, type OsmData } from './osm';
import { overpass, type OverpassElement } from './overpass';
import { describe, type Selection } from './selection';
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
function withSeaFloor(t: Terrain, b: Bathymetry, seaAreas: Area[]): Terrain {
  const heights = Float32Array.from(t.heights);
  const sea = seaMask(t, seaAreas);
  for (let row = 0; row < t.height; row++) {
    for (let col = 0; col < t.width; col++) {
      const i = row * t.width + col;
      if (!sea[i]) continue;
      const [lng, lat] = pixelLngLat(t, col, row);
      const depth = depthAt(b, lng, lat);
      heights[i] = depth > 0 ? -depth : Math.min(heights[i], 0);
    }
  }
  // A depth cell, in terrain pixels.
  const lat = (t.bbox[1] + t.bbox[3]) / 2;
  const metersPerPx = (156_543.03 * Math.cos((lat * Math.PI) / 180)) / 2 ** t.zoom;
  const cellPx = (b.dx * 111_320 * Math.cos((lat * Math.PI) / 180)) / metersPerPx;
  smoothMasked(heights, sea, t.width, t.height, Math.max(1, Math.round(cellPx)));
  let [min, max] = [Infinity, -Infinity];
  for (const h of heights) {
    min = Math.min(min, h);
    max = Math.max(max, h);
  }
  return { ...t, heights, min, max };
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
  // Big selections are requested in chunks, one after another: the plan and where we are.
  chunks?: ChunkPlan[];
  chunk?: number;
}

export interface ChunkPlan {
  bbox: [number, number, number, number];
  km2: number;
  // From the quick tile data; null when it didn't arrive.
  buildings: number | null;
}

// A chunk holds at most this much: fewer, bigger requests are faster (each costs ~40 s of
// server queue, area adds little), but each must stay inside the server's limits (120 s,
// 512 MB per request). The biggest dense area measured (3.2 km², 2,700 buildings, 8 MB) took
// under 60 s; these limits are a first guess to tune with real chunk timings.
const CHUNK_MAX_KM2 = 10;
const CHUNK_MAX_BUILDINGS = 25_000;

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
  if (quick) terrain.then((t) => fullArrived || onQuick({ selection, osm: quick, terrain: t, detail: 'tiles' })).catch(() => {});

  const centers = quick?.buildings.map((b) => centroid(b.outer)) ?? null;
  const chunks = planChunks(bbox, ring, centers);
  report({ chunks, chunk: 1 });

  // One chunk at a time: parallel requests would use up our share of the server.
  const seen = new Set<string>();
  const elements: OverpassElement[] = [];
  let bytes = 0;
  for (const [i, chunk] of chunks.entries()) {
    report({ chunk: i + 1, osmServer: undefined, osmWaitS: undefined });
    const res = await overpass(buildQuery(chunk.bbox), signal, ({ server, bytes: b, cached, waitS }) =>
      report({ osmServer: server, osmBytes: bytes + b, osmCached: cached && (i === 0 || progress.osmCached), osmWaitS: waitS }),
    );
    bytes = progress.osmBytes;
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
  // LiDAR terrain where there is some, then the sea floor in it.
  const ground = await sharper;
  return { selection, osm, terrain: bathymetry ? withSeaFloor(ground, bathymetry, osm.waterAreas.filter(isSea)) : ground, detail: 'full', bathymetry };
}

// Whether a chunk's box and the selection overlap. Edges count: the selection's corners lie
// exactly on its own bounding box (a rectangle or hexagon fetched as a single chunk), and a
// strict point-in-polygon test would drop the only chunk.
function touches([w, s, e, n]: [number, number, number, number], ring: LngLat[]): boolean {
  if (ring.some(([x, y]) => x >= w && x <= e && y >= s && y <= n)) return true;
  const corners: LngLat[] = [[w, s], [e, s], [e, n], [w, n], [w, s]];
  return intersectsRing(corners, ring, true);
}

// Splits the selection's box in halves (along its longer side) until each piece is within
// the limits, and keeps the pieces that touch the selection.
function planChunks(bbox: [number, number, number, number], ring: LngLat[], centers: LngLat[] | null): ChunkPlan[] {
  const out: ChunkPlan[] = [];
  const split = (box: [number, number, number, number], pts: LngLat[] | null) => {
    const [w, s, e, n] = box;
    const wide = distance([w, (s + n) / 2], [e, (s + n) / 2]);
    const tall = distance([(w + e) / 2, s], [(w + e) / 2, n]);
    const km2 = (wide * tall) / 1e6;
    const count = pts ? pts.length : null;
    if (km2 <= CHUNK_MAX_KM2 && (count === null || count <= CHUNK_MAX_BUILDINGS)) {
      if (touches(box, ring)) out.push({ bbox: box, km2, buildings: count });
      return;
    }
    const halves: [number, number, number, number][] =
      wide >= tall
        ? [[w, s, (w + e) / 2, n], [(w + e) / 2, s, e, n]]
        : [[w, s, e, (s + n) / 2], [w, (s + n) / 2, e, n]];
    for (const h of halves) {
      const inside = pts?.filter(([x, y]) => x >= h[0] && x < h[2] && y >= h[1] && y < h[3]) ?? null;
      split(h, inside);
    }
  };
  split(bbox, centers);
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
