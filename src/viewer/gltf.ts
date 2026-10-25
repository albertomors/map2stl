// The 3D view as a glTF file, for other 3D software (Blender, Unity, Unreal, Sketchfab, the
// web): the scene as it looks on screen, in meters (x east, y up, z south), not the print.
// What the view does in its own shaders is made plain first, since glTF readers only know
// standard materials: the relief (rock on steep ground, darker hollows) is baked into the
// ground texture, the trees (instances of one cone) become one mesh, and the attributes the
// sliders stretch with are left out.

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  GLSL3,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  Scene,
  SRGBColorSpace,
  WebGLRenderTarget,
  type MeshLambertMaterial,
  type Object3D,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ROCK } from './relief';

// Per-vertex inputs of the view's shaders (relief.ts, the slider stretch): meaningless elsewhere.
const VIEW_ONLY = ['groundY', 'rock', 'shade'];

// `roots`: the groups to export; each child counts if it's shown (its layer is on), whether
// or not the group itself is (the print preview hides the scene). `terrainTop`: the mesh
// whose texture gets the relief baked in.
export async function sceneToGltf(
  renderer: WebGLRenderer,
  roots: Object3D[],
  terrainTop: Mesh | null,
  binary: boolean,
  credits: string,
): Promise<Blob> {
  // A scene, not a group: glTF readers show its name, and its extras carry the credits.
  const out = new Scene();
  out.name = 'map2stl';
  out.userData = { credits };
  for (const root of roots) {
    root.updateMatrixWorld(true);
    for (const child of root.children) {
      if (!child.visible) continue;
      child.traverseVisible((o) => {
        if (!(o instanceof Mesh)) return;
        const geometry = o instanceof InstancedMesh ? expandInstances(o) : o.geometry.clone();
        if (!geometry) return;
        geometry.applyMatrix4(o.matrixWorld);
        for (const name of VIEW_ONLY) geometry.deleteAttribute(name);
        const lambert = o.material as MeshLambertMaterial;
        const map = o === terrainTop && lambert.map ? bakeRelief(renderer, o, lambert.map) : null;
        const mesh = new Mesh(geometry, standard(lambert, map));
        mesh.name = o.name;
        out.add(mesh);
      });
    }
  }
  try {
    const result = await new GLTFExporter().parseAsync(out, { binary });
    return binary
      ? new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' })
      : new Blob([JSON.stringify(result)], { type: 'model/gltf+json' });
  } finally {
    out.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      o.geometry.dispose();
      const m = o.material as MeshStandardMaterial;
      m.map?.dispose();
      m.dispose();
    });
  }
}

// The view's look in glTF's terms: matte (Lambert has no shine), same colors.
function standard(m: MeshLambertMaterial, map: Texture | null): MeshStandardMaterial {
  return new MeshStandardMaterial({
    name: m.name,
    color: m.color,
    map,
    vertexColors: m.vertexColors,
    side: m.side,
    metalness: 0,
    roughness: 1,
  });
}

// Each instance's copy of the shape, in one geometry. Hidden instances (scaled to nothing)
// are left out.
function expandInstances(mesh: InstancedMesh): BufferGeometry | null {
  const matrix = new Matrix4();
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, matrix);
    if (matrix.determinant() === 0) continue;
    parts.push(mesh.geometry.clone().applyMatrix4(matrix));
  }
  const merged = parts.length ? mergeGeometries(parts) : null;
  for (const p of parts) p.dispose();
  return merged;
}

// The ground texture with the relief applied as the view's shader does (relief.ts): rock
// mixed in by steepness, times the shade. Drawn in texture space (each triangle where its
// UVs put it), over a plain copy of the texture so the texels just outside the tile's edge
// aren't black.
function bakeRelief(renderer: WebGLRenderer, top: Mesh, map: Texture): CanvasTexture {
  const { width, height } = map.image as HTMLCanvasElement;
  // An sRGB target: the GPU encodes the shader's linear colors as it writes them.
  const target = new WebGLRenderTarget(width, height, { colorSpace: SRGBColorSpace });
  const material = new RawShaderMaterial({
    glslVersion: GLSL3,
    uniforms: { map: { value: map }, rockColor: { value: ROCK } },
    vertexShader: `
      in vec2 uv;
      in float rock;
      in float shade;
      out vec2 vUv;
      out float vRock;
      out float vShade;
      void main() {
        vUv = uv;
        vRock = rock;
        vShade = shade;
        gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
      }`,
    fragmentShader: `
      precision highp float;
      uniform sampler2D map;
      uniform vec3 rockColor;
      in vec2 vUv;
      in float vRock;
      in float vShade;
      out vec4 color;
      void main() {
        color = vec4(mix(texture(map, vUv).rgb, rockColor, vRock) * vShade, 1.0);
      }`,
    side: DoubleSide,
    depthTest: false,
  });
  // The plain texture: the whole square, no rock, no shade.
  const plain = new PlaneGeometry(2, 2);
  const n = plain.getAttribute('position').count;
  plain.setAttribute('rock', new BufferAttribute(new Float32Array(n), 1));
  plain.setAttribute('shade', new BufferAttribute(new Float32Array(n).fill(1), 1));
  const scene = new Scene();
  const under = new Mesh(plain, material);
  const relief = new Mesh(top.geometry, material);
  relief.renderOrder = 1;
  scene.add(under, relief);

  const pixels = new Uint8Array(width * height * 4);
  const previous = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(target);
    renderer.render(scene, new OrthographicCamera());
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
  } finally {
    renderer.setRenderTarget(previous);
    target.dispose();
    material.dispose();
    plain.dispose();
  }

  // Read back bottom row first; a canvas starts at the top.
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(width, height);
  const row = width * 4;
  for (let y = 0; y < height; y++) image.data.set(pixels.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
  ctx.putImageData(image, 0, 0);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  // A photo-like map: JPEG is a fraction of PNG's size, and there's no transparency to keep.
  texture.userData.mimeType = 'image/jpeg';
  return texture;
}
