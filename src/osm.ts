// OpenStreetMap features inside the selection, sorted into the categories the model is built
// from. Buildings get a height in meters (from tags, or estimated); lines get a width.

import { centroid, intersectsRing, pointInRing, type LngLat } from './geo';
import type { OverpassElement } from './overpass';

export interface Polygon {
  outer: LngLat[];
  holes: LngLat[][];
}

export interface Building extends Polygon {
  id: string;
  // Meters above the ground: the walls run from minHeight to height.
  height: number;
  minHeight: number;
  heightFrom: 'height' | 'levels' | 'estimate';
  name?: string;
}

export interface Line {
  path: LngLat[];
  kind: string;
  // Meters.
  width: number;
}

export interface Area extends Polygon {
  kind: string;
}

export interface OsmData {
  buildings: Building[];
  roads: Line[];
  railways: Line[];
  waterAreas: Area[];
  waterways: Line[];
  green: Area[];
  trees: LngLat[];
}

const LEVEL_HEIGHT = 3;
const RAIL = 'rail|light_rail|tram|subway|narrow_gauge|monorail|funicular';
const WATERWAY_LINE = 'river|canal|stream|ditch|drain';
const GREEN_LANDUSE = 'grass|forest|meadow|recreation_ground|village_green|cemetery|allotments|orchard|vineyard';
const GREEN_LEISURE = 'park|garden|playground|pitch|golf_course';
const GREEN_NATURAL = 'wood|scrub|grassland|heath';

// [bbox] is s,w,n,e. Features are cut to the real shape afterwards, in parse().
export function buildQuery([w, s, e, n]: [number, number, number, number]): string {
  const area = (filter: string) => `way${filter};relation${filter}["type"="multipolygon"];`;
  return `[out:json][timeout:120][maxsize:536870912][bbox:${s},${w},${n},${e}];
(
  ${area('["building"]')}
  ${area('["building:part"]')}
  way["highway"];
  way["railway"~"^(${RAIL})$"];
  ${area('["natural"="water"]')}
  ${area('["waterway"="riverbank"]')}
  ${area('["landuse"~"^(reservoir|basin)$"]')}
  way["waterway"~"^(${WATERWAY_LINE})$"];
  ${area(`["landuse"~"^(${GREEN_LANDUSE})$"]`)}
  ${area(`["leisure"~"^(${GREEN_LEISURE})$"]`)}
  ${area(`["natural"~"^(${GREEN_NATURAL})$"]`)}
  node["natural"="tree"];
);
out geom qt;`;
}

export function parse(elements: OverpassElement[], ring: LngLat[]): OsmData {
  const data: OsmData = { buildings: [], roads: [], railways: [], waterAreas: [], waterways: [], green: [], trees: [] };
  const outlines: Building[] = [];
  const parts: Building[] = [];

  for (const el of elements) {
    const t = el.tags ?? {};

    if (el.type === 'node') {
      if (t.natural === 'tree' && el.lon !== undefined && el.lat !== undefined) {
        const p: LngLat = [el.lon, el.lat];
        if (pointInRing(p, ring)) data.trees.push(p);
      }
      continue;
    }

    const isPart = !!t['building:part'] && t['building:part'] !== 'no';
    if (isPart || (t.building && t.building !== 'no')) {
      // Whole buildings only: one cut at the edge of the selection would print as a broken wall.
      for (const poly of polygons(el)) {
        if (!pointInRing(centroid(poly.outer), ring)) continue;
        (isPart ? parts : outlines).push({ ...poly, id: `${el.type}/${el.id}`, ...buildingHeight(t, isPart), name: t.name });
      }
      continue;
    }

    // Underground features don't belong in a printed model.
    if (t.tunnel && t.tunnel !== 'no') continue;
    if (t.layer && Number(t.layer) < 0) continue;

    if (t.highway && el.type === 'way') {
      if (/^(proposed|construction|platform|elevator|corridor)$/.test(t.highway) || t.area === 'yes') continue;
      addLine(data.roads, el, t.highway, parseLength(t.width) ?? ROAD_WIDTH[t.highway] ?? 3, ring);
    } else if (t.railway && el.type === 'way') {
      addLine(data.railways, el, t.railway, t.railway === 'tram' ? 2.5 : 3.5, ring);
    } else if (t.natural === 'water' || t.waterway === 'riverbank' || /^(reservoir|basin)$/.test(t.landuse ?? '')) {
      addAreas(data.waterAreas, el, t.water ?? t.natural ?? t.landuse ?? 'water', ring);
    } else if (t.waterway && el.type === 'way') {
      if (t.culvert || t.covered === 'yes') continue;
      addLine(data.waterways, el, t.waterway, parseLength(t.width) ?? WATERWAY_WIDTH[t.waterway] ?? 2, ring);
    } else if (t.landuse || t.leisure || t.natural) {
      addAreas(data.green, el, t.landuse ?? t.leisure ?? t.natural, ring);
    }
  }

  // An outline with building:part inside is drawn by its parts: keeping it too would bury them.
  const covered = new Set<Building>();
  for (const part of parts) {
    const c = centroid(part.outer);
    for (const o of outlines) if (!covered.has(o) && pointInRing(c, o.outer)) covered.add(o);
  }
  data.buildings = [...outlines.filter((o) => !covered.has(o)), ...parts];
  return data;
}

// Typical carriageway widths in meters when the way has no width tag.
const ROAD_WIDTH: Record<string, number> = {
  motorway: 14, trunk: 12, primary: 10, secondary: 9, tertiary: 8,
  motorway_link: 6, trunk_link: 6, primary_link: 6, secondary_link: 6, tertiary_link: 6,
  residential: 6, unclassified: 6, living_street: 5, pedestrian: 5, service: 4, track: 3,
  cycleway: 2, footway: 2, path: 1.5, steps: 2, bridleway: 2,
};

const WATERWAY_WIDTH: Record<string, number> = { river: 12, canal: 8, stream: 2, ditch: 1, drain: 1 };

// Small, usually single-storey building types; everything else defaults to three floors,
// a fair guess for the city centers this tool is mostly used on.
const ONE_LEVEL = /^(garage|garages|shed|carport|kiosk|hut|cabin|roof|service|toilets|greenhouse)$/;
const TWO_LEVELS = /^(house|detached|semidetached_house|terrace|bungalow|farm|static_caravan)$/;

function buildingHeight(t: Record<string, string>, isPart: boolean): Pick<Building, 'height' | 'minHeight' | 'heightFrom'> {
  const minHeight = parseLength(t.min_height) ?? (Number(t['building:min_level']) || 0) * LEVEL_HEIGHT;
  const tagged = parseLength(t.height) ?? parseLength(t['building:height']);
  if (tagged !== undefined && tagged > minHeight) return { height: tagged, minHeight, heightFrom: 'height' };
  const levels = Number(t['building:levels']);
  if (levels > 0) {
    const roof = Number(t['roof:levels']) || 0;
    return { height: minHeight + (levels + roof) * LEVEL_HEIGHT, minHeight, heightFrom: 'levels' };
  }
  const type = isPart ? '' : t.building;
  const guess = ONE_LEVEL.test(type) ? 1 : TWO_LEVELS.test(type) ? 2 : 3;
  return { height: minHeight + guess * LEVEL_HEIGHT, minHeight, heightFrom: 'estimate' };
}

// "12", "12 m", "12.5m", "40'", "40 ft", "12'6\"" → meters.
export function parseLength(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const s = v.trim().toLowerCase().replace(',', '.');
  const feet = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in))?$/);
  if (feet) return (Number(feet[1]) + Number(feet[2] ?? 0) / 12) * 0.3048;
  const meters = s.match(/^(\d+(?:\.\d+)?)\s*m?$/);
  return meters ? Number(meters[1]) : undefined;
}

function addLine(out: Line[], el: OverpassElement, kind: string, width: number, ring: LngLat[]) {
  const path = coords(el.geometry);
  if (path.length > 1 && intersectsRing(path, ring)) out.push({ path, kind, width });
}

function addAreas(out: Area[], el: OverpassElement, kind: string, ring: LngLat[]) {
  for (const poly of polygons(el)) {
    if (intersectsRing(poly.outer, ring, true)) out.push({ ...poly, kind });
  }
}

// A closed way is one polygon; a multipolygon relation is any number, assembled from its
// member ways, which OSM splits wherever it likes.
function polygons(el: OverpassElement): Polygon[] {
  if (el.type === 'way') {
    const outer = coords(el.geometry);
    return outer.length >= 4 && same(outer[0], outer[outer.length - 1]) ? [{ outer, holes: [] }] : [];
  }
  const members = el.members ?? [];
  const outers = joinRings(members.filter((m) => m.role !== 'inner').map((m) => coords(m.geometry)));
  const inners = joinRings(members.filter((m) => m.role === 'inner').map((m) => coords(m.geometry)));
  const result = outers.map((outer) => ({ outer, holes: [] as LngLat[][] }));
  for (const hole of inners) result.find((p) => pointInRing(hole[0], p.outer))?.holes.push(hole);
  return result;
}

// Chain open paths end to end into closed rings; chains that never close are dropped.
function joinRings(paths: LngLat[][]): LngLat[][] {
  const open = paths.filter((p) => p.length > 1);
  const rings: LngLat[][] = [];
  while (open.length) {
    let ring = open.pop()!;
    let grew = true;
    while (grew && !same(ring[0], ring[ring.length - 1])) {
      grew = false;
      const end = ring[ring.length - 1];
      const i = open.findIndex((p) => same(p[0], end) || same(p[p.length - 1], end));
      if (i < 0) break;
      const [next] = open.splice(i, 1);
      ring = ring.concat(same(next[0], end) ? next.slice(1) : next.slice(0, -1).reverse());
      grew = true;
    }
    if (ring.length >= 4 && same(ring[0], ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}

// Overpass sends null for nodes it left out; those ways can't be drawn reliably.
function coords(geometry: OverpassElement['geometry']): LngLat[] {
  if (!geometry || geometry.some((g) => !g)) return [];
  return geometry.map((g) => [g!.lon, g!.lat]);
}

function same(a: LngLat, b: LngLat): boolean {
  return a[0] === b[0] && a[1] === b[1];
}
