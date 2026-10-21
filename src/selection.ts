// The selected area: the single output of milestone 1 and the input of every later step.
// Stored as center + size + rotation, so it can be scaled and rotated in place;
// the outline ring is derived from those.

import { bbox, bearingTo, destination, distance, pointInRing, ringArea, type LngLat } from './geo';

export type ShapeKind = 'rectangle' | 'hexagon' | 'circle' | 'polygon';

export interface Selection {
  kind: ShapeKind;
  center: LngLat;
  // Half sizes in meters along the shape's own axes; equal for hexagon and circle (= radius).
  halfWidth: number;
  halfHeight: number;
  // Compass direction (degrees) of the shape's "up": the map bearing when it was drawn.
  rotation: number;
  // Free shapes only: the clicked points in the shape's own frame, scaled to -1…1 on each
  // axis, so scaling and rotating the shape just changes the fields above.
  points?: [number, number][];
}

// Point at (x right, y up) meters in the shape's own frame.
export function offset(sel: Pick<Selection, 'center' | 'rotation'>, x: number, y: number): LngLat {
  const bearing = sel.rotation + (Math.atan2(x, y) * 180) / Math.PI;
  return destination(sel.center, Math.hypot(x, y), bearing);
}

// Position of `p` in a frame centered on `origin` whose up points at `rotation`.
export function toFrame(origin: LngLat, rotation: number, p: LngLat): { x: number; y: number } {
  const d = distance(origin, p);
  const a = ((bearingTo(origin, p) - rotation) * Math.PI) / 180;
  return { x: d * Math.sin(a), y: d * Math.cos(a) };
}

// `a` is where the drag started, `b` where the pointer is now, `viewBearing` the map's bearing.
// Rectangle: a and b are opposite corners, edges parallel to the screen.
// Hexagon/circle: a is the center, flat top facing the top of the screen.
export function fromDrag(kind: ShapeKind, a: LngLat, b: LngLat, viewBearing: number): Selection {
  if (kind === 'rectangle') {
    const { x, y } = toFrame(a, viewBearing, b);
    return {
      kind,
      center: offset({ center: a, rotation: viewBearing }, x / 2, y / 2),
      halfWidth: Math.abs(x) / 2,
      halfHeight: Math.abs(y) / 2,
      rotation: viewBearing,
    };
  }
  const r = distance(a, b);
  return { kind, center: a, halfWidth: r, halfHeight: r, rotation: viewBearing };
}

// A free shape from clicked points, its up facing the top of the screen: framed by the
// points' bounding box in that orientation. The points are measured from the final center
// (directions on a sphere change with the origin, so re-centering by subtraction would
// shift and twist the shape slightly).
export function fromPoints(points: LngLat[], viewBearing: number): Selection {
  const n = points.length;
  let center: LngLat = [points.reduce((a, p) => a + p[0], 0) / n, points.reduce((a, p) => a + p[1], 0) / n];
  // Move the center to the middle of the bounding box; twice is plenty to settle.
  for (let i = 0; i < 2; i++) {
    const local = points.map((p) => toFrame(center, viewBearing, p));
    const cx = (Math.min(...local.map((p) => p.x)) + Math.max(...local.map((p) => p.x))) / 2;
    const cy = (Math.min(...local.map((p) => p.y)) + Math.max(...local.map((p) => p.y))) / 2;
    center = offset({ center, rotation: viewBearing }, cx, cy);
  }
  const local = points.map((p) => toFrame(center, viewBearing, p));
  const halfWidth = Math.max(...local.map((p) => Math.abs(p.x)), 1);
  const halfHeight = Math.max(...local.map((p) => Math.abs(p.y)), 1);
  return {
    kind: 'polygon',
    center,
    halfWidth,
    halfHeight,
    rotation: viewBearing,
    points: local.map((p) => [p.x / halfWidth, p.y / halfHeight]),
  };
}

export function ring(sel: Selection): LngLat[] {
  const { halfWidth: w, halfHeight: h } = sel;
  let pts: [number, number][];
  if (sel.kind === 'polygon') {
    pts = (sel.points ?? []).map(([x, y]) => [x * w, y * h]);
  } else if (sel.kind === 'rectangle') {
    pts = [[-w, -h], [w, -h], [w, h], [-w, h]];
  } else {
    // Hexagon vertices at 30°, 90°... from up give a flat top; the circle uses 96 points.
    const n = sel.kind === 'hexagon' ? 6 : 96;
    const start = sel.kind === 'hexagon' ? Math.PI / 6 : 0;
    pts = Array.from({ length: n }, (_, i) => {
      const a = start + (2 * Math.PI * i) / n;
      return [w * Math.sin(a), w * Math.cos(a)];
    });
  }
  const out = pts.map(([x, y]) => offset(sel, x, y));
  out.push(out[0]);
  return out;
}

// Where the edit handles sit, in the shape's own frame.
export function scaleHandle(sel: Selection): LngLat {
  const { halfWidth: w, halfHeight: h } = sel;
  if (sel.kind === 'rectangle' || sel.kind === 'polygon') return offset(sel, w, h);
  // Top-right vertex of the hexagon, or the matching point on the circle.
  const a = sel.kind === 'hexagon' ? Math.PI / 6 : Math.PI / 4;
  return offset(sel, w * Math.sin(a), w * Math.cos(a));
}

export function rotateHandle(sel: Selection): LngLat {
  const top = sel.kind === 'hexagon' ? (sel.halfWidth * Math.sqrt(3)) / 2 : sel.halfHeight;
  return offset(sel, 0, top + 0.25 * Math.max(sel.halfWidth, sel.halfHeight));
}

export interface SelectionInfo {
  ring: LngLat[];
  bbox: [number, number, number, number];
  widthM: number;
  heightM: number;
  areaM2: number;
}

export function describe(sel: Selection): SelectionInfo {
  const r = ring(sel);
  const w = 2 * sel.halfWidth;
  // A flat-top hexagon is √3·r tall.
  const h = sel.kind === 'hexagon' ? Math.sqrt(3) * sel.halfWidth : 2 * sel.halfHeight;
  return { ring: r, bbox: bbox(r), widthM: w, heightM: h, areaM2: ringArea(r) };
}

export function contains(sel: Selection, p: LngLat): boolean {
  return pointInRing(p, ring(sel));
}

export function toGeoJSON(sel: Selection): GeoJSON.Feature<GeoJSON.Polygon> {
  const info = describe(sel);
  return {
    type: 'Feature',
    properties: {
      kind: sel.kind,
      center: sel.center,
      rotation: Math.round(sel.rotation),
      widthM: Math.round(info.widthM),
      heightM: Math.round(info.heightM),
      areaM2: Math.round(info.areaM2),
    },
    geometry: { type: 'Polygon', coordinates: [info.ring] },
  };
}

const STORAGE_KEY = 'map2stl.selection.v2';

export function saveSelection(sel: Selection | null) {
  try {
    if (sel) localStorage.setItem(STORAGE_KEY, JSON.stringify(sel));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked (private window): the selection just won't survive a reload.
  }
}

export function loadSelection(): Selection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const sel = raw ? (JSON.parse(raw) as Selection) : null;
    if (!sel || !Array.isArray(sel.center) || typeof sel.rotation !== 'number') return null;
    return sel.kind !== 'polygon' || (sel.points?.length ?? 0) >= 3 ? sel : null;
  } catch {
    return null;
  }
}
