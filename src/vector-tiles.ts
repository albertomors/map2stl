// Quick data for the selection from the base map's own vector tiles (OpenMapTiles schema,
// zoom 14, served by OpenFreeMap): a CDN download of a few tiles, ready in a second or two,
// while the detailed Overpass answer takes 30–90 s. It has buildings with heights and
// colors, roads and rails with bridges, water including the sea, parks, landcover and
// runways; no roof shapes, trees, walls or towers.

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { clipLine } from './clip';
import { intersectsRing, type LngLat } from './geo';
import type { Area, Building, Line, OsmData, Polygon } from './osm';
import polygonClipping, { type Polygon as PcPolygon } from 'polygon-clipping';

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const ZOOM = 14;
// A 10 km² selection at mid latitudes needs about 25 tiles.
const MAX_TILES = 100;

const ROAD_WIDTH: Record<string, number> = {
  motorway: 14, trunk: 12, primary: 10, secondary: 9, tertiary: 8, minor: 6, service: 4,
  track: 3, path: 1.5, raceway: 8, busway: 6, bus_guideway: 6,
};
const WATERWAY_WIDTH: Record<string, number> = { river: 12, canal: 8, stream: 2, ditch: 1, drain: 1 };
const GREEN_LANDCOVER = /^(grass|wood|farmland|wetland)$/;
const SURFACE_LANDCOVER = /^(sand|rock|ice)$/;

let tileTemplate: Promise<string> | null = null;

export async function fetchTileData(bbox: [number, number, number, number], ring: LngLat[], signal: AbortSignal): Promise<OsmData> {
  // The tile URL carries the data release date: ask the TileJSON once per session.
  tileTemplate ??= fetch(TILEJSON_URL).then(async (r) => (await r.json()).tiles[0] as string);
  const template = await tileTemplate;

  const [x0, y1] = tileOf(bbox[0], bbox[1]);
  const [x1, y0] = tileOf(bbox[2], bbox[3]);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_TILES) throw new Error('Selection too large for quick tile data');

  const data: OsmData = {
    buildings: [], roads: [], railways: [], waterAreas: [], waterways: [], green: [], trees: [],
    structureLines: [], structureAreas: [], towers: [], surfaces: [], pavedAreas: [], pavedLines: [],
  };
  const jobs: Promise<void>[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const url = template.replace('{z}', String(ZOOM)).replace('{x}', String(x)).replace('{y}', String(y));
      jobs.push(
        fetch(url, { signal }).then(async (res) => {
          if (!res.ok) throw new Error(`Map tile ${ZOOM}/${x}/${y} failed (${res.status})`);
          readTile(new VectorTile(new PbfReader(await res.arrayBuffer())), x, y, ring, data);
        }),
      );
    }
  }
  await Promise.all(jobs);
  return data;
}

function readTile(tile: VectorTile, x: number, y: number, ring: LngLat[], data: OsmData) {
  // Tiles overlap their neighbors by a buffer: keep only what's inside this tile, or features
  // near the seams would come out twice.
  const bounds = tileBounds(x, y);
  const boundsRing: LngLat[] = [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]], [bounds[0], bounds[1]]];

  const each = (layer: string, fn: (props: Record<string, unknown>, polys: Polygon[], lines: LngLat[][]) => void) => {
    const l = tile.layers[layer];
    if (!l) return;
    for (let i = 0; i < l.length; i++) {
      const f = l.feature(i);
      const g = f.toGeoJSON(x, y, ZOOM).geometry;
      const polys: Polygon[] = [];
      const lines: LngLat[][] = [];
      if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
        const rings = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates) as LngLat[][][];
        for (const [outer, ...holes] of rings) {
          for (const p of clipToTile({ outer, holes }, bounds, boundsRing)) if (intersectsRing(p.outer, ring, true)) polys.push(p);
        }
      } else if (g.type === 'LineString' || g.type === 'MultiLineString') {
        const paths = (g.type === 'LineString' ? [g.coordinates] : g.coordinates) as LngLat[][];
        for (const path of paths) for (const piece of clipLine(path, boundsRing)) if (intersectsRing(piece, ring)) lines.push(piece);
      }
      if (polys.length || lines.length) fn(f.properties, polys, lines);
    }
  };

  each('building', (p, polys) => {
    if (p.hide_3d) return;
    const height = Number(p.render_height) || 5;
    const minHeight = Number(p.render_min_height) || 0;
    for (const poly of polys) {
      data.buildings.push({ ...poly, id: `tile/${data.buildings.length}`, height, minHeight, heightFrom: 'height', colour: p.colour as string | undefined } satisfies Building);
    }
  });

  each('transportation', (p, polys, lines) => {
    const cls = String(p.class);
    if (p.brunnel === 'tunnel' || cls === 'ferry' || Number(p.layer) < 0) return;
    const bridge = p.brunnel === 'bridge';
    if (cls === 'rail' || cls === 'transit') {
      for (const path of lines) data.railways.push(line(path, String(p.subclass ?? cls), p.subclass === 'tram' ? 2.5 : 3.5, bridge));
    } else if (cls === 'pier') {
      for (const path of lines) data.structureLines.push({ ...line(path, 'pier', 4), height: 1 });
      for (const poly of polys) data.structureAreas.push({ ...poly, id: nextId('area'), kind: 'pier', height: 1 });
    } else if (cls === 'bridge') {
      for (const poly of polys) data.structureAreas.push({ ...poly, id: nextId('area'), kind: 'bridge', height: 1 });
    } else {
      for (const path of lines) data.roads.push(line(path, String(p.subclass ?? cls), ROAD_WIDTH[cls] ?? 3, bridge));
      // Pedestrian squares and similar are drawn as areas.
      for (const poly of polys) data.pavedAreas.push(area(poly, String(p.subclass ?? cls)));
    }
  });

  each('water', (p, polys) => {
    if (p.brunnel === 'tunnel') return;
    for (const poly of polys) data.waterAreas.push(area(poly, p.class === 'ocean' ? 'sea' : String(p.class)));
  });

  each('waterway', (p, _polys, lines) => {
    if (p.brunnel === 'tunnel') return;
    const cls = String(p.class);
    for (const path of lines) data.waterways.push(line(path, cls, WATERWAY_WIDTH[cls] ?? 2));
  });

  each('landcover', (p, polys) => {
    const cls = String(p.class);
    const target = GREEN_LANDCOVER.test(cls) ? data.green : SURFACE_LANDCOVER.test(cls) ? data.surfaces : null;
    for (const poly of polys) target?.push(area(poly, String(p.subclass ?? cls)));
  });

  each('park', (p, polys) => {
    for (const poly of polys) data.green.push(area(poly, String(p.class)));
  });

  each('landuse', (p, polys) => {
    const cls = String(p.class);
    if (cls === 'cemetery') for (const poly of polys) data.green.push(area(poly, cls));
    else if (/^(pitch|stadium|playground)$/.test(cls)) for (const poly of polys) data.pavedAreas.push(area(poly, cls));
  });

  each('aeroway', (p, polys, lines) => {
    const cls = String(p.class);
    for (const path of lines) data.pavedLines.push(line(path, cls, cls === 'runway' ? 45 : 23));
    for (const poly of polys) data.pavedAreas.push(area(poly, cls));
  });
}

// Tile features have no stable ids: number them in the order they're read.
let counter = 0;
const nextId = (what: string) => `tile-${what}/${counter++}`;

function line(path: LngLat[], kind: string, width: number, bridge = false): Line {
  return { id: nextId('line'), path, kind, width, ...(bridge ? { bridge } : {}) };
}

function area(poly: Polygon, kind: string): Area {
  return { ...poly, kind };
}

function clipToTile(p: Polygon, [w, s, e, n]: number[], boundsRing: LngLat[]): Polygon[] {
  if (p.outer.every(([x, y]) => x >= w && x <= e && y >= s && y <= n)) return [p];
  const pieces = polygonClipping.intersection([p.outer, ...p.holes] as PcPolygon, [boundsRing] as PcPolygon);
  return pieces.map(([outer, ...holes]) => ({ outer: outer as LngLat[], holes: holes as LngLat[][] }));
}

function tileOf(lng: number, lat: number): [number, number] {
  const n = 2 ** ZOOM;
  const r = (lat * Math.PI) / 180;
  return [Math.floor(((lng + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)];
}

// [west, south, east, north]
function tileBounds(x: number, y: number): [number, number, number, number] {
  const n = 2 ** ZOOM;
  const lat = (row: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return [(x / n) * 360 - 180, lat(y + 1), ((x + 1) / n) * 360 - 180, lat(y)];
}
