// The flat layers (water, green, squares, sand, roads, rails) painted onto one texture that
// lies on the terrain, so they follow every slope with no z-fighting. Toggling a layer
// repaints it. Bridges are left out here: they're drawn in 3D.

import { CanvasTexture, SRGBColorSpace } from 'three';
import type { Layer } from '../area-data';
import type { ImageryTile } from '../imagery';
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
// The selected street or area, on top: the same light orange as a selected building.
const SELECTED = '#ff9a5c';

export class GroundTexture {
  readonly texture: CanvasTexture;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scale: number;

  constructor(
    // The data painted: replaced when ground edits change it (see setData).
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

  setData(osm: OsmData) {
    this.osm = osm;
  }

  // An aerial photo as the ground (imagery.ts), instead of the painted map; null: the map.
  private imagery: ImageryTile[] | null = null;
  setImagery(tiles: ImageryTile[] | null) {
    this.imagery = tiles;
  }

  // What the texture covers, for asking the photo's tiles: [west, south, east, north], and
  // meters per pixel.
  get coverage(): { bbox: [number, number, number, number]; metersPerPixel: number } {
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const [w, n] = this.frame.toLngLat([minX, minZ]);
    const [e, s] = this.frame.toLngLat([maxX, maxZ]);
    return { bbox: [w, s, e, n], metersPerPixel: 1 / this.scale };
  }

  // `selected`: the id of a street, river or area to draw on top, highlighted.
  paint(visible: Set<Layer>, selected?: string | null) {
    const { ctx, osm } = this;
    ctx.fillStyle = LAND;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.imagery) {
      // The photo is the ground: no painted layers, only the selection on top.
      for (const t of this.imagery) {
        const [x0, y0] = this.px([t.bbox[0], t.bbox[3]]);
        const [x1, y1] = this.px([t.bbox[2], t.bbox[1]]);
        ctx.drawImage(t.image, x0, y0, x1 - x0, y1 - y0);
      }
      this.highlight(selected);
      this.texture.needsUpdate = true;
      return;
    }
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
    this.highlight(selected);
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
  }

  private highlight(selected: string | null | undefined) {
    if (!selected) return;
    const { osm } = this;
    const is = (x: { id: string }) => x.id === selected;
    this.fill([...osm.waterAreas, ...osm.green, ...osm.surfaces, ...osm.pavedAreas].filter(is), SELECTED);
    this.stroke([...osm.roads, ...osm.railways, ...osm.waterways, ...osm.pavedLines].filter((l) => is(l) && !l.bridge), SELECTED);
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
