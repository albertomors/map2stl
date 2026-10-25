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
  // A request for the box in lon/lat as a float GeoTIFF of about w × h (the GeoTIFF's own
  // bounds are used, so a service snapping to its grid is fine): the ground, and the surface
  // (optional).
  url: (bbox: [number, number, number, number], w: number, h: number) => string;
  surfaceUrl?: (bbox: [number, number, number, number], w: number, h: number) => string;
}

// WCS 1.0.0 in lon/lat at a given size (Kartverket, PDOK).
const wcs10 = (base: string, coverage: string) => ([w, s, e, n]: [number, number, number, number], width: number, height: number) =>
  `${base}?SERVICE=WCS&VERSION=1.0.0&REQUEST=GetCoverage&COVERAGE=${coverage}&CRS=EPSG:4326&BBOX=${w},${s},${e},${n}&WIDTH=${width}&HEIGHT=${height}&FORMAT=GeoTIFF`;
// WCS 2.0.1 in lon/lat, scaled down from its native spacing (the Environment Agency's).
const wcs20 = (base: string, coverage: string, nativeM: number) => ([w, s, e, n]: [number, number, number, number], width: number) => {
  const nativeWidth = ((e - w) * 111_320 * Math.cos((((s + n) / 2) * Math.PI) / 180)) / nativeM;
  const crs = 'http://www.opengis.net/def/crs/EPSG/0/4326';
  return `${base}?service=WCS&version=2.0.1&request=GetCoverage&coverageId=${coverage}&format=image/tiff&subset=Lat(${s},${n})&subset=Long(${w},${e})&subsettingCrs=${crs}&outputCrs=${crs}&scalefactor=${Math.min(1, width / nativeWidth).toFixed(4)}`;
};
// An ArcGIS image service in lon/lat at a given size (USGS).
const arcgis = (base: string) => ([w, s, e, n]: [number, number, number, number], width: number, height: number) =>
  `${base}/exportImage?bbox=${w},${s},${e},${n}&bboxSR=4326&imageSR=4326&size=${width},${height}&format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image`;

const SOURCES: LidarSource[] = [
  {
    // Kartverket's national height model (Nasjonal høydemodell), terrain only, nationwide.
    box: [4.0, 57.9, 31.3, 71.3],
    name: "Kartverket's LiDAR height model",
    credit: 'Terrain: © Kartverket (CC BY 4.0)',
    url: wcs10('https://wcs.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833', 'NHM_DTM_25833'),
    surfaceUrl: wcs10('https://wcs.geonorge.no/skwms1/wcs.hoyde-dom-nhm-25833', 'NHM_DOM_25833'),
  },
  {
    // AHN, the Netherlands' height model (0.5 m), terrain and surface, nationwide.
    box: [3.2, 50.7, 7.3, 53.6],
    name: 'AHN, the Dutch LiDAR height model',
    credit: 'Terrain: AHN, Rijkswaterstaat via PDOK (CC0)',
    url: wcs10('https://service.pdok.nl/rws/ahn/wcs/v1_0', 'dtm_05m'),
    surfaceUrl: wcs10('https://service.pdok.nl/rws/ahn/wcs/v1_0', 'dsm_05m'),
  },
  {
    // The Environment Agency's LiDAR composite (1 m), England.
    box: [-6.5, 49.8, 2.0, 55.9],
    name: "the Environment Agency's LiDAR composite",
    credit: 'Terrain: Environment Agency LiDAR composite (Open Government Licence v3.0)',
    url: wcs20('https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wcs', '13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m', 1),
    surfaceUrl: wcs20('https://environment.data.gov.uk/spatialdata/lidar-composite-digital-surface-model-first-return-dsm-1m/wcs', 'df4e3ec3-315e-48aa-aaaf-b5ae74d7b2bb__Lidar_Composite_Elevation_FZ_DSM_1m', 1),
  },
  {
    // USGS's 3D Elevation Program: LiDAR (1 m) over most of the US, coarser where it has none.
    box: [-125, 24, -66, 50],
    name: "USGS's 3D Elevation Program",
    credit: 'Terrain: USGS 3D Elevation Program (public domain)',
    url: arcgis('https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer'),
  },
];

// Finest spacing worth asking for, and the grid's largest side.
const MIN_RESOLUTION_M = 1;
const MAX_SIDE = 1600;
// Heights outside this are a source's "no data" (-3.4e38, 3.4e38…), not ground.
const NO_DATA_BELOW = -500;
const NO_DATA_ABOVE = 9000;

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
  const sample = (raster: Raster, lng: number, latp: number) => {
    const [bw, bs, be, bn] = raster.bbox;
    const fx = Math.min(Math.max(((lng - bw) / (be - bw)) * raster.w - 0.5, 0), raster.w - 1);
    const fy = Math.min(Math.max(((bn - latp) / (bn - bs)) * raster.h - 0.5, 0), raster.h - 1);
    const c = Math.min(Math.floor(fx), raster.w - 2);
    const r = Math.min(Math.floor(fy), raster.h - 2);
    const at = (rr: number, cc: number) => raster.values[rr * raster.w + cc];
    const v = [at(r, c), at(r, c + 1), at(r + 1, c), at(r + 1, c + 1)];
    if (v.some((x) => !Number.isFinite(x) || x < NO_DATA_BELOW || x > NO_DATA_ABOVE)) return NaN;
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
  // [west, south, east, north] of its outer pixel edges.
  bbox: number[];
}

// A float GeoTIFF from a WCS; null when it doesn't answer with one.
async function readRaster(url: string, signal: AbortSignal): Promise<Raster | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('tiff')) return null;
    const { fromArrayBuffer } = await import('geotiff');
    const image = await (await fromArrayBuffer(await res.arrayBuffer())).getImage();
    const [band] = await image.readRasters();
    return { values: band as Float32Array, w: image.getWidth(), h: image.getHeight(), bbox: image.getBoundingBox() };
  } catch (err) {
    if (signal.aborted) throw err;
    return null;
  }
}
