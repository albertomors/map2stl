// The 3D view of a fetched area: terrain tile with the flat layers painted on, buildings with
// roofs, structures, bridges and trees. Layers toggle on and off; the two scales rebuild it.

import {
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  type BufferGeometry,
  type Object3D,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { AreaData, Layer } from '../area-data';
import { clipToSelection } from '../clip';
import { describe } from '../selection';
import { LocalFrame } from '../local';
import { elevationAt } from '../terrain';
import { GroundTexture } from './ground';
import { buildBridges, buildBuildings, buildStructures, buildTrees, COLORS, type Placement } from './objects';
import { buildTerrain, type Bounds } from './terrain-mesh';

export interface ViewScales {
  // Vertical exaggeration of the terrain, and of everything standing on it.
  terrain: number;
  heights: number;
}

// Below the lowest ground, so the tile reads as a solid block.
const BASE_DEPTH_M = 12;
const TEXTURE_LAYERS: Layer[] = ['green', 'surfaces', 'paved', 'water', 'roads', 'railways'];

export class Viewer {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(40, 1, 1, 1e5);
  private controls: OrbitControls;
  private sun = new DirectionalLight('#fff6e8', 2.2);
  private content = new Group();
  private layerObjects = new Map<Layer, Object3D[]>();
  private ground: GroundTexture | null = null;
  private data: AreaData | null = null;
  // The data cut to the selection, kept across rebuilds (sliders don't change it).
  private clipped: ReturnType<typeof clipToSelection> | null = null;
  private visible = new Set<Layer>();
  private resize: ResizeObserver;

  constructor(private container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    container.append(this.renderer.domElement);

    this.scene.background = new Color('#dde6ee');
    this.scene.add(new HemisphereLight('#f4f7fb', '#8a8070', 1.4));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target, this.content);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    // Never below the ground plane.
    this.controls.maxPolarAngle = Math.PI * 0.47;

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  // `keepCamera` when new data replaces what's shown (the full version after the quick one).
  show(data: AreaData, visible: Set<Layer>, scales: ViewScales, { keepCamera = false } = {}) {
    this.data = data;
    this.clipped = null;
    this.ground?.dispose();
    this.ground = null;
    this.visible = new Set(visible);
    this.build(scales, !keepCamera);
  }

  setScales(scales: ViewScales) {
    if (this.data) this.build(scales, false);
  }

  setLayerVisible(layer: Layer, visible: boolean) {
    if (visible) this.visible.add(layer);
    else this.visible.delete(layer);
    for (const o of this.layerObjects.get(layer) ?? []) o.visible = visible;
    if (TEXTURE_LAYERS.includes(layer)) this.ground?.paint(this.visible);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.resize.disconnect();
    this.clear();
    this.ground?.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private build(scales: ViewScales, frameCamera: boolean) {
    const data = this.data!;
    const { terrain, selection } = data;
    this.clear();

    const ring = describe(selection).ring;
    // Nothing may stick out past the tile edge.
    const osm = this.clipped ??= clipToSelection(data.osm, ring);
    const frame = new LocalFrame(selection.center);
    const local = ring.map((p) => frame.toLocal(p));
    const bounds: Bounds = {
      minX: Math.min(...local.map((p) => p[0])),
      maxX: Math.max(...local.map((p) => p[0])),
      minZ: Math.min(...local.map((p) => p[1])),
      maxZ: Math.max(...local.map((p) => p[1])),
    };

    // Terrarium includes the sea floor: where there's sea, the water surface is the ground.
    const hasSea = osm.waterAreas.some((a) => a.kind === 'sea');
    const clampSea = (h: number) => (hasSea ? Math.max(h, 0) : h);
    // Heights relative to the lowest point, so the model sits near y = 0 wherever it is.
    const ref = clampSea(terrain.min);
    const placement: Placement = {
      frame,
      elevation: ([lng, lat]) => clampSea(elevationAt(terrain, lng, lat)) - ref,
      terrainScale: scales.terrain,
      heightScale: scales.heights,
    };

    if (!this.ground) {
      this.ground = new GroundTexture(osm, frame, bounds, this.renderer.capabilities.maxTextureSize);
      this.ground.paint(this.visible);
    }
    const tile = buildTerrain(terrain, ring, frame, bounds, (h) => (clampSea(h) - ref) * scales.terrain, BASE_DEPTH_M);
    const top = new Mesh(tile.top, new MeshLambertMaterial({ map: this.ground.texture }));
    top.receiveShadow = true;
    const sides = new Mesh(tile.sides, new MeshLambertMaterial({ color: '#b9ab96', side: DoubleSide }));
    this.content.add(top, sides);

    const solid = (geometry: BufferGeometry | null, layer: Layer, color?: Color) => {
      if (!geometry) return;
      const material = new MeshLambertMaterial(color ? { color, side: DoubleSide } : { vertexColors: true, side: DoubleSide });
      const mesh = new Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.add(layer, mesh);
    };
    solid(buildBuildings(osm.buildings, placement), 'buildings');
    solid(buildStructures(osm, placement), 'structures');
    solid(buildBridges(osm.roads, placement, COLORS.road), 'roads', COLORS.road);
    solid(buildBridges(osm.railways, placement, COLORS.rail), 'railways', COLORS.rail);
    const trees = buildTrees(osm.trees, placement);
    if (trees) this.add('trees', trees);

    // Sun from the south-west, its shadow box sized to the tile.
    const radius = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2;
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -radius * 1.2;
    cam.right = cam.top = radius * 1.2;
    cam.near = 1;
    cam.far = radius * 6;
    cam.updateProjectionMatrix();
    // Push shadow lookups out by about two shadow-map pixels: less and walls shade themselves
    // in stripes ("shadow acne"), much more and shadows detach from the buildings.
    this.sun.shadow.normalBias = 2 * ((2.4 * radius) / this.sun.shadow.mapSize.x);
    this.sun.position.set(-radius * 1.2, radius * 2, radius * 1.4);
    this.sun.target.position.set(0, 0, 0);

    if (frameCamera) {
      this.camera.near = Math.max(0.5, radius / 2000);
      this.camera.far = radius * 30;
      this.camera.position.set(0, radius * 1.1, radius * 1.6);
      this.controls.target.set(0, 0, 0);
      this.controls.maxDistance = radius * 8;
      this.fit();
    }
  }

  private add(layer: Layer, object: Object3D) {
    object.visible = this.visible.has(layer);
    this.content.add(object);
    this.layerObjects.set(layer, [...(this.layerObjects.get(layer) ?? []), object]);
  }

  private clear() {
    for (const o of [...this.content.children]) {
      o.traverse((c) => {
        if (c instanceof Mesh) {
          c.geometry.dispose();
          (c.material as MeshLambertMaterial).dispose();
        }
      });
      this.content.remove(o);
    }
    this.layerObjects.clear();
  }

  private fit() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
