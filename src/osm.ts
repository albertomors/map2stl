// OpenStreetMap features inside the selection, sorted into the categories the model is built
// from. Buildings and structures get a height in meters (from tags, or estimated); lines get
// a width.

import { seaPolygons } from './coast';
import { bbox, centroid, intersectsRing, pointInRing, type LngLat } from './geo';
import type { OverpassElement } from './overpass';

export interface Polygon {
  outer: LngLat[];
  holes: LngLat[][];
}

export interface Building extends Polygon {
  id: string;
  // Meters above the ground: the walls run from minHeight to height (roof included).
  height: number;
  minHeight: number;
  heightFrom: 'height' | 'levels' | 'estimate';
  // OSM roof:shape (flat, gabled, hipped, dome, pyramidal…) and its height, part of `height`.
  roofShape?: string;
  roofHeight?: number;
  roofDirection?: number;
  colour?: string;
  roofColour?: string;
  name?: string;
}

export interface Line {
  path: LngLat[];
  kind: string;
  // Meters.
  width: number;
  // Raised above what's under it: bridges must not print flat on the river.
  bridge?: boolean;
  // The way's real end points, kept when the line is cut to the selection: a bridge's deck
  // height comes from its banks, not from the middle of the river where it was cut.
  ends?: [LngLat, LngLat];
}

export interface Area extends Polygon {
  kind: string;
}

// Piers, walls, towers…: built things that aren't buildings.
export interface StructureLine extends Line {
  height: number;
}

export interface StructureArea extends Area {
  height: number;
}

export interface Tower {
  at: LngLat;
  kind: string;
  height: number;
}

export interface OsmData {
  buildings: Building[];
  roads: Line[];
  railways: Line[];
  // Includes the sea, rebuilt from coastlines (kind "sea").
  waterAreas: Area[];
  waterways: Line[];
  green: Area[];
  trees: LngLat[];
  structureLines: StructureLine[];
  structureAreas: StructureArea[];
  towers: Tower[];
  // Sand, beach, rock, glacier…
  surfaces: Area[];
  // Squares, parking, sports pitches, airport aprons; runways and taxiways as lines.
  pavedAreas: Area[];
  pavedLines: Line[];
}

const LEVEL_HEIGHT = 3;
const RAIL = 'rail|light_rail|tram|subway|narrow_gauge|monorail|funicular';
const WATERWAY_LINE = 'river|canal|stream|ditch|drain';
const GREEN_LANDUSE = 'grass|forest|meadow|recreation_ground|village_green|cemetery|allotments|orchard|vineyard';
const GREEN_LEISURE = 'park|garden|playground|golf_course';
const GREEN_NATURAL = 'wood|scrub|grassland|heath';
const SURFACE_NATURAL = 'sand|beach|bare_rock|scree|shingle|glacier';
const PIER = 'pier|breakwater|groyne';
const WALL = 'wall|city_wall|retaining_wall';
const TOWER = 'tower|chimney|lighthouse|water_tower|mast|silo';
const AEROWAY = 'runway|taxiway|apron';
const PEDESTRIAN = /^(pedestrian|footway|cycleway|path|platform)$/;

// [bbox] is s,w,n,e. Features are cut to the real shape afterwards, in parse().
export function buildQuery([w, s, e, n]: [number, number, number, number]): string {
  const area = (filter: string) => `way${filter};relation${filter}["type"="multipolygon"];`;
  return `[out:json][timeout:120][maxsize:536870912][bbox:${s},${w},${n},${e}];
(
  ${area('["building"]')}
  ${area('["building:part"]')}
  way["highway"];
  relation["highway"]["type"="multipolygon"];
  ${area('["area:highway"]')}
  way["railway"~"^(${RAIL})$"];
  ${area(`["aeroway"~"^(${AEROWAY})$"]`)}
  ${area('["natural"="water"]')}
  ${area('["waterway"="riverbank"]')}
  ${area('["landuse"~"^(reservoir|basin)$"]')}
  way["waterway"~"^(${WATERWAY_LINE})$"];
  way["natural"="coastline"];
  ${area(`["landuse"~"^(${GREEN_LANDUSE})$"]`)}
  ${area(`["leisure"~"^(${GREEN_LEISURE}|pitch|track)$"]`)}
  ${area(`["natural"~"^(${GREEN_NATURAL}|${SURFACE_NATURAL})$"]`)}
  ${area('["amenity"="parking"]')}
  ${area('["man_made"="bridge"]')}
  ${area(`["man_made"~"^(${PIER})$"]`)}
  way["barrier"~"^(${WALL})$"];
  way["historic"="city_walls"];
  nw["man_made"~"^(${TOWER})$"];
  node["natural"="tree"];
);
out geom qt;`;
}

export function parse(elements: OverpassElement[], ring: LngLat[]): OsmData {
  const data: OsmData = {
    buildings: [], roads: [], railways: [], waterAreas: [], waterways: [], green: [], trees: [],
    structureLines: [], structureAreas: [], towers: [], surfaces: [], pavedAreas: [], pavedLines: [],
  };
  const outlines: Building[] = [];
  const parts: Building[] = [];
  const coast: LngLat[][] = [];

  for (const el of elements) {
    const t = el.tags ?? {};

    if (el.type === 'node') {
      if (el.lon === undefined || el.lat === undefined) continue;
      const p: LngLat = [el.lon, el.lat];
      if (!pointInRing(p, ring)) continue;
      if (t.natural === 'tree') data.trees.push(p);
      else if (t.man_made) data.towers.push({ at: p, kind: t.man_made, height: towerHeight(t) });
      continue;
    }

    // Kept whole and unclipped: the sea is rebuilt from them below.
    if (t.natural === 'coastline') {
      const path = coords(el.geometry);
      if (path.length > 1) coast.push(path);
      continue;
    }

    const isPart = !!t['building:part'] && t['building:part'] !== 'no';
    if (isPart || (t.building && t.building !== 'no')) {
      // Everything touching the selection: the 3D view and export cut it at the edge.
      for (const poly of polygons(el)) {
        if (!intersectsRing(poly.outer, ring, true)) continue;
        (isPart ? parts : outlines).push({ ...poly, id: `${el.type}/${el.id}`, ...buildingHeight(t, isPart), ...roof(t), name: t.name });
      }
      continue;
    }

    // Underground features don't belong in a printed model.
    if (t.tunnel && t.tunnel !== 'no') continue;
    if (t.layer && Number(t.layer) < 0) continue;
    const bridge = !!t.bridge && t.bridge !== 'no';
    const closedArea = t.area === 'yes' || el.type === 'relation';

    const surface = t['area:highway'];
    if (surface && !PEDESTRIAN.test(surface)) {
      // Carriageway outlines: the road center lines already cover them.
      continue;
    } else if (surface || (t.highway && closedArea)) {
      addAreas(data.pavedAreas, el, surface ?? t.highway, ring);
    } else if (t.highway) {
      if (/^(proposed|construction|platform|elevator|corridor)$/.test(t.highway)) continue;
      addLine(data.roads, el, t.highway, parseLength(t.width) ?? ROAD_WIDTH[t.highway] ?? 3, ring, bridge);
    } else if (t.railway) {
      addLine(data.railways, el, t.railway, t.railway === 'tram' ? 2.5 : 3.5, ring, bridge);
    } else if (t.aeroway) {
      // Runways and taxiways are usually drawn as center lines, aprons as areas.
      if (t.aeroway === 'apron' || closedArea) addAreas(data.pavedAreas, el, t.aeroway, ring);
      else addLine(data.pavedLines, el, t.aeroway, parseLength(t.width) ?? (t.aeroway === 'runway' ? 45 : 23), ring);
    } else if (t.natural === 'water' || t.waterway === 'riverbank' || /^(reservoir|basin)$/.test(t.landuse ?? '')) {
      addAreas(data.waterAreas, el, t.water ?? t.natural ?? t.landuse ?? 'water', ring);
    } else if (t.waterway) {
      if (t.culvert || t.covered === 'yes') continue;
      addLine(data.waterways, el, t.waterway, parseLength(t.width) ?? WATERWAY_WIDTH[t.waterway] ?? 2, ring, bridge);
    } else if (t.man_made === 'bridge') {
      // The deck outline; the roads on it carry bridge=yes too.
      for (const poly of polygons(el)) {
        if (intersectsRing(poly.outer, ring, true)) data.structureAreas.push({ ...poly, kind: 'bridge', height: 1 });
      }
    } else if (t.man_made && new RegExp(`^(${PIER})$`).test(t.man_made)) {
      const height = parseLength(t.height) ?? 1;
      // Closed outlines are the pier itself; open ways are its center line.
      const polys = polygons(el);
      if (polys.length) {
        for (const poly of polys) if (intersectsRing(poly.outer, ring, true)) data.structureAreas.push({ ...poly, kind: t.man_made, height });
      } else {
        addStructureLine(data.structureLines, el, t.man_made, parseLength(t.width) ?? 4, height, ring);
      }
    } else if (t.man_made && new RegExp(`^(${TOWER})$`).test(t.man_made)) {
      // Towers drawn as outlines without a building tag.
      for (const poly of polygons(el)) {
        if (pointInRing(centroid(poly.outer), ring)) data.structureAreas.push({ ...poly, kind: t.man_made, height: towerHeight(t) });
      }
    } else if (new RegExp(`^(${WALL})$`).test(t.barrier ?? '') || t.historic === 'city_walls') {
      const kind = t.historic === 'city_walls' ? 'city_wall' : t.barrier;
      const big = kind === 'city_wall';
      const height = parseLength(t.height) ?? (big ? 6 : 2);
      addStructureLine(data.structureLines, el, kind, parseLength(t.width) ?? (big ? 2 : 0.4), height, ring);
    } else if (t.amenity === 'parking' || t.leisure === 'pitch' || t.leisure === 'track') {
      // A running track is usually a closed loop drawn as a way: an area here.
      addAreas(data.pavedAreas, el, t.amenity ?? t.sport ?? t.leisure, ring);
    } else if (t.natural && new RegExp(`^(${SURFACE_NATURAL})$`).test(t.natural)) {
      addAreas(data.surfaces, el, t.natural, ring);
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

  for (const sea of seaPolygons(coast, bbox(ring))) {
    if (intersectsRing(sea.outer, ring, true)) data.waterAreas.push({ ...sea, kind: 'sea' });
  }
  return data;
}

function roof(t: Record<string, string>): Pick<Building, 'roofShape' | 'roofHeight' | 'roofDirection' | 'colour' | 'roofColour'> {
  const levels = Number(t['roof:levels']);
  return {
    roofShape: t['roof:shape'],
    roofHeight: parseLength(t['roof:height']) ?? (levels > 0 ? levels * LEVEL_HEIGHT : undefined),
    roofDirection: parseDirection(t['roof:direction']),
    colour: t['building:colour'],
    roofColour: t['roof:colour'],
  };
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

// "135" or "SE" → degrees.
function parseDirection(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const i = COMPASS.indexOf(v.trim().toUpperCase());
  if (i >= 0) return i * 22.5;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Typical heights when untagged: these stand out of a printed skyline.
// Untagged masts are mostly street lighting and flagpoles, so they stay short.
const TOWER_HEIGHT: Record<string, number> = { chimney: 40, mast: 12, tower: 25, lighthouse: 20, water_tower: 25, silo: 20 };

function towerHeight(t: Record<string, string>): number {
  return parseLength(t.height) ?? TOWER_HEIGHT[t.man_made] ?? 20;
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

function addLine(out: Line[], el: OverpassElement, kind: string, width: number, ring: LngLat[], bridge = false) {
  const path = coords(el.geometry);
  if (path.length > 1 && intersectsRing(path, ring)) out.push({ path, kind, width, ...(bridge ? { bridge } : {}) });
}

function addStructureLine(out: StructureLine[], el: OverpassElement, kind: string, width: number, height: number, ring: LngLat[]) {
  const path = coords(el.geometry);
  if (path.length > 1 && intersectsRing(path, ring)) out.push({ path, kind, width, height });
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
