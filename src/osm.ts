// OpenStreetMap features inside the selection, sorted into the categories the model is built
// from. Buildings and structures get a height in meters (from tags, or estimated); lines get
// a width.

import { seaFromTiles, seaPolygons } from './coast';
import { bbox, centroid, intersectsRing, pointInRing, ringArea, type LngLat } from './geo';
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
  // Its Wikidata item ("Q39054"), the precise way to find a 3D model of a landmark.
  wikidata?: string;
  // For building:parts, the outline they belong to: a cathedral's nave, towers and spires
  // are selected and edited together, under the outline's name (and Wikidata item).
  group?: string;
  groupName?: string;
  groupWikidata?: string;
}

export interface Line {
  // OSM element ("way/123"), or a tile-data counter: edits and selection key on it.
  id: string;
  path: LngLat[];
  kind: string;
  name?: string;
  // Its Wikidata item, for finding a 3D model of a bridge.
  wikidata?: string;
  // Meters.
  width: number;
  // Raised above what's under it: bridges must not print flat on the river.
  bridge?: boolean;
  // The way's real end points, kept when the line is cut to the selection: a bridge's deck
  // height comes from its banks, not from the middle of the river where it was cut.
  ends?: [LngLat, LngLat];
}

export interface Area extends Polygon {
  // OSM element ("way/123", "relation/45"; every polygon of a multipolygon shares it), or a
  // tile-data counter: edits and selection key on it.
  id: string;
  kind: string;
  name?: string;
  wikidata?: string;
}

// Salt water at sea level: the sea (rebuilt from coastlines), and harbors, bays and straits
// mapped as water areas (Sydney's Port Jackson has no coastline inside it).
export const isSea = (a: { kind: string }) => /^(sea|harbour|bay|strait)$/.test(a.kind);

// Piers, walls, towers…: built things that aren't buildings.
export interface StructureLine extends Line {
  height: number;
}

export interface StructureArea extends Area {
  id: string;
  height: number;
}

export interface Tower {
  id: string;
  at: LngLat;
  kind: string;
  height: number;
  // Girth multiplier from an edit (1 when untouched).
  size?: number;
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

// `tileSea`: the base map's ocean over the selection, for where the coastlines can't tell.
export function parse(elements: OverpassElement[], ring: LngLat[], tileSea: Polygon[] = []): OsmData {
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
      else if (t.man_made) data.towers.push({ id: `node/${el.id}`, at: p, kind: t.man_made, height: towerHeight(t) });
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
        (isPart ? parts : outlines).push({ ...poly, id: `${el.type}/${el.id}`, ...buildingHeight(t, isPart), ...roof(t), name: t.name, wikidata: wikidataOf(t) });
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
        if (intersectsRing(poly.outer, ring, true)) data.structureAreas.push({ ...poly, id: `${el.type}/${el.id}`, kind: 'bridge', height: 1, name: t.name, wikidata: wikidataOf(t) });
      }
    } else if (t.man_made && new RegExp(`^(${PIER})$`).test(t.man_made)) {
      const height = parseLength(t.height) ?? 1;
      // Closed outlines are the pier itself; open ways are its center line.
      const polys = polygons(el);
      if (polys.length) {
        for (const poly of polys) if (intersectsRing(poly.outer, ring, true)) data.structureAreas.push({ ...poly, id: `${el.type}/${el.id}`, kind: t.man_made, height });
      } else {
        addStructureLine(data.structureLines, el, t.man_made, parseLength(t.width) ?? 4, height, ring);
      }
    } else if (t.man_made && new RegExp(`^(${TOWER})$`).test(t.man_made)) {
      // Towers drawn as outlines without a building tag.
      for (const poly of polygons(el)) {
        if (pointInRing(centroid(poly.outer), ring)) data.structureAreas.push({ ...poly, id: `${el.type}/${el.id}`, kind: t.man_made, height: towerHeight(t) });
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
  // A part belongs to the outline that holds most of its corners (at least half of them, or
  // its center). Not just the outline around its center: an arched part, like the Eiffel
  // Tower's legs, has its center in the empty space under the arch, outside every outline.
  // Failing that, the outline holding any of its corners at all: parts often stick out past
  // a roughly drawn outline (Cologne Cathedral's nave roof).
  const covered = new Set<Building>();
  for (const part of parts) {
    const c = centroid(part.outer);
    const corners = part.outer.length - 1;
    let owner: Building | undefined;
    let best = -1;
    let fallback: Building | undefined;
    let fallbackHeld = 0;
    for (const o of outlines) {
      const held = part.outer.slice(0, -1).filter((p) => pointInRing(p, o.outer)).length;
      if (held * 2 < corners && !pointInRing(c, o.outer)) {
        if (held > fallbackHeld) [fallback, fallbackHeld] = [o, held];
        continue;
      }
      if (held > best || (held === best && owner && ringArea(o.outer) > ringArea(owner.outer))) {
        owner = o;
        best = held;
      }
    }
    owner ??= fallback;
    if (!owner) continue;
    covered.add(owner);
    part.group = owner.id;
    part.groupName = owner.name;
    part.groupWikidata = owner.wikidata;
  }
  groupOrphanParts(parts);
  fillUnderFloatingParts(parts);
  data.buildings = [...outlines.filter((o) => !covered.has(o)), ...parts];

  const box = bbox(ring);
  for (const sea of seaPolygons(coast, box) ?? seaFromTiles(tileSea, box)) {
    if (intersectsRing(sea.outer, ring, true)) data.waterAreas.push({ ...sea, id: 'sea', kind: 'sea' });
  }
  return data;
}

// Parts mapped without a building outline around them would each be selected on their own.
// Parts that touch or overlap are one building: group them (union-find), named after the
// part that has a name.
function groupOrphanParts(parts: Building[]) {
  const orphans = parts.filter((p) => !p.group);
  const root = orphans.map((_, i) => i);
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])));
  for (let i = 0; i < orphans.length; i++) {
    for (let j = i + 1; j < orphans.length; j++) {
      if (find(i) !== find(j) && footprintsMeet(orphans[i], orphans[j])) root[find(i)] = find(j);
    }
  }
  const members = new Map<number, Building[]>();
  orphans.forEach((p, i) => members.set(find(i), [...(members.get(find(i)) ?? []), p]));
  for (const group of members.values()) {
    if (group.length < 2) continue;
    const name = group.find((p) => p.name)?.name;
    const wikidata = group.find((p) => p.wikidata)?.wikidata;
    for (const p of group) {
      p.group = group[0].id;
      p.groupName = name;
      p.groupWikidata = wikidata;
    }
  }
}

// A part starting above the ground with nothing of its own building under it (mappers often
// draw a dome or a drum but not the body it stands on) would float, and can't be printed.
// Extend it down to the top of whatever of its building is under it, or to the ground. Parts
// resting on something even partly (a walkway between two towers) are left alone.
function fillUnderFloatingParts(parts: Building[]) {
  const byGroup = new Map<string, Building[]>();
  for (const p of parts) if (p.group) byGroup.set(p.group, [...(byGroup.get(p.group) ?? []), p]);
  for (const group of byGroup.values()) {
    // Bottom up, so a filled part can carry the ones above it.
    for (const p of [...group].sort((a, b) => a.minHeight - b.minHeight)) {
      if (p.minHeight <= 1) continue;
      // Only what's really under it: a neighbour touching it at a corner doesn't hold it up.
      const below = group.filter((q) => q !== p && q.minHeight < p.minHeight && footprintsOverlap(p, q));
      if (below.some((q) => q.height >= p.minHeight - 1.5)) continue;
      p.minHeight = Math.max(0, ...below.map((q) => q.height));
    }
  }
}

// Whether two footprints overlap: a corner or the center of one inside the other.
function footprintsOverlap(a: Polygon, b: Polygon): boolean {
  return (
    a.outer.some((p) => pointInRing(p, b.outer)) ||
    b.outer.some((p) => pointInRing(p, a.outer)) ||
    pointInRing(centroid(a.outer), b.outer) ||
    pointInRing(centroid(b.outer), a.outer)
  );
}

// Whether two footprints overlap or touch: a corner of one inside the other, or a shared corner.
function footprintsMeet(a: Polygon, b: Polygon): boolean {
  return (
    a.outer.some((p) => pointInRing(p, b.outer)) ||
    b.outer.some((p) => pointInRing(p, a.outer)) ||
    a.outer.some((p) => b.outer.some((q) => same(p, q)))
  );
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
  if (path.length > 1 && intersectsRing(path, ring)) out.push({ id: `${el.type}/${el.id}`, path, kind, name: el.tags?.name, wikidata: wikidataOf(el.tags ?? {}), width, ...(bridge ? { bridge } : {}) });
}

// A valid Wikidata item id from the tags, or nothing.
function wikidataOf(t: Record<string, string>): string | undefined {
  return /^Q\d+$/.test(t.wikidata ?? '') ? t.wikidata : undefined;
}

function addStructureLine(out: StructureLine[], el: OverpassElement, kind: string, width: number, height: number, ring: LngLat[]) {
  const path = coords(el.geometry);
  if (path.length > 1 && intersectsRing(path, ring)) out.push({ id: `${el.type}/${el.id}`, path, kind, width, height });
}

function addAreas(out: Area[], el: OverpassElement, kind: string, ring: LngLat[]) {
  for (const poly of polygons(el)) {
    if (intersectsRing(poly.outer, ring, true)) out.push({ ...poly, id: `${el.type}/${el.id}`, kind, name: el.tags?.name });
  }
}

// A closed way is one polygon; a multipolygon relation is any number, assembled from its
// member ways, which OSM splits wherever it likes. Rings nest even-odd, as map renderers
// draw them, whatever their roles say: a ring inside one ring is a hole, inside two an
// island in it. Roles get mistagged: the Colosseum's 48.5 m outer wall is two "outer"
// rings, and taken at their word the arena would fill up to the top of the wall.
function polygons(el: OverpassElement): Polygon[] {
  if (el.type === 'way') {
    const outer = coords(el.geometry);
    return outer.length >= 4 && same(outer[0], outer[outer.length - 1]) ? [{ outer, holes: [] }] : [];
  }
  const rings = joinRings((el.members ?? []).map((m) => coords(m.geometry)));
  // Inside: two of its points (a ring touching another at one point stays outside it).
  const inside = (a: LngLat[], b: LngLat[]) => a !== b && pointInRing(a[0], b) && pointInRing(a[a.length >> 1], b);
  const containers = rings.map((r) => rings.filter((o) => inside(r, o)));
  const result: { outer: LngLat[]; holes: LngLat[][] }[] = [];
  const outerOf = new Map<LngLat[], { outer: LngLat[]; holes: LngLat[][] }>();
  rings.forEach((r, i) => {
    if (containers[i].length % 2 === 0) {
      const poly = { outer: r, holes: [] as LngLat[][] };
      result.push(poly);
      outerOf.set(r, poly);
    }
  });
  rings.forEach((r, i) => {
    if (containers[i].length % 2 === 0) return;
    // A hole of the innermost outer ring around it: the one with the most containers itself.
    const around = containers[i]
      .filter((o) => outerOf.has(o))
      .sort((a, b) => containers[rings.indexOf(b)].length - containers[rings.indexOf(a)].length)[0];
    if (around) outerOf.get(around)!.holes.push(r);
  });
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
