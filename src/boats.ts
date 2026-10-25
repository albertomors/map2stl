// Boats moored at piers, a few here and there: OSM rarely maps boats, but a harbor without
// any looks deserted. Along each side of a pier facing water, berths are walked one boat
// length and a gap at a time, and some of them get a boat, lying alongside, a little varied
// in size, with or without a cabin. All of it from the pier's id and the berth's number, so
// the same place gets the same boats every time. Boats sit on the water, so they come and go
// with the Water layer, and each can be selected and deleted like a tree.

import { pointInRing, type LngLat } from './geo';
import { LocalFrame } from './local';
import type { Area, OsmData } from './osm';

export interface Boat {
  key: string;
  at: LngLat;
  // Direction of the bow, radians from east, counterclockwise looking down (scene x, -z).
  heading: number;
  length: number;
  beam: number;
  cabin: boolean;
  // Which hull color (objects.ts).
  paint: number;
}

const PIER = /^pier$/;
// Boat length, gap to the next berth, the share of berths taken, and how far off the pier
// a boat lies past its half beam (fenders, slack).
const LENGTH_M = [5, 14];
const GAP_M = [2, 10];
const TAKEN = 0.4;
const OFF_M = 0.8;
const BEAM = 0.36;
const CABIN = 0.6;
export const BOAT_PAINTS = 4;

export function mooredBoats(osm: OsmData): Boat[] {
  const water = osm.waterAreas.map((a) => ({ area: a, box: box(a.outer) }));
  if (!water.length) return [];
  const inWater = (p: LngLat) =>
    water.some(({ area, box: [w, s, e, n] }) => p[0] >= w && p[0] <= e && p[1] >= s && p[1] <= n && inside(area, p));
  // Sides to moor along: each pier line both ways (offset by its half width), each pier
  // outline's edges outward.
  const sides: { id: string; path: LngLat[]; off: number }[] = [];
  for (const l of osm.structureLines) {
    if (!PIER.test(l.kind)) continue;
    sides.push({ id: `${l.id}/l`, path: l.path, off: l.width / 2 }, { id: `${l.id}/r`, path: [...l.path].reverse(), off: l.width / 2 });
  }
  for (const a of osm.structureAreas) {
    if (!PIER.test(a.kind)) continue;
    // Counterclockwise (lng east, lat north): the outward side is on the right.
    const ring = signedArea(a.outer) > 0 ? a.outer : [...a.outer].reverse();
    sides.push({ id: `${a.id}/o`, path: [...ring, ring[0]], off: 0 });
  }
  if (!sides.length) return [];
  // Not on a pier's own outline.
  const decks = osm.structureAreas.filter((a) => PIER.test(a.kind)).map((a) => ({ area: a, box: box(a.outer) }));
  const onDeck = (p: LngLat) => decks.some(({ area, box: [w, s, e, n] }) => p[0] >= w && p[0] <= e && p[1] >= s && p[1] <= n && inside(area, p));

  const frame = new LocalFrame(sides[0].path[0]);
  const boats: Boat[] = [];
  const placed: { x: number; z: number; r: number }[] = [];
  for (const side of sides) {
    const seed = stringHash(side.id);
    const pts = side.path.map((p) => frame.toLocal(p));
    let berth = 0;
    // Walked along the side: `next` is where the next berth starts, in meters along it.
    let along = 0;
    let next = 0;
    for (let i = 1; i < pts.length; i++) {
      const [x0, z0] = pts[i - 1];
      const [x1, z1] = pts[i];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 1e-6) continue;
      const [ux, uz] = [(x1 - x0) / len, (z1 - z0) / len];
      // Right of the direction of travel, in plan with z south.
      const [nx, nz] = [-uz, ux];
      while (next + LENGTH_M[1] <= along + len) {
        const r = [hash(seed, berth, 1), hash(seed, berth, 2), hash(seed, berth, 3), hash(seed, berth, 4), hash(seed, berth, 5)];
        const length = LENGTH_M[0] + (LENGTH_M[1] - LENGTH_M[0]) * r[0];
        const beam = length * BEAM;
        const t = next - along + length / 2;
        const off = side.off + beam / 2 + OFF_M;
        const [cx, cz] = [x0 + ux * t + nx * off, z0 + uz * t + nz * off];
        const ends = [-1, 1].map((k): LngLat => frame.toLngLat([cx + (ux * k * length) / 2, cz + (uz * k * length) / 2]));
        const at = frame.toLngLat([cx, cz]);
        const free = !placed.some((b) => Math.hypot(b.x - cx, b.z - cz) < b.r + length / 2);
        if (r[1] < TAKEN && t + length / 2 <= len && free && inWater(at) && ends.every(inWater) && !onDeck(at) && !ends.some(onDeck)) {
          placed.push({ x: cx, z: cz, r: length / 2 });
          boats.push({
            key: `boat/${side.id}/${berth}`,
            at,
            // Bow one way or the other.
            heading: Math.atan2(-uz, ux) + (r[2] < 0.5 ? 0 : Math.PI),
            length,
            beam,
            cabin: r[3] < CABIN,
            paint: Math.floor(r[4] * BOAT_PAINTS),
          });
        }
        next += length + GAP_M[0] + (GAP_M[1] - GAP_M[0]) * hash(seed, berth, 6);
        berth++;
      }
      along += len;
      next = Math.max(next, along);
    }
  }
  return boats;
}

// Whether a boat lies wholly inside a ring (the selection): its four corners.
export function boatInside(b: Boat, ring: LngLat[]): boolean {
  const frame = new LocalFrame(b.at);
  const [ux, uz] = [Math.cos(b.heading), -Math.sin(b.heading)];
  return [-1, 1].every((i) =>
    [-1, 1].every((j) => pointInRing(frame.toLngLat([(ux * i * b.length - uz * j * b.beam) / 2, (uz * i * b.length + ux * j * b.beam) / 2]), ring)),
  );
}

const inside = (a: Area, p: LngLat) => pointInRing(p, a.outer) && !a.holes.some((h) => pointInRing(p, h));

function box(ring: LngLat[]): [number, number, number, number] {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of ring) [w, e, s, n] = [Math.min(w, x), Math.max(e, x), Math.min(s, y), Math.max(n, y)];
  return [w, s, e, n];
}

function signedArea(r: LngLat[]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x0, y0] = r[i];
    const [x1, y1] = r[(i + 1) % r.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

function stringHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h | 0;
}

// A number in [0, 1) from integers, the same every time.
function hash(x: number, y: number, k: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(k, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
