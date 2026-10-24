// Aerial photos for the 3D view (on screen only: a print has no use for them). The sharpest
// open source covering the area: national orthophotos where a country publishes them openly
// (10–25 cm), Sentinel-2 cloudless (10 m) everywhere else. Each serves Web Mercator tiles a
// browser may draw onto the ground's texture (CORS).

export interface ImagerySource {
  name: string;
  // Shown with the photo; NonCommercial is said plainly.
  credit: string;
  // [west, south, east, north] it covers; none: worldwide.
  box?: [number, number, number, number];
  maxZoom: number;
  tile: (z: number, x: number, y: number) => string;
}

const SOURCES: ImagerySource[] = [
  {
    name: 'PDOK aerial photo',
    credit: 'Aerial photo: Beeldmateriaal Nederland, PDOK (CC BY 4.0)',
    box: [3.2, 50.7, 7.3, 53.6],
    maxZoom: 19,
    tile: (z, x, y) => `https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/${z}/${x}/${y}.jpeg`,
  },
  {
    name: 'SWISSIMAGE',
    credit: 'Aerial photo: © swisstopo (SWISSIMAGE)',
    box: [5.9, 45.8, 10.5, 47.9],
    maxZoom: 19,
    tile: (z, x, y) => `https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/${z}/${x}/${y}.jpeg`,
  },
  {
    name: 'IGN BD ORTHO',
    credit: 'Aerial photo: © IGN (Licence Ouverte)',
    box: [-5.2, 41.3, 9.6, 51.1],
    maxZoom: 19,
    tile: (z, x, y) =>
      `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&FORMAT=image/jpeg`,
  },
  {
    name: 'PNOA',
    credit: 'Aerial photo: PNOA, © Instituto Geográfico Nacional (CC BY 4.0)',
    box: [-9.4, 35.9, 3.4, 43.8],
    maxZoom: 19,
    // TMS: rows counted from the south.
    tile: (z, x, y) => `https://tms-pnoa-ma.idee.es/1.0.0/pnoa-ma/${z}/${x}/${2 ** z - 1 - y}.jpeg`,
  },
  {
    name: 'Sentinel-2 cloudless',
    credit: 'Satellite: Sentinel-2 cloudless 2024 by EOX, modified Copernicus Sentinel data (CC BY-NC-SA 4.0: NonCommercial)',
    maxZoom: 15,
    tile: (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/${z}/${y}/${x}.jpg`,
  },
];

// Tiles at most, whatever the area: the zoom drops to keep under it.
const MAX_TILES = 100;

export function imagerySource([w, s, e, n]: [number, number, number, number]): ImagerySource {
  return SOURCES.find((src) => !src.box || (w >= src.box[0] && e <= src.box[2] && s >= src.box[1] && n <= src.box[3]))!;
}

export interface ImageryTile {
  image: ImageBitmap;
  // [west, south, east, north].
  bbox: [number, number, number, number];
}

// The tiles over the area, at about `metersPerPixel` (the texture's), or coarser to stay
// under the tile limit or the source's finest zoom. Tiles that fail are left out.
export async function loadImagery(
  source: ImagerySource,
  [w, s, e, n]: [number, number, number, number],
  metersPerPixel: number,
  signal: AbortSignal,
): Promise<ImageryTile[]> {
  const lat = (s + n) / 2;
  let z = Math.min(source.maxZoom, Math.round(Math.log2((156_543.03 * Math.cos((lat * Math.PI) / 180)) / metersPerPixel)));
  const range = (zz: number) => {
    const t = (lng: number, la: number) => tileOf(lng, la, zz);
    const [x0, y0] = t(w, n);
    const [x1, y1] = t(e, s);
    return { x0, y0, x1, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
  };
  while (z > 0 && range(z).count > MAX_TILES) z--;
  const { x0, y0, x1, y1 } = range(z);
  const jobs: Promise<ImageryTile | null>[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      jobs.push(
        fetch(source.tile(z, x, y), { signal })
          .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
          .then((blob) => createImageBitmap(blob))
          .then((image): ImageryTile => ({ image, bbox: [lngOf(x, z), latOf(y + 1, z), lngOf(x + 1, z), latOf(y, z)] }))
          .catch(() => null),
      );
    }
  }
  return (await Promise.all(jobs)).filter((t): t is ImageryTile => !!t);
}

function tileOf(lng: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return [Math.floor(((lng + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)];
}

const lngOf = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const latOf = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
