// The ground as a printable-looking tile: the terrain grid cut to the selection shape, with
// side walls down to a flat base. The top carries UVs for the painted ground texture.

import { BufferGeometry, Float32BufferAttribute, ShapeUtils, Vector2 } from 'three';
import { pointInRing, type LngLat } from '../geo';
import type { LocalFrame } from '../local';
import { pixelLngLat, type Terrain } from '../terrain';

// Finer than this is wasted on screen and slow to build.
const MAX_GRID = 512;

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface TerrainMesh {
  top: BufferGeometry;
  sides: BufferGeometry;
  // Base of the tile, in scene units (meters × exaggeration).
  baseY: number;
}

// `ground(h)` turns a terrain height into the scene height (sea clamp, exaggeration).
export function buildTerrain(
  t: Terrain,
  ring: LngLat[],
  frame: LocalFrame,
  bounds: Bounds,
  ground: (h: number) => number,
  baseDepth: number,
): TerrainMesh {
  const step = Math.ceil(Math.max(t.width, t.height) / MAX_GRID);
  const cols = Math.ceil(t.width / step);
  const rows = Math.ceil(t.height / step);

  const pos: number[] = [];
  const uv: number[] = [];
  const inside: boolean[] = [];
  let minY = Infinity;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const col = Math.min(c * step, t.width - 1);
      const row = Math.min(r * step, t.height - 1);
      const lngLat = pixelLngLat(t, col, row);
      const [x, z] = frame.toLocal(lngLat);
      const y = ground(t.heights[row * t.width + col]);
      pos.push(x, y, z);
      uv.push((x - bounds.minX) / (bounds.maxX - bounds.minX), 1 - (z - bounds.minZ) / (bounds.maxZ - bounds.minZ));
      const isIn = pointInRing(lngLat, ring);
      inside.push(isIn);
      if (isIn && y < minY) minY = y;
    }
  }
  const baseY = minY - baseDepth;

  // Keep the cells wholly inside the shape; edges used by a single kept triangle are the rim.
  const index: number[] = [];
  const rim = new Map<string, [number, number]>();
  const addTri = (a: number, b: number, c: number) => {
    if (!inside[a] || !inside[b] || !inside[c]) return;
    index.push(a, b, c);
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = p < q ? `${p},${q}` : `${q},${p}`;
      if (rim.has(key)) rim.delete(key);
      else rim.set(key, [p, q]);
    }
  };
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      // Counterclockwise seen from above (+y), so the faces point up.
      addTri(a, d, b);
      addTri(b, d, e);
    }
  }

  const top = new BufferGeometry();
  top.setAttribute('position', new Float32BufferAttribute(pos, 3));
  top.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  top.setIndex(index);
  top.computeVertexNormals();

  // A vertical wall under every rim edge, and a flat base in the selection's outline.
  const side: number[] = [];
  const v = (i: number) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
  for (const [p, q] of rim.values()) {
    const [px, py, pz] = v(p);
    const [qx, qy, qz] = v(q);
    // Rim edges run counterclockwise around the top, so this winding faces outward.
    side.push(px, py, pz, px, baseY, pz, qx, qy, qz);
    side.push(qx, qy, qz, px, baseY, pz, qx, baseY, qz);
  }
  // Triangulated, not fanned from the center: free shapes can be concave.
  const outline = ring.slice(0, -1).map((p) => new Vector2(...frame.toLocal(p)));
  for (const tri of ShapeUtils.triangulateShape(outline, [])) {
    for (const i of tri) side.push(outline[i].x, baseY, outline[i].y);
  }
  const sides = new BufferGeometry();
  sides.setAttribute('position', new Float32BufferAttribute(side, 3));
  sides.computeVertexNormals();
  return { top, sides, baseY };
}
