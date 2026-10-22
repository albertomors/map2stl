// Everything the 3D model is built from, for one selection: OSM features and terrain.
// The output of milestone 2 and the input of the 3D viewer.

import { centroid, distance, intersectsRing, pathLength, type LngLat } from './geo';
import { buildQuery, parse, type OsmData } from './osm';
import { overpass, type OverpassElement } from './overpass';
import { describe, type Selection } from './selection';
import { fetchTerrain, type Terrain } from './terrain';
import { fetchTileData } from './vector-tiles';

export interface AreaData {
  selection: Selection;
  osm: OsmData;
  terrain: Terrain;
  // 'tiles': the quick version from the base map's vector tiles, while 'full' (Overpass:
  // roofs, colors, trees, walls…) is still on its way, or if it failed.
  detail: 'tiles' | 'full';
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
  return { selection, osm, terrain: await terrain, detail: 'full' };
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
  const sea = osm.waterAreas.some((a) => a.kind === 'sea');
  const water = osm.waterAreas.filter((a) => a.kind !== 'sea').length;
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
      detail: [sea && 'sea', water && `${water} areas`, osm.waterways.length && `${osm.waterways.length} streams`]
        .filter(Boolean)
        .join(', '),
    },
    { layer: 'green', label: 'Green areas', count: osm.green.length, detail: kinds(osm.green) },
    { layer: 'surfaces', label: 'Sand, rock, glacier', count: osm.surfaces.length, detail: kinds(osm.surfaces) },
    { layer: 'trees', label: 'Trees', count: osm.trees.length, detail: '' },
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
