// Collects triangles with per-vertex colors into one flat-shaded BufferGeometry, so a whole
// layer (every building, say) is a single draw call.

import { BufferGeometry, Color, Float32BufferAttribute } from 'three';

export type Vec3 = [number, number, number];

export class MeshBuilder {
  private positions: number[] = [];
  private colors: number[] = [];

  tri(a: Vec3, b: Vec3, c: Vec3, color: Color) {
    this.positions.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) this.colors.push(color.r, color.g, color.b);
  }

  // Corners in order around the quad.
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, color: Color) {
    this.tri(a, b, c, color);
    this.tri(a, c, d, color);
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
