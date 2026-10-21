// The flat layers (water, green, squares, sand, roads, rails) painted onto one texture that
// lies on the terrain, so they follow every slope with no z-fighting. Toggling a layer
// repaints it. Bridges are left out here: they're drawn in 3D.

import { CanvasTexture, SRGBColorSpace } from 'three';
import type { Layer } from '../area-data';
import type { LngLat } from '../geo';
import type { LocalFrame } from '../local';
import type { Line, OsmData, Polygon } from '../osm';
import type { Bounds } from './terrain-mesh';

const LAND = '#e6e1d6';
export const GROUND_COLORS: Partial<Record<Layer, string>> = {
  green: '#a9cf8f',
  surfaces: '#e8d6a4',
  paved: '#c9c6c1',
  water: '#7fb2e5',
  roads: '#6b6f78',
  railways: '#7d6a98',
};
// Thin paths still show as at least this many pixels.
const MIN_LINE_PX = 1.5;

export class GroundTexture {
  readonly texture: CanvasTexture;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scale: number;

  constructor(
    private osm: OsmData,
    private frame: LocalFrame,
    private bounds: Bounds,
    maxSize: number,
  ) {
    const w = bounds.maxX - bounds.minX;
    const h = bounds.maxZ - bounds.minZ;
    // Long side at the texture limit (about 0.4 m per pixel for a 1.6 km selection).
    this.scale = Math.min(maxSize, 4096) / Math.max(w, h);
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.ceil(w * this.scale);
    this.canvas.height = Math.ceil(h * this.scale);
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = 8;
  }

  paint(visible: Set<Layer>) {
    const { ctx, osm } = this;
    ctx.fillStyle = LAND;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (visible.has('green')) this.fill(osm.green, GROUND_COLORS.green!);
    if (visible.has('surfaces')) this.fill(osm.surfaces, GROUND_COLORS.surfaces!);
    if (visible.has('paved')) {
      this.fill(osm.pavedAreas, GROUND_COLORS.paved!);
      this.stroke(osm.pavedLines, GROUND_COLORS.paved!);
    }
    if (visible.has('water')) {
      this.fill(osm.waterAreas, GROUND_COLORS.water!);
      this.stroke(osm.waterways, GROUND_COLORS.water!);
    }
    if (visible.has('roads')) this.stroke(osm.roads.filter((l) => !l.bridge), GROUND_COLORS.roads!);
    if (visible.has('railways')) this.stroke(osm.railways.filter((l) => !l.bridge), GROUND_COLORS.railways!);
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
  }

  private px(p: LngLat): [number, number] {
    const [x, z] = this.frame.toLocal(p);
    return [(x - this.bounds.minX) * this.scale, (z - this.bounds.minZ) * this.scale];
  }

  private fill(polys: Polygon[], color: string) {
    const { ctx } = this;
    ctx.fillStyle = color;
    for (const poly of polys) {
      ctx.beginPath();
      for (const ring of [poly.outer, ...poly.holes]) {
        ring.forEach((p, i) => (i ? ctx.lineTo(...this.px(p)) : ctx.moveTo(...this.px(p))));
        ctx.closePath();
      }
      // Even-odd cuts the holes out (islands in the sea, courtyards in parks).
      ctx.fill('evenodd');
    }
  }

  private stroke(lines: Line[], color: string) {
    const { ctx } = this;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Widest first, so small paths draw on top of the big roads they join.
    for (const l of [...lines].sort((a, b) => b.width - a.width)) {
      ctx.lineWidth = Math.max(l.width * this.scale, MIN_LINE_PX);
      ctx.beginPath();
      l.path.forEach((p, i) => (i ? ctx.lineTo(...this.px(p)) : ctx.moveTo(...this.px(p))));
      ctx.stroke();
    }
  }
}
