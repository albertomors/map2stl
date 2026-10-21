// Collects triangles with per-vertex colors into one flat-shaded BufferGeometry, so a whole
// layer (every building, say) is a single draw call.

import { BufferGeometry, Color, Float32BufferAttribute } from 'three';

export type Vec3 = [number, number, number];

export class MeshBuilder {
  private positions: number[] = [];
  private colors: number[] = [];
  // Which object each triangle belongs to (set `owner` before adding its faces), so a click
  // on the merged mesh can be traced back to one building.
  owner = -1;
  readonly owners: number[] = [];

  // `facing` makes the face point up or down whatever order the corners came in: lighting
  // and shadow offsets go along the normal, so a roof facing down shades itself in stripes.
  tri(a: Vec3, b: Vec3, c: Vec3, color: Color, facing?: 'up' | 'down') {
    if (facing) {
      const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
      if ((facing === 'up') !== (ny > 0)) [b, c] = [c, b];
    }
    this.positions.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) this.colors.push(color.r, color.g, color.b);
    this.owners.push(this.owner);
  }

  // Corners in order around the quad.
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, color: Color, facing?: 'up' | 'down') {
    this.tri(a, b, c, color, facing);
    this.tri(a, c, d, color, facing);
  }

  get empty(): boolean {
    return this.positions.length === 0;
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.colors, 3));
    // Not indexed: every triangle gets its own face normal, so edges stay crisp.
    g.computeVertexNormals();
    return g;
  }
}

// CSS color names and hex from OSM tags ("brick", "#aa3322", "light grey"…), or the fallback.
const probe = new Color();
export function tagColor(value: string | undefined, fallback: Color): Color {
  if (!value) return fallback;
  const css = value.trim().toLowerCase().replace(/[ _]/g, '');
  if (!CSS.supports('color', css)) return fallback;
  probe.setStyle(css);
  return probe.clone();
}
