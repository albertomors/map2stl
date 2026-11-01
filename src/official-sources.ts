// Where official 3D building models can be had (official3d.ts reads them): kept apart, free
// of three.js, so the page can tell whether to offer them without loading the 3D code.

import type { LngLat } from './geo';

export interface OfficialSource {
  name: string;
  // [west, south, east, north] it covers.
  box: [number, number, number, number];
  // 3D Tiles: 1.0 (b3dm) or 1.1 (glb), each vertex tagged with its building.
  tileset: string;
  author: string;
  license: string;
  // Where to read about it.
  url: string;
}

export const OFFICIAL_SOURCES: OfficialSource[] = [
  {
    name: 'swissBUILDINGS3D',
    box: [5.9, 45.8, 10.5, 47.9],
    tileset: 'https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json',
    author: 'swisstopo',
    license: 'free use (swisstopo open data)',
    url: 'https://www.swisstopo.admin.ch/en/landscape-model-swissbuildings3d-3-0-beta',
  },
  {
    // Every city that has LoD2 (265 of them in 2026), the latest year of each, in one
    // tileset: a child per city, each its own tileset.
    name: 'Project PLATEAU',
    box: [122.9, 24.0, 146.0, 46.0],
    tileset: 'https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/all-bldg-lod2-notexture-latest/tileset.json',
    author: 'MLIT Japan',
    license: 'Public Data License 1.0 (compatible with CC BY 4.0), modified',
    url: 'https://www.mlit.go.jp/plateau/',
  },
  {
    // 3DBAG: every building in the Netherlands, LoD2.2, from the BAG footprints and AHN
    // LiDAR. The release is in the path: newer ones are listed on docs.3dbag.nl.
    name: '3DBAG',
    box: [3.2, 50.7, 7.3, 53.6],
    tileset: 'https://data.3dbag.nl/v20250903/cesium3dtiles/lod22/tileset.json',
    author: 'tudelft3d and 3DGI',
    license: 'CC BY 4.0, modified',
    url: 'https://docs.3dbag.nl/en/copyright/',
  },
  {
    // Hamburg's LoD2 buildings, the city's own 3D Tiles (its Masterportal lists them).
    name: "Hamburg's LoD2 buildings",
    box: [8.487, 53.394, 10.322, 53.932],
    tileset: 'https://www.daten-hamburg.de/gdi3d/datasource-data/LoD2/tileset.json',
    author: 'Freie und Hansestadt Hamburg, Landesbetrieb Geoinformation und Vermessung (LGV)',
    license: 'dl-de/by-2-0, modified',
    url: 'https://www.govdata.de/dl-de/by-2-0',
  },
  {
    // Helsinki's LoD2 city model. The path's id is the city's own: if it republishes, the
    // new one is in its 3D map's config (kartta.hel.fi/3d/configs).
    name: "Helsinki's 3D city model",
    box: [24.829, 60.091, 25.247, 60.296],
    tileset: 'https://kartta.hel.fi/3d/datasource-data/16fc3fd5-df6d-4f48-bfd5-9aeee430a02f/tileset.json',
    author: 'City of Helsinki',
    license: 'CC BY 4.0, modified',
    url: 'https://kartta.hel.fi/3d/',
  },
  {
    // The Lands Department's 3D Spatial Data, every building in Hong Kong. Open without a
    // key today, though the API documents one (free, by email to 3dmap@landsd.gov.hk).
    name: "Hong Kong's 3D Spatial Data",
    box: [113.82, 22.15, 114.44, 22.57],
    tileset: 'https://data.map.gov.hk/api/3d-data/3dsd/WGS84/building/tileset.json',
    author: 'the Government of the Hong Kong SAR (Lands Department), via the CSDI Portal',
    license: 'CSDI Portal terms of use, modified',
    url: 'https://portal.csdi.gov.hk/csdi-webpage/apidoc/3d-spatial-data-api',
  },
];

// The source covering any of an area (its outline), if any: the one under its middle first.
export function officialSourceFor(ring: LngLat[]): OfficialSource | undefined {
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const [w, s, e, n] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const [cx, cy] = [(w + e) / 2, (s + n) / 2];
  const overlaps = OFFICIAL_SOURCES.filter(({ box }) => box[0] <= e && box[2] >= w && box[1] <= n && box[3] >= s);
  return overlaps.find(({ box }) => cx >= box[0] && cx <= box[2] && cy >= box[1] && cy <= box[3]) ?? overlaps[0];
}
