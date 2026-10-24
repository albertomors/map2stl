// A flat local frame in meters around the selection center: x east, z south, y up
// (Three.js convention: north is -z). Equirectangular around the center, which is
// accurate to well under a meter over the few kilometers a selection spans.

import type { LngLat } from './geo';

const METERS_PER_DEGREE = (6371008.8 * Math.PI) / 180;

export class LocalFrame {
  private kx: number;

  constructor(private origin: LngLat) {
    this.kx = METERS_PER_DEGREE * Math.cos((origin[1] * Math.PI) / 180);
  }

  // [x, z] in meters.
  toLocal([lng, lat]: LngLat): [number, number] {
    return [(lng - this.origin[0]) * this.kx, -(lat - this.origin[1]) * METERS_PER_DEGREE];
  }

  // The inverse: [x, z] in meters back to longitude and latitude.
  toLngLat([x, z]: [number, number]): LngLat {
    return [this.origin[0] + x / this.kx, this.origin[1] - z / METERS_PER_DEGREE];
  }
}
