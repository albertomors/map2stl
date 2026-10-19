// Everything the 3D model is built from, for one selection: OSM features and terrain.
// The output of milestone 2 and the input of the 3D viewer.

import { pathLength } from './geo';
import { buildQuery, parse, type OsmData } from './osm';
import { overpass } from './overpass';
import { describe, type Selection } from './selection';
import { fetchTerrain, type Terrain } from './terrain';

export interface AreaData {
  selection: Selection;
  osm: OsmData;
  terrain: Terrain;
}

export interface FetchProgress {
  osmServer?: string;
  osmBytes: number;
  osmCached: boolean;
  osmDone: boolean;
  tilesDone: number;
  tilesTotal: number;
}

export async function fetchAreaData(
  selection: Selection,
  signal: AbortSignal,
  onProgress: (p: FetchProgress) => void,
): Promise<AreaData> {
  const { ring, bbox } = describe(selection);
  const progress: FetchProgress = { osmBytes: 0, osmCached: false, osmDone: false, tilesDone: 0, tilesTotal: 0 };
  const report = (change: Partial<FetchProgress>) => onProgress(Object.assign(progress, change));

  const [osm, terrain] = await Promise.all([
    overpass(buildQuery(bbox), signal, ({ server, bytes, cached }) => report({ osmServer: server, osmBytes: bytes, osmCached: cached })).then((res) => {
      report({ osmDone: true });
      return parse(res.elements, ring);
    }),
    fetchTerrain(bbox, signal, (tilesDone, tilesTotal) => report({ tilesDone, tilesTotal })),
  ]);
  return { selection, osm, terrain };
}

export type Layer = 'buildings' | 'structures' | 'roads' | 'railways' | 'paved' | 'water' | 'green' | 'surfaces' | 'trees';

export interface LayerSummary {
  layer: Layer;
  label: string;
  count: number;
  detail: string;
}

export function summarize({ osm }: AreaData): LayerSummary[] {
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
      detail: `${pct(osm.buildings.filter((b) => b.heightFrom !== 'estimate').length)}% real heights, ` +
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
