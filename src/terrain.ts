// Ground elevation from AWS Terrain Tiles (Terrarium PNG: free, no API key, worldwide).
// Each pixel encodes meters as R*256 + G + B/256 - 32768. Returns a grid of heights
// covering the selection's bounding box, in Web Mercator pixel steps.

const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const TILE_SIZE = 256;
// Above z14 the tiles are mostly upsampled: more pixels, no more detail.
const MAX_ZOOM = 14;
const MAX_TILES = 16;

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
function worldX(lng: number, zoom: number): number {
  return ((lng + 180) / 360) * TILE_SIZE * 2 ** zoom;
}

function worldY(lat: number, zoom: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE_SIZE * 2 ** zoom;
}

function lngOf(x: number, zoom: number): number {
  return (x / (TILE_SIZE * 2 ** zoom)) * 360 - 180;
}

function latOf(y: number, zoom: number): number {
  const m = Math.PI * (1 - (2 * y) / (TILE_SIZE * 2 ** zoom));
  return (Math.atan(Math.sinh(m)) * 180) / Math.PI;
}
