// Sea depths from EMODnet Bathymetry (European seas, about 115 m, CC BY 4.0), for the sea
// to print deeper where it really is: the terrain tiles have almost no sea floor near coasts.
// Asked for as a plain-text grid (no GeoTIFF reader needed); outside its coverage, or when it
// doesn't answer, the sea just stays at its usual depth.

const WCS = 'https://ows.emodnet-bathymetry.eu/wcs';
export const BATHYMETRY_CREDIT = 'Sea depths: EMODnet Bathymetry Consortium (CC BY 4.0)';

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
}

export async function fetchBathymetry([w, s, e, n]: [number, number, number, number], signal: AbortSignal): Promise<Bathymetry | null> {
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
  return { x0: x + dx / 2, y0: y + dy / 2, dx, dy, cols, rows, heights: Float32Array.from(values.slice(0, cols * rows)) };
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
