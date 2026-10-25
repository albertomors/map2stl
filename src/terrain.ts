// Ground elevation from AWS Terrain Tiles (Terrarium PNG: free, no API key, worldwide).
// Each pixel encodes meters as R*256 + G + B/256 - 32768. Returns a grid of heights
// covering the selection's bounding box, in Web Mercator pixel steps.

const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const TILE_SIZE = 256;
// Above z14 the tiles are mostly upsampled: more pixels, no more detail.
const MAX_ZOOM = 14;
const MAX_TILES = 16;

export interface TerrainSource {
  name: string;
  // Meters between heights, as fetched.
  resolutionM: number;
  // For the export, when the license asks for it.
  credit?: string;
}

export interface Terrain {
  // Grid size; heights[row * width + col], row 0 at the north edge.
  width: number;
  height: number;
  heights: Float32Array;
  // [west, south, east, north] of the grid's outer pixel edges.
  bbox: [number, number, number, number];
  min: number;
  max: number;
  zoom: number;
  // Where the heights come from (absent: AWS Terrain Tiles).
  source?: TerrainSource;
}

export async function fetchTerrain(
  [w, s, e, n]: [number, number, number, number],
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<Terrain> {
  // The most detailed zoom that still covers the box with a handful of tiles.
  let zoom = MAX_ZOOM;
  let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
  for (; zoom > 0; zoom--) {
    x0 = Math.floor(worldX(w, zoom));
    x1 = Math.ceil(worldX(e, zoom));
    y0 = Math.floor(worldY(n, zoom));
    y1 = Math.ceil(worldY(s, zoom));
    const tilesX = Math.floor((x1 - 1) / TILE_SIZE) - Math.floor(x0 / TILE_SIZE) + 1;
    const tilesY = Math.floor((y1 - 1) / TILE_SIZE) - Math.floor(y0 / TILE_SIZE) + 1;
    if (tilesX * tilesY <= MAX_TILES) break;
  }

  const width = x1 - x0;
  const height = y1 - y0;
  const heights = new Float32Array(width * height);
  const jobs: Promise<void>[] = [];
  let done = 0;
  const tx0 = Math.floor(x0 / TILE_SIZE);
  const ty0 = Math.floor(y0 / TILE_SIZE);
  const tx1 = Math.floor((x1 - 1) / TILE_SIZE);
  const ty1 = Math.floor((y1 - 1) / TILE_SIZE);
  const total = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
  onProgress(0, total);

  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(
        loadTile(zoom, tx, ty, signal).then((pixels) => {
          // Copy the part of this tile that falls inside the grid.
          const left = Math.max(x0, tx * TILE_SIZE);
          const right = Math.min(x1, (tx + 1) * TILE_SIZE);
          const top = Math.max(y0, ty * TILE_SIZE);
          const bottom = Math.min(y1, (ty + 1) * TILE_SIZE);
          for (let y = top; y < bottom; y++) {
            for (let x = left; x < right; x++) {
              const i = 4 * ((y - ty * TILE_SIZE) * TILE_SIZE + (x - tx * TILE_SIZE));
              heights[(y - y0) * width + (x - x0)] = pixels[i] * 256 + pixels[i + 1] + pixels[i + 2] / 256 - 32768;
            }
          }
          onProgress(++done, total);
        }),
      );
    }
  }
  await Promise.all(jobs);
  despike(heights, width, height);

  let min = Infinity;
  let max = -Infinity;
  for (const h of heights) {
    if (h < min) min = h;
    if (h > max) max = h;
  }
  return {
    width,
    height,
    heights,
    bbox: [lngOf(x0, zoom), latOf(y1, zoom), lngOf(x1, zoom), latOf(y0, zoom)],
    min,
    max,
    zoom,
  };
}

// The tiles have stray pixels far below everything around them, in water mostly (Sydney
// Harbour: dozens at -1300 to -2200 m, where it's 10-40 m deep), which would sink the model's
// lowest point into a pit. A pixel this far below the median of its eight neighbors takes
// that median: a real cliff can't do it (a pixel on one matches the neighbors on its side).
const SPIKE_M = 100;
function despike(heights: Float32Array, width: number, height: number) {
  const around: number[] = [];
  const fixes: [number, number][] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      around.length = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const [nx, ny] = [x + dx, y + dy];
          if ((dx || dy) && nx >= 0 && ny >= 0 && nx < width && ny < height) around.push(heights[ny * width + nx]);
        }
      }
      const i = y * width + x;
      // Quick out: not below its lowest neighbor by much, so not below their median either.
      let lowest = Infinity;
      for (const v of around) lowest = Math.min(lowest, v);
      if (heights[i] >= lowest - SPIKE_M) continue;
      around.sort((a, b) => a - b);
      const median = around[around.length >> 1];
      if (heights[i] < median - SPIKE_M) fixes.push([i, median]);
    }
  }
  // Applied after, so a fix doesn't change the next pixel's neighbors.
  for (const [i, v] of fixes) heights[i] = v;
}

// Each terrain's north-west corner in world pixels, and the last latitude's (elevationAt).
const corners = new WeakMap<Terrain, [number, number]>();
const last = { lat: NaN, zoom: -1, y: 0 };

// Ground height at a point, bilinear between the grid's pixel centers (clamped at the edges).
export function elevationAt(t: Terrain, lng: number, lat: number): number {
  let corner = corners.get(t);
  if (!corner) corners.set(t, (corner = [worldX(t.bbox[0], t.zoom), worldY(t.bbox[3], t.zoom)]));
  // Callers walk grids row by row: the same latitude again skips the log and tangent.
  if (lat !== last.lat || t.zoom !== last.zoom) [last.lat, last.zoom, last.y] = [lat, t.zoom, worldY(lat, t.zoom)];
  const px = Math.min(Math.max(worldX(lng, t.zoom) - corner[0] - 0.5, 0), t.width - 1);
  const py = Math.min(Math.max(last.y - corner[1] - 0.5, 0), t.height - 1);
  const c = Math.min(Math.floor(px), t.width - 2);
  const r = Math.min(Math.floor(py), t.height - 2);
  const fx = px - c;
  const fy = py - r;
  const h = (row: number, col: number) => t.heights[row * t.width + col];
  const top = h(r, c) * (1 - fx) + h(r, c + 1) * fx;
  const bottom = h(r + 1, c) * (1 - fx) + h(r + 1, c + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}

// Grid position of a point: fractional (col, row) in pixel-center units, the inverse of
// pixelLngLat.
export function lngLatPixel(t: Terrain, [lng, lat]: [number, number]): [number, number] {
  return [worldX(lng, t.zoom) - worldX(t.bbox[0], t.zoom) - 0.5, worldY(lat, t.zoom) - worldY(t.bbox[3], t.zoom) - 0.5];
}

// Longitude/latitude of the center of grid pixel (col, row); fractional positions work too.
export function pixelLngLat(t: Terrain, col: number, row: number): [number, number] {
  const x0 = worldX(t.bbox[0], t.zoom);
  const y0 = worldY(t.bbox[3], t.zoom);
  return [lngOf(x0 + col + 0.5, t.zoom), latOf(y0 + row + 0.5, t.zoom)];
}

async function loadTile(z: number, x: number, y: number, signal: AbortSignal): Promise<Uint8ClampedArray> {
  const res = await fetch(`${TILE_URL}/${z}/${x}/${y}.png`, { signal });
  if (!res.ok) throw new Error(`Terrain tile ${z}/${x}/${y} failed (${res.status})`);
  // No color management or alpha premultiplication: the channels are data, not colors.
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
}

// Web Mercator world pixel coordinates at `zoom`.
export function worldX(lng: number, zoom: number): number {
  return ((lng + 180) / 360) * TILE_SIZE * 2 ** zoom;
}

export function worldY(lat: number, zoom: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE_SIZE * 2 ** zoom;
}

export function lngOf(x: number, zoom: number): number {
  return (x / (TILE_SIZE * 2 ** zoom)) * 360 - 180;
}

export function latOf(y: number, zoom: number): number {
  const m = Math.PI * (1 - (2 * y) / (TILE_SIZE * 2 ** zoom));
  return (Math.atan(Math.sinh(m)) * 180) / Math.PI;
}
