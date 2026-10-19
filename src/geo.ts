// Spherical geometry helpers for selection shapes.
// Coordinates are [lng, lat] in degrees, distances in meters.

export type LngLat = [number, number];

const EARTH_RADIUS = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function distance(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(h));
}

// Point reached from `start` after `meters` along `bearing` (degrees, 0 = north).
export function destination(start: LngLat, meters: number, bearing: number): LngLat {
  const d = meters / EARTH_RADIUS;
  const b = rad(bearing);
  const lat1 = rad(start[1]);
  const lng1 = rad(start[0]);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return [deg(lng2), deg(lat2)];
}

// Initial compass bearing (degrees) from `a` toward `b`.
export function bearingTo(a: LngLat, b: LngLat): number {
  const lat1 = rad(a[1]);
  const lat2 = rad(b[1]);
  const dLng = rad(b[0] - a[0]);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return deg(Math.atan2(y, x));
}

// Area of a closed ring in square meters (same method as turf's ringArea).
export function ringArea(ring: LngLat[]): number {
  let total = 0;
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % n];
    const p3 = ring[(i + 2) % n];
    total += (rad(p3[0]) - rad(p1[0])) * Math.sin(rad(p2[1]));
  }
  return Math.abs((total * EARTH_RADIUS * EARTH_RADIUS) / 2);
}

export function bbox(ring: LngLat[]): [number, number, number, number] {
  const lngs = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
}

// Ray casting in lng/lat: fine for city-sized shapes away from the poles.
export function pointInRing(p: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentsCross(a: LngLat, b: LngLat, c: LngLat, d: LngLat): boolean {
  const side = (p: LngLat, q: LngLat, r: LngLat) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

// Whether a path (or closed area, when `area` is set) touches the ring at all.
export function intersectsRing(path: LngLat[], ring: LngLat[], area = false): boolean {
  if (path.some((p) => pointInRing(p, ring))) return true;
  // An area can cover the whole ring without a vertex inside it.
  if (area && pointInRing(ring[0], path)) return true;
  for (let i = 1; i < path.length; i++) {
    for (let j = 1; j < ring.length; j++) {
      if (segmentsCross(path[i - 1], path[i], ring[j - 1], ring[j])) return true;
    }
  }
  return false;
}

// Vertex average: good enough to decide which side of the selection a building is on.
export function centroid(ring: LngLat[]): LngLat {
  const n = ring.length > 1 && ring[0] === ring[ring.length - 1] ? ring.length - 1 : ring.length;
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    x += ring[i][0];
    y += ring[i][1];
  }
  return [x / n, y / n];
}

export function pathLength(path: LngLat[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += distance(path[i - 1], path[i]);
  return total;
}
