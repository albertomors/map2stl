// Sea polygons from coastlines. OSM has no "sea" areas: the coast is a set of lines drawn
// with the land on the left and the water on the right. Inside a box that is enough to
// rebuild the water: cut the coast to the box, then walk each piece and the box edge
// between pieces, always keeping the water on the right.

import type { LngLat } from './geo';
import { pointInRing } from './geo';
import type { Polygon } from './osm';

type Box = [number, number, number, number];

const EPS = 1e-9;

export function seaPolygons(coastWays: LngLat[][], box: Box): Polygon[] {
  const pieces: LngLat[][] = [];
  // Coastline loops wholly inside the box: islands, drawn counterclockwise (land inside).
  const islands: LngLat[][] = [];

  for (const chain of joinChains(coastWays)) {
    const closed = same(chain[0], chain[chain.length - 1]);
    const parts = clip(chain, box);
    if (closed && parts.length === 1 && same(parts[0][0], parts[0][parts[0].length - 1])) {
      islands.push(parts[0]);
      continue;
    }
    // A broken coast that stops inside the box can't say where the water is: skip it.
    pieces.push(...parts.filter((p) => onEdge(p[0], box) && onEdge(p[p.length - 1], box)));
  }

  let seas: LngLat[][] = [];
  if (pieces.length) {
    seas = trace(pieces, box);
  } else if (islands.length) {
    // Only islands: the coast never crosses the box, so everything around them is sea.
    const [w, s, e, n] = box;
    seas = [[[w, n], [e, n], [e, s], [w, s], [w, n]]];
  }
  // No coast at all: the box is all land (or all sea, which a city selection never is).

  const result = seas.map((outer) => ({ outer, holes: [] as LngLat[][] }));
  for (const island of islands) result.find((p) => pointInRing(island[0], p.outer))?.holes.push(island);
  return result;
}

// Join ways end to start (direction matters: it says which side is water).
function joinChains(ways: LngLat[][]): LngLat[][] {
  const open = ways.filter((w) => w.length > 1).map((w) => [...w]);
  const chains: LngLat[][] = [];
  while (open.length) {
    let chain = open.pop()!;
    for (let grew = true; grew && !same(chain[0], chain[chain.length - 1]); ) {
      grew = false;
      const after = open.findIndex((w) => same(w[0], chain[chain.length - 1]));
      if (after >= 0) {
        chain = chain.concat(open.splice(after, 1)[0].slice(1));
        grew = true;
        continue;
      }
      const before = open.findIndex((w) => same(w[w.length - 1], chain[0]));
      if (before >= 0) {
        chain = open.splice(before, 1)[0].slice(0, -1).concat(chain);
        grew = true;
      }
    }
    chains.push(chain);
  }
  return chains;
}

// Cut a line into the pieces that lie inside the box (Liang–Barsky on each segment).
function clip(path: LngLat[], [w, s, e, n]: Box): LngLat[][] {
  const pieces: LngLat[][] = [];
  let current: LngLat[] | null = null;
  for (let i = 1; i < path.length; i++) {
    const [x0, y0] = path[i - 1];
    const [x1, y1] = path[i];
    const dx = x1 - x0;
    const dy = y1 - y0;
    let t0 = 0;
    let t1 = 1;
    let visible = true;
    for (const [p, q] of [[-dx, x0 - w], [dx, e - x0], [-dy, y0 - s], [dy, n - y0]]) {
      if (p === 0) {
        if (q < 0) visible = false;
        continue;
      }
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
    }
    if (!visible || t0 > t1) {
      if (current) pieces.push(current);
      current = null;
      continue;
    }
    const at = (t: number): LngLat => [x0 + t * dx, y0 + t * dy];
    if (!current) current = [at(t0)];
    current.push(at(t1));
    if (t1 < 1) {
      pieces.push(current);
      current = null;
    }
  }
  if (current) pieces.push(current);

  // A closed loop that starts inside the box was cut at its start: rejoin the two ends.
  if (pieces.length > 1 && same(path[0], path[path.length - 1])) {
    const first = pieces[0];
    const last = pieces[pieces.length - 1];
    if (same(first[0], path[0]) && same(last[last.length - 1], path[0])) {
      pieces[0] = last.concat(first.slice(1));
      pieces.pop();
    }
  }
  return pieces;
}

// Follow piece → box edge (clockwise, water on the right) → next piece … until back at the start.
function trace(pieces: LngLat[][], box: Box): LngLat[][] {
  const rings: LngLat[][] = [];
  const used = new Set<number>();
  for (let startIdx = 0; startIdx < pieces.length; startIdx++) {
    if (used.has(startIdx)) continue;
    const ring: LngLat[] = [];
    let idx = startIdx;
    for (let guard = 0; guard <= pieces.length; guard++) {
      used.add(idx);
      ring.push(...pieces[idx]);
      const exit = perimeter(pieces[idx][pieces[idx].length - 1], box);
      // The next piece to enter, going clockwise from where this one left.
      let next = -1;
      let best = Infinity;
      for (let j = 0; j < pieces.length; j++) {
        if (used.has(j) && j !== startIdx) continue;
        const d = (perimeter(pieces[j][0], box) - exit + 4) % 4;
        if (d < best) {
          best = d;
          next = j;
        }
      }
      // Box corners passed on the way there.
      const corners = cornersBetween(exit, exit + best, box);
      ring.push(...corners);
      if (next === startIdx || next < 0) break;
      idx = next;
    }
    ring.push(ring[0]);
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

// Position along the box edge, clockwise from the north-west corner: 0–1 top, 1–2 right,
// 2–3 bottom, 3–4 left.
function perimeter([x, y]: LngLat, [w, s, e, n]: Box): number {
  if (Math.abs(y - n) < EPS) return (x - w) / (e - w);
  if (Math.abs(x - e) < EPS) return 1 + (n - y) / (n - s);
  if (Math.abs(y - s) < EPS) return 2 + (e - x) / (e - w);
  return 3 + (y - s) / (n - s);
}

function cornersBetween(from: number, to: number, [w, s, e, n]: Box): LngLat[] {
  const corners: LngLat[] = [[e, n], [e, s], [w, s], [w, n]];
  const out: LngLat[] = [];
  for (let c = Math.floor(from) + 1; c <= to; c++) out.push(corners[(c - 1) % 4]);
  return out;
}

function onEdge([x, y]: LngLat, [w, s, e, n]: Box): boolean {
  return Math.abs(x - w) < EPS || Math.abs(x - e) < EPS || Math.abs(y - s) < EPS || Math.abs(y - n) < EPS;
}

function same(a: LngLat, b: LngLat): boolean {
  return a[0] === b[0] && a[1] === b[1];
}
