// Relief shading for the terrain in the 3D view, on top of the painted map: steep ground
// turns to rock (whatever's painted there: wood, fell, grass), as mountainsides do from
// above, and hollows darken while ridges lighten a little, a cheap ambient occlusion that
// brings out gullies and crests the sun alone flattens.

import { BufferAttribute, Color, type BufferGeometry, type MeshLambertMaterial } from 'three';

export const ROCK = new Color('#9c978e');
// Slopes (as shown, with the terrain exaggeration) from mostly ground to all rock.
const ROCK_FROM_DEG = 30;
const ROCK_FULL_DEG = 45;
// How much a hollow darkens (and a ridge lightens), per unit of curvature, and the limits.
const SHADE_PER_CURVE = 2.5;
const SHADE_MIN = 0.72;
const SHADE_MAX = 1.08;

// Adds per-point `rock` (0 to 1) and `shade` (a brightness factor) to the terrain's top
// surface, an indexed mesh with normals.
export function addRelief(g: BufferGeometry) {
  const pos = g.getAttribute('position');
  const normal = g.getAttribute('normal');
  const index = g.getIndex();
  if (!index || !normal) return;
  const n = pos.count;
  const rock = new Float32Array(n);
  const [from, full] = [Math.cos((ROCK_FROM_DEG * Math.PI) / 180), Math.cos((ROCK_FULL_DEG * Math.PI) / 180)];
  for (let i = 0; i < n; i++) {
    // The normal's up part is the cosine of the slope.
    const up = Math.abs(normal.getY(i));
    rock[i] = Math.min(1, Math.max(0, (from - up) / (from - full)));
  }
  // Curvature: the neighbors' average height against the point's own, per meter between
  // them. Above it (a hollow) darkens, below it (a ridge) lightens.
  const sumY = new Float32Array(n);
  const sumD = new Float32Array(n);
  const count = new Uint16Array(n);
  const link = (a: number, b: number) => {
    const d = Math.hypot(pos.getX(a) - pos.getX(b), pos.getZ(a) - pos.getZ(b));
    sumY[a] += pos.getY(b);
    sumD[a] += d;
    count[a]++;
  };
  for (let t = 0; t < index.count; t += 3) {
    const [a, b, c] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
    link(a, b), link(a, c), link(b, a), link(b, c), link(c, a), link(c, b);
  }
  const shade = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!count[i] || !sumD[i]) {
      shade[i] = 1;
      continue;
    }
    const curve = (sumY[i] / count[i] - pos.getY(i)) / (sumD[i] / count[i]);
    shade[i] = Math.min(SHADE_MAX, Math.max(SHADE_MIN, 1 - curve * SHADE_PER_CURVE));
  }
  g.setAttribute('rock', new BufferAttribute(rock, 1));
  g.setAttribute('shade', new BufferAttribute(shade, 1));
}

// The terrain material, mixing rock into the painted map and applying the shade.
export function reliefMaterial(material: MeshLambertMaterial): MeshLambertMaterial {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.rockColor = { value: ROCK };
    shader.vertexShader =
      'attribute float rock;\nattribute float shade;\nvarying float vRock;\nvarying float vShade;\n' +
      shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvRock = rock;\nvShade = shade;');
    shader.fragmentShader =
      'uniform vec3 rockColor;\nvarying float vRock;\nvarying float vShade;\n' +
      shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, rockColor, vRock) * vShade;');
  };
  return material;
}
