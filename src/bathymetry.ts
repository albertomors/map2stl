// Sea depths, for the sea floor to show where it really is: the terrain tiles have almost
// none near coasts. EMODnet Bathymetry in European seas (about 115 m, CC BY 4.0), asked for
// as a plain-text grid; everywhere else (or when it doesn't answer) NOAA's global DEM mosaic:
// ETOPO 2022 (about 450 m, worldwide, from GEBCO and others) with NOAA's finer coastal models
// where there are any, public domain, as a float GeoTIFF. When neither answers, the sea just
// stays at its usual depth.

const WCS = 'https://ows.emodnet-bathymetry.eu/wcs';
// Where EMODnet has depths: elsewhere it isn't asked (its error answers can't be read).
const EMODNET_BOX = [-36, 15, 43, 90];
const NOAA = 'https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer/exportImage';

export interface BathymetrySource {
  name: string;
  credit: string;
  // About how far apart its depths are measured (meters): basins and channels narrower than
  // this come out flat.
  resolutionM: number;
}
const EMODNET: BathymetrySource = { name: 'EMODnet Bathymetry, CC BY 4.0', credit: 'Sea depths: EMODnet Bathymetry Consortium (CC BY 4.0)', resolutionM: 115 };
// ETOPO's 15 arc-seconds; NOAA's coastal models are finer where there are some.
const ETOPO: BathymetrySource = { name: 'NOAA ETOPO 2022, public domain', credit: 'Sea depths: NOAA NCEI, ETOPO 2022 and coastal DEMs (public domain)', resolutionM: 450 };
// NOAA's grid: about this spacing (its finest coastal models are finer, ETOPO coarser), at
// most this many cells a side.
const NOAA_SPACING_M = 100;
const NOAA_MAX_SIDE = 400;

export interface Bathymetry {
  // Cell centers: the first at (x0, y0), stepping dx east and dy (negative) south.
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  cols: number;
  rows: number;
  // Meters above sea level (negative at sea), row 0 at the north; NaN where unknown.
  heights: Float32Array;
  source: BathymetrySource;
}

export async function fetchBathymetry(bbox: [number, number, number, number], signal: AbortSignal): Promise<Bathymetry | null> {
  const [w, s, e, n] = bbox;
  const [bw, bs, be, bn] = EMODNET_BOX;
  const inEurope = w >= bw && e <= be && s >= bs && n <= bn;
  const emodnet = inEurope ? await fetchEmodnet(bbox, signal).catch((err) => (signal.aborted ? Promise.reject(err) : null)) : null;
  // Outside European seas EMODnet answers with no sea at all.
  if (emodnet && emodnet.heights.some((h) => h < 0)) return emodnet;
  return fetchNoaa(bbox, signal);
}

async function fetchEmodnet([w, s, e, n]: [number, number, number, number], signal: AbortSignal): Promise<Bathymetry | null> {
  const params = new URLSearchParams({ service: 'WCS', version: '2.0.1', request: 'GetCoverage', CoverageId: 'emodnet__mean', format: 'text/plain' });
  // The subsets repeat a key, which URLSearchParams' object form can't.
  params.append('subset', `Long(${w},${e})`);
  params.append('subset', `Lat(${s},${n})`);
  const res = await fetch(`${WCS}?${params}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
  if (!res.ok) return null;
  return parseGrid(await res.text());
}

// The text grid: a header with the grid size and its affine transform (to cell corners),
// then "Band 0:" and the values, one row per line, north first.
function parseGrid(text: string): Bathymetry | null {
  // Inclusive index ranges, starting at 0 or 1 ("[0..26, 1..12]" is 27 by 12).
  const range = text.match(/GridEnvelope2D\[(\d+)\.\.(\d+), (\d+)\.\.(\d+)\]/);
  const param = (name: string) => Number(text.match(new RegExp(`"${name}", (-?[\\d.eE-]+)`))?.[1]);
  const band = text.indexOf('Band 0:');
  if (!range || band < 0) return null;
  const [cols, rows] = [Number(range[2]) - Number(range[1]) + 1, Number(range[4]) - Number(range[3]) + 1];
  const [dx, x, dy, y] = [param('elt_0_0'), param('elt_0_2'), param('elt_1_1'), param('elt_1_2')];
  if (![dx, x, dy, y].every(Number.isFinite)) return null;
  const values = text
    .slice(band + 'Band 0:'.length)
    .trim()
    .split(/\s+/)
    .map(Number);
  if (values.length < cols * rows) return null;
  return { x0: x + dx / 2, y0: y + dy / 2, dx, dy, cols, rows, heights: Float32Array.from(values.slice(0, cols * rows)), source: EMODNET };
}

// NOAA's mosaic over the box, a lon/lat grid of heights (land too: depthAt ignores it).
async function fetchNoaa([w, s, e, n]: [number, number, number, number], signal: AbortSignal): Promise<Bathymetry | null> {
  const lat = (s + n) / 2;
  const widthM = (e - w) * 111_320 * Math.cos((lat * Math.PI) / 180);
  const heightM = (n - s) * 111_320;
  const k = Math.min(1, NOAA_MAX_SIDE / (Math.max(widthM, heightM) / NOAA_SPACING_M));
  const [cols, rows] = [Math.max(2, Math.round((widthM / NOAA_SPACING_M) * k)), Math.max(2, Math.round((heightM / NOAA_SPACING_M) * k))];
  const params = new URLSearchParams({ bbox: `${w},${s},${e},${n}`, bboxSR: '4326', imageSR: '4326', size: `${cols},${rows}`, format: 'tiff', pixelType: 'F32', interpolation: 'RSP_BilinearInterpolation', f: 'image' });
  try {
    const res = await fetch(`${NOAA}?${params}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('tiff')) return null;
    const { fromArrayBuffer } = await import('geotiff');
    const image = await (await fromArrayBuffer(await res.arrayBuffer())).getImage();
    const [band] = await image.readRasters();
    const [bw, bs, be, bn] = image.getBoundingBox();
    const [c, r] = [image.getWidth(), image.getHeight()];
    const [dx, dy] = [(be - bw) / c, -(bn - bs) / r];
    const heights = Float32Array.from(band as ArrayLike<number>, (v) => (Number.isFinite(v) && v > -12_000 ? v : NaN));
    if (!heights.some((h) => h < 0)) return null;
    return { x0: bw + dx / 2, y0: bn + dy / 2, dx, dy, cols: c, rows: r, heights, source: ETOPO };
  } catch (err) {
    if (signal.aborted) throw err;
    return null;
  }
}

// Depth (meters, positive) at a point, bilinear between cell centers; 0 on land or unknown.
export function depthAt(b: Bathymetry, lng: number, lat: number): number {
  const fx = Math.min(Math.max((lng - b.x0) / b.dx, 0), b.cols - 1);
  const fy = Math.min(Math.max((lat - b.y0) / b.dy, 0), b.rows - 1);
  const c = Math.min(Math.floor(fx), b.cols - 2);
  const r = Math.min(Math.floor(fy), b.rows - 2);
  if (c < 0 || r < 0) return 0;
  const [tx, ty] = [fx - c, fy - r];
  const h = (rr: number, cc: number) => {
    const v = b.heights[rr * b.cols + cc];
    return Number.isFinite(v) ? Math.min(v, 0) : 0;
  };
  const top = h(r, c) * (1 - tx) + h(r, c + 1) * tx;
  const bottom = h(r + 1, c) * (1 - tx) + h(r + 1, c + 1) * tx;
  return -(top * (1 - ty) + bottom * ty);
}
