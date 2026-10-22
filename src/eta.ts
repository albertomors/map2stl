// How long the OSM download will take. Overpass time grows with the area and, more, with how
// much is in it, so the estimate uses the selection's area and a building count taken from the
// base map's vector tiles (free: they're already loaded). Starts from coefficients measured on
// the public servers; each real download is remembered and the fit moves toward this browser's
// experience.

import type { Map } from 'maplibre-gl';
import { pointInRing, type LngLat } from './geo';

export interface EtaInput {
  km2: number;
  // Buildings seen in the base map tiles, or null when they aren't loaded (zoomed out,
  // selection off screen).
  buildings: number | null;
}

interface Sample extends EtaInput {
  seconds: number;
}

// seconds = a + b·km² + c·(1000 buildings); the area-only form is used without a count.
// Fitted on real use (October 2026, 10 completed requests from 0.03 to 5.9 km²): the public
// server waits about 44 s before answering whatever the size, and then what costs time is how
// much comes back, which follows the building count (26,800 buildings: 47 MB, 62 s), not the
// area. Without a count, the area stands in for it.
const DEFAULT_FULL = [44, 0, 1.9];
const DEFAULT_AREA = [44, 3];
// v2: samples count buildings from the quick data (v1 counted those visible on the map).
const STORAGE_KEY = 'map2stl.eta-samples.v2';
const MAX_SAMPLES = 30;
// Below this many own samples, the defaults weigh in as if they were this many samples.
const PRIOR_WEIGHT = 4;

export function countBuildings(map: Map, ring: LngLat[]): number | null {
  if (map.getZoom() < 13) return null;
  // Tiles only exist for what's on screen: most of the shape must be visible.
  const bounds = map.getBounds();
  const visible = ring.filter((p) => bounds.contains(p)).length / ring.length;
  if (visible < 0.8) return null;
  const features = map.querySourceFeatures('openmaptiles', { sourceLayer: 'building' });
  if (!features.length) return null;
  // Tile edges split buildings into pieces with the same id: count each once.
  const seen = new Set<string | number>();
  let anonymous = 0;
  for (const f of features) {
    const g = f.geometry;
    const first = g.type === 'Polygon' ? g.coordinates[0][0] : g.type === 'MultiPolygon' ? g.coordinates[0][0][0] : null;
    if (!first || !pointInRing(first as LngLat, ring)) continue;
    if (f.id === undefined) anonymous++;
    else seen.add(f.id);
  }
  return seen.size + anonymous;
}

export function estimateSeconds(input: EtaInput): number {
  const samples = loadSamples();
  if (input.buildings !== null) {
    const own = samples.filter((s) => s.buildings !== null);
    const coef = fit(own.map((s) => [1, s.km2, s.buildings! / 1000]), own.map((s) => s.seconds), DEFAULT_FULL);
    return Math.max(3, coef[0] + coef[1] * input.km2 + coef[2] * (input.buildings / 1000));
  }
  const coef = fit(samples.map((s) => [1, s.km2]), samples.map((s) => s.seconds), DEFAULT_AREA);
  return Math.max(3, coef[0] + coef[1] * input.km2);
}

export function recordSample(input: EtaInput, seconds: number) {
  const samples = [...loadSamples(), { ...input, seconds }].slice(-MAX_SAMPLES);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(samples));
  } catch {
    // Storage blocked: the estimate just doesn't learn.
  }
}

function loadSamples(): Sample[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

// Least squares pulled toward the defaults (ridge regression around the prior), so a couple
// of slow downloads nudge the estimate instead of replacing it.
function fit(rows: number[][], y: number[], prior: number[]): number[] {
  const n = prior.length;
  const ata = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? PRIOR_WEIGHT : 0)));
  const atb = prior.map((p) => PRIOR_WEIGHT * p);
  rows.forEach((r, k) => {
    for (let i = 0; i < n; i++) {
      atb[i] += r[i] * y[k];
      for (let j = 0; j < n; j++) ata[i][j] += r[i] * r[j];
    }
  });
  const coef = solve(ata, atb) ?? prior;
  // A negative term would promise instant downloads for big areas: clamp at zero.
  return coef.map((c) => Math.max(c, 0));
}

// Gaussian elimination with partial pivoting; null if singular.
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-12) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}
