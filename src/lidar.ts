// Ground heights from national LiDAR terrain models (about 1 m), where a country publishes
// one a browser can load: much sharper than the worldwide tiles (about 10–30 m underneath),
// so ridges, gullies and cliffs come out. Asked for at the detail the print can use (the
// terrain mesh holds about 500 cells a side), resampled into the same Web Mercator grid as
// the tiles, so everything downstream works unchanged; points it doesn't cover (the sea,
// across a border) keep the tiles' heights. Where the country also publishes its surface
// model (treetops and roofs, not the ground), the two together give how tall what stands
// there is: the forests' real canopy height (forest.ts).

import type { Terrain, TerrainSource } from './terrain';
import { elevationAt, latOf, lngOf, worldX, worldY } from './terrain';

interface LidarSource {
  // [west, south, east, north] it may cover; outside, it isn't asked.
  box: [number, number, number, number];
  name: string;
  credit: string;
  // A WCS 1.0.0 GetCoverage for the box in lon/lat, as a float GeoTIFF of size w × h: the
  // ground, and the surface (optional).
  url: (bbox: [number, number, number, number], w: number, h: number) => string;
  surfaceUrl?: (bbox: [number, number, number, number], w: number, h: number) => string;
}

const SOURCES: LidarSource[] = [
  {
    // Kartverket's national height model (Nasjonal høydemodell), terrain only, nationwide.
    box: [4.0, 57.9, 31.3, 71.3],
    name: "Kartverket's LiDAR height model",
    credit: 'Terrain: © Kartverket (CC BY 4.0)',
    url: ([w, s, e, n], width, height) =>
      `https://wcs.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833?SERVICE=WCS&VERSION=1.0.0&REQUEST=GetCoverage&COVERAGE=NHM_DTM_25833&CRS=EPSG:4326&BBOX=${w},${s},${e},${n}&WIDTH=${width}&HEIGHT=${height}&FORMAT=GeoTIFF`,
    surfaceUrl: ([w, s, e, n], width, height) =>
      `https://wcs.geonorge.no/skwms1/wcs.hoyde-dom-nhm-25833?SERVICE=WCS&VERSION=1.0.0&REQUEST=GetCoverage&COVERAGE=NHM_DOM_25833&CRS=EPSG:4326&BBOX=${w},${s},${e},${n}&WIDTH=${width}&HEIGHT=${height}&FORMAT=GeoTIFF`,
  },
];

// Finest spacing worth asking for, and the grid's largest side.
const MIN_RESOLUTION_M = 1;
const MAX_SIDE = 1600;
// Heights below this are a source's "no data", not ground.
const NO_DATA_BELOW = -500;

// The area's heights from LiDAR, gaps filled from `fallback` (the tiles); null where no
// source covers it, or when the source doesn't answer.
export async function fetchLidarTerrain(fallback: Terrain, signal: AbortSignal): Promise<Terrain | null> {
  const [w, s, e, n] = fallback.bbox;
  const source = SOURCES.find(({ box: [bw, bs, be, bn] }) => w >= bw && e <= be && s >= bs && n <= bn);
  if (!source) return null;

  // Spacing from the area's size, as fine as the mesh can use: the zoom whose pixels are
  // at most that.
  const lat = (s + n) / 2;
  const extentM = Math.max((e - w) * 111_320 * Math.cos((lat * Math.PI) / 180), (n - s) * 111_320);
  const wantM = Math.max(MIN_RESOLUTION_M, extentM / 1200);
  const metersPerPx0 = 156_543.03 * Math.cos((lat * Math.PI) / 180);
  let zoom = Math.ceil(Math.log2(metersPerPx0 / wantM));
  let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
  for (; ; zoom--) {
    [x0, x1] = [Math.floor(worldX(w, zoom)), Math.ceil(worldX(e, zoom))];
    [y0, y1] = [Math.floor(worldY(n, zoom)), Math.ceil(worldY(s, zoom))];
    if (Math.max(x1 - x0, y1 - y0) <= MAX_SIDE) break;
  }
  const [width, height] = [x1 - x0, y1 - y0];
  const box: [number, number, number, number] = [lngOf(x0, zoom), latOf(y1, zoom), lngOf(x1, zoom), latOf(y0, zoom)];

  // The ground, and the surface alongside it (missing: no canopy heights, nothing else lost).
  const [raster, surface] = await Promise.all([
    readRaster(source.url(box, width, height), signal),
    source.surfaceUrl ? readRaster(source.surfaceUrl(box, width, height), signal) : null,
  ]);
  if (!raster) return null;

  // The raster is a lon/lat grid over `box`; the result a Mercator grid: each pixel center
  // sampled from it (bilinear), or from the tiles where it has no data.
  const heights = new Float32Array(width * height);
  const canopy = surface ? new Float32Array(width * height).fill(NaN) : undefined;
  const [bw, bs, be, bn] = box;
  const sample = (raster: Raster, lng: number, latp: number) => {
    const fx = Math.min(Math.max(((lng - bw) / (be - bw)) * raster.w - 0.5, 0), raster.w - 1);
    const fy = Math.min(Math.max(((bn - latp) / (bn - bs)) * raster.h - 0.5, 0), raster.h - 1);
    const c = Math.min(Math.floor(fx), raster.w - 2);
    const r = Math.min(Math.floor(fy), raster.h - 2);
    const at = (rr: number, cc: number) => raster.values[rr * raster.w + cc];
    const v = [at(r, c), at(r, c + 1), at(r + 1, c), at(r + 1, c + 1)];
    if (v.some((x) => !Number.isFinite(x) || x < NO_DATA_BELOW)) return NaN;
    const [tx, ty] = [fx - c, fy - r];
    return (v[0] * (1 - tx) + v[1] * tx) * (1 - ty) + (v[2] * (1 - tx) + v[3] * tx) * ty;
  };
  let [min, max, filled] = [Infinity, -Infinity, 0];
  for (let row = 0; row < height; row++) {
    const latp = latOf(y0 + row + 0.5, zoom);
    for (let col = 0; col < width; col++) {
      const lng = lngOf(x0 + col + 0.5, zoom);
      let h = sample(raster, lng, latp);
      if (Number.isNaN(h)) {
        h = elevationAt(fallback, lng, latp);
        filled++;
      } else if (surface && canopy) {
        const top = sample(surface, lng, latp);
        if (!Number.isNaN(top)) canopy[row * width + col] = Math.max(0, top - h);
      }
      heights[row * width + col] = h;
      min = Math.min(min, h);
      max = Math.max(max, h);
    }
  }
  // Nothing of it covered: not worth calling it LiDAR.
  if (filled > heights.length * 0.95) return null;
  const resolutionM = metersPerPx0 / 2 ** zoom;
  const terrainSource: TerrainSource = { name: source.name, resolutionM, credit: source.credit };
  return { width, height, heights, canopy, bbox: box, min, max, zoom, source: terrainSource };
}

interface Raster {
  values: Float32Array | Float64Array;
  w: number;
  h: number;
}

// A float GeoTIFF from a WCS; null when it doesn't answer with one.
async function readRaster(url: string, signal: AbortSignal): Promise<Raster | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('tiff')) return null;
    const { fromArrayBuffer } = await import('geotiff');
    const image = await (await fromArrayBuffer(await res.arrayBuffer())).getImage();
    const [band] = await image.readRasters();
    return { values: band as Float32Array, w: image.getWidth(), h: image.getHeight() };
  } catch (err) {
    if (signal.aborted) throw err;
    return null;
  }
}
