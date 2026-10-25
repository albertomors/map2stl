// Where official 3D building models can be had (official3d.ts reads them): kept apart, free
// of three.js, so the page can tell whether to offer them without loading the 3D code.

import type { LngLat } from './geo';

export interface OfficialSource {
  name: string;
  // [west, south, east, north] it covers.
  box: [number, number, number, number];
  // 3D Tiles (b3dm), each model's position in its table.
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
];

// The source covering a point, if any.
export function officialSourceAt([lng, lat]: LngLat): OfficialSource | undefined {
  return OFFICIAL_SOURCES.find(({ box: [w, s, e, n] }) => lng >= w && lng <= e && lat >= s && lat <= n);
}
