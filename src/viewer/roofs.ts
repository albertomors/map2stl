// Roof shapes from OSM roof:shape. Every pitched roof here is a strip between the eave outline
// and an inner outline: squeezed onto the ridge line for gabled and hipped roofs, onto the
// center for pyramids, and through shrinking rings for domes and onions. Exact for rectangles,
// a fair approximation for other footprints.

import type { Color } from 'three';
import type { MeshBuilder, Vec3 } from './mesh';

// Footprint point in plan: [x, z] meters.
type P = [number, number];

// Default roof height when untagged, as a fraction of the footprint's narrow width.
const DEFAULT_PITCH: Record<string, number> = { gabled: 0.5, hipped: 0.4, pyramidal: 0.6, dome: 0.5, onion: 0.9, skillion: 0.25 };
const DOME_RINGS = 6;

export function defaultRoofHeight(shape: string | undefined, outer: P[]): number {
  if (!shape || shape === 'flat') return 0;
  const { halfW } = orientedBox(outer);
  return 2 * halfW * (DEFAULT_PITCH[canonical(shape)] ?? 0.4);
}

// Builds walls up to `eave` (already done by the caller) plus the roof from `eave` up by `rise`.
// Returns false for shapes it can't do, so the caller draws a flat top instead.
export function buildRoof(m: MeshBuilder, outer: P[], eave: number, rise: number, shape: string, color: Color, wallColor: Color): boolean {
  const kind = canonical(shape);
  if (rise <= 0.01 || kind === 'flat') return false;
  // Same direction round as the walls (negative signed area in plan), so the roof's faces
  // wind outward like theirs and the two join into one closed solid.
  if (signedArea(outer) >= 0) outer = [...outer].reverse();
  const box = orientedBox(outer);
  const [cx, cz] = box.center;
  const at = ([x, z]: P, y: number): Vec3 => [x, y, z];

  if (kind === 'skillion') {
    // One slope rising across the short side.
    const dir = box.shortAxis;
    const t = outer.map(([x, z]) => (x - cx) * dir[0] + (z - cz) * dir[1]);
    const lo = Math.min(...t);
    const span = Math.max(...t) - lo || 1;
    const heights = t.map((v) => eave + (rise * (v - lo)) / span);
    fanCap(m, outer.map((p, i) => at(p, heights[i])), color);
    // Fill the gap between the eave and the sloped top with wall.
    for (let i = 0; i < outer.length; i++) {
      const j = (i + 1) % outer.length;
      m.quad(at(outer[i], eave), at(outer[j], eave), at(outer[j], heights[j]), at(outer[i], heights[i]), wallColor);
    }
    return true;
  }

  if (kind === 'pyramidal') {
    strip(m, outer.map((p) => at(p, eave)), outer.map(() => at(box.center, eave + rise)), color);
    return true;
  }

  if (kind === 'dome' || kind === 'onion') {
    // Rings shrinking toward the center: a quarter circle, or a bulb that swells then tapers.
    let prev = outer.map((p) => at(p, eave));
    for (let k = 1; k <= DOME_RINGS; k++) {
      const a = (k / DOME_RINGS) * (Math.PI / 2);
      const scale = kind === 'dome' ? Math.cos(a) : Math.cos(a) * (1 + 0.45 * Math.sin(2 * a));
      const y = eave + rise * (kind === 'dome' ? Math.sin(a) : k / DOME_RINGS);
      const ring = outer.map(([x, z]) => at([cx + (x - cx) * scale, cz + (z - cz) * scale], y));
      strip(m, prev, ring, color);
      prev = ring;
    }
    return true;
  }

  // Gabled (ridge the full length) or hipped (ridge shortened by the width, slopes all round).
  // Each eave corner rises to its own point on the ridge (u along it). Both sides of the roof
  // meet on the ridge, so every side runs through *all* ridge points between its two ends:
  // otherwise one side's ridge edge would end where the other's doesn't, leaving hairline
  // gaps that break the printable solid.
  const [ux, uz] = box.longAxis;
  const ridge = kind === 'gabled' ? box.halfL : Math.max(0, box.halfL - box.halfW);
  const us = outer.map(([x, z]) => Math.max(-ridge, Math.min(ridge, (x - cx) * ux + (z - cz) * uz)));
  const stops = [...new Set(us)].sort((a, b) => a - b);
  const onRidge = (u: number) => at([cx + u * ux, cz + u * uz], eave + rise);
  const lower = outer.map((p) => at(p, eave));
  for (let i = 0; i < outer.length; i++) {
    const j = (i + 1) % outer.length;
    const [ui, uj] = [us[i], us[j]];
    // Ridge points from this side's end (uj) back to its start (ui).
    const chain = stops.filter((u) => u >= Math.min(ui, uj) && u <= Math.max(ui, uj));
    if (uj < ui) chain.reverse();
    if (chain.length < 2) {
      // Both corners rise to the same ridge point: a gable end (vertical) or a hip triangle.
      m.tri(lower[i], lower[j], onRidge(uj), color);
      continue;
    }
    m.tri(lower[i], lower[j], onRidge(chain[chain.length - 1]), color);
    for (let k = chain.length - 1; k > 0; k--) m.tri(lower[i], onRidge(chain[k]), onRidge(chain[k - 1]), color);
  }
  return true;
}

function canonical(shape: string): string {
  if (/^(gabled|saltbox|gambrel|round)$/.test(shape)) return 'gabled';
  if (/^(hipped|half-hipped|side_hipped|mansard|hipped-and-gabled)$/.test(shape)) return 'hipped';
  if (/^(pyramidal|cone)$/.test(shape)) return 'pyramidal';
  if (/^(dome|onion|skillion|flat)$/.test(shape)) return shape;
  return 'hipped';
}

// Quads between two rings with matching vertices (the inner may collapse to a point). The
// outline runs the same way round as the walls, so these wind outward like them.
function strip(m: MeshBuilder, lower: Vec3[], upper: Vec3[], color: Color) {
  for (let i = 0; i < lower.length; i++) {
    const j = (i + 1) % lower.length;
    m.tri(lower[i], lower[j], upper[j], color);
    m.tri(lower[i], upper[j], upper[i], color);
  }
}

function fanCap(m: MeshBuilder, ring: Vec3[], color: Color) {
  for (let i = 1; i < ring.length - 1; i++) m.tri(ring[0], ring[i + 1], ring[i], color, 'up');
}

// Smallest-area rectangle aligned with one of the footprint's edges.
function orientedBox(pts: P[]) {
  let best = { area: Infinity, center: [0, 0] as P, longAxis: [1, 0] as P, shortAxis: [0, 1] as P, halfL: 0, halfW: 0 };
  for (let i = 0; i < pts.length; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % pts.length];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 1e-6) continue;
    const a: P = [(x1 - x0) / len, (z1 - z0) / len];
    const b: P = [-a[1], a[0]];
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (const [x, z] of pts) {
      const pa = x * a[0] + z * a[1];
      const pb = x * b[0] + z * b[1];
      minA = Math.min(minA, pa); maxA = Math.max(maxA, pa);
      minB = Math.min(minB, pb); maxB = Math.max(maxB, pb);
    }
    const area = (maxA - minA) * (maxB - minB);
    if (area >= best.area) continue;
    const ca = (minA + maxA) / 2;
    const cb = (minB + maxB) / 2;
    const center: P = [ca * a[0] + cb * b[0], ca * a[1] + cb * b[1]];
    const ha = (maxA - minA) / 2;
    const hb = (maxB - minB) / 2;
    best = ha >= hb
      ? { area, center, longAxis: a, shortAxis: b, halfL: ha, halfW: hb }
      : { area, center, longAxis: b, shortAxis: a, halfL: hb, halfW: ha };
  }
  return best;
}

function signedArea(ring: P[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % ring.length];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}
