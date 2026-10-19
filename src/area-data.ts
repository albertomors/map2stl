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

export type Layer = 'buildings' | 'roads' | 'railways' | 'water' | 'green' | 'trees';

export interface LayerSummary {
  layer: Layer;
  label: string;
  count: number;
  detail: string;
}

export function summarize({ osm }: AreaData): LayerSummary[] {
  const km = (lines: { path: [number, number][] }[]) =>
    `${(lines.reduce((sum, l) => sum + pathLength(l.path), 0) / 1000).toFixed(1)} km`;
  const tagged = osm.buildings.filter((b) => b.heightFrom !== 'estimate').length;
  const pct = osm.buildings.length ? Math.round((100 * tagged) / osm.buildings.length) : 0;
  return [
    { layer: 'buildings', label: 'Buildings', count: osm.buildings.length, detail: `${pct}% with real heights` },
    { layer: 'roads', label: 'Roads & paths', count: osm.roads.length, detail: km(osm.roads) },
    { layer: 'railways', label: 'Railways & trams', count: osm.railways.length, detail: km(osm.railways) },
    {
      layer: 'water',
      label: 'Water',
      count: osm.waterAreas.length + osm.waterways.length,
      detail: `${osm.waterAreas.length} areas, ${osm.waterways.length} streams`,
    },
    { layer: 'green', label: 'Green areas', count: osm.green.length, detail: '' },
    { layer: 'trees', label: 'Trees', count: osm.trees.length, detail: '' },
  ];
}
