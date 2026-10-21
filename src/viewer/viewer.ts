// The 3D view of a fetched area: terrain tile with the flat layers painted on, buildings with
// roofs, structures, bridges and trees. Layers toggle on and off; the two scales rebuild it.
// A click on a building selects it (orange outline) for editing: delete or enlarge.

import {
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  EdgesGeometry,
  Mesh,
  MeshLambertMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  WebGLRenderer,
  type BufferGeometry,
  type Object3D,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { AreaData, Layer } from '../area-data';
import { clipBuildings, clipToSelection } from '../clip';
import { applyEdits, editKey, type Edits } from '../edits';
import type { LngLat } from '../geo';
import type { Building } from '../osm';
import { describe } from '../selection';
import { LocalFrame } from '../local';
import { elevationAt } from '../terrain';
import { GroundTexture } from './ground';
import { buildBridges, buildBuildings, buildStructures, buildTrees, COLORS, type Placement } from './objects';
import { buildTerrain, type Bounds } from './terrain-mesh';

// What the panel shows about a clicked building (from its original data, before edits).
export interface BuildingPick {
  key: string;
  name?: string;
  height: number;
  heightFrom: Building['heightFrom'];
  roofShape?: string;
  parts: number;
  // Buildings from the quick tile data get new ids when the detailed data arrives.
  editable: boolean;
}

export interface ViewScales {
  // Vertical exaggeration of the terrain, and of everything standing on it.
  terrain: number;
  heights: number;
}

// Below the lowest ground, so the tile reads as a solid block.
const BASE_DEPTH_M = 12;
const TEXTURE_LAYERS: Layer[] = ['green', 'surfaces', 'paved', 'water', 'roads', 'railways'];
const SELECTION_COLOR = '#ff6b2c';
// A press and release closer than this is a click (select), not an orbit.
const CLICK_PX = 5;

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
  // Buildings: rebuilt alone when an edit changes, without the rest of the scene.
  private edits: Edits = new Map();
  private placement: Placement | null = null;
  private ring: LngLat[] = [];
  private buildingsMesh: Mesh | null = null;
  private built: Building[] = [];
  private owners: number[] = [];
  private selected: string | null = null;
  private highlight: LineSegments | null = null;

  constructor(
    private container: HTMLElement,
    private onPick: (pick: BuildingPick | null) => void,
  ) {
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

    let press: { x: number; y: number } | null = null;
    this.renderer.domElement.addEventListener('pointerdown', (e) => (press = e.button === 0 ? { x: e.clientX, y: e.clientY } : null));
    this.renderer.domElement.addEventListener('pointerup', (e) => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) < CLICK_PX) this.pickAt(e);
      press = null;
    });

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  // `keepCamera` when new data replaces what's shown (the full version after the quick one).
  show(data: AreaData, visible: Set<Layer>, scales: ViewScales, { keepCamera = false, edits = new Map() as Edits } = {}) {
    this.data = data;
    this.edits = edits;
    this.select(null);
    this.clipped = null;
    this.ground?.dispose();
    this.ground = null;
    this.visible = new Set(visible);
    this.build(scales, !keepCamera);
  }

  setScales(scales: ViewScales) {
    if (this.data) this.build(scales, false);
  }

  // Edits changed: rebuild just the buildings.
  setEdits(edits: Edits) {
    this.edits = edits;
    if (this.data && this.placement) this.buildBuildingsLayer();
  }

  select(key: string | null) {
    this.selected = key;
    this.drawHighlight();
    this.onPick(key ? this.describeBuilding(key) : null);
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
    this.clearHighlight();
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
    const placement: Placement = (this.placement = {
      frame,
      elevation: ([lng, lat]) => clampSea(elevationAt(terrain, lng, lat)) - ref,
      terrainScale: scales.terrain,
      heightScale: scales.heights,
    });
    this.ring = ring;

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
    this.buildBuildingsLayer();
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

  // Edits first, then the cut at the tile edge: an enlarged landmark is still trimmed there.
  private buildBuildingsLayer() {
    if (this.buildingsMesh) {
      this.content.remove(this.buildingsMesh);
      this.buildingsMesh.geometry.dispose();
      (this.buildingsMesh.material as MeshLambertMaterial).dispose();
      this.layerObjects.set('buildings', []);
      this.buildingsMesh = null;
    }
    this.built = clipBuildings(applyEdits(this.data!.osm.buildings, this.edits), this.ring);
    const result = buildBuildings(this.built, this.placement!);
    this.owners = result?.owners ?? [];
    if (result) {
      const mesh = new Mesh(result.geometry, new MeshLambertMaterial({ vertexColors: true, side: DoubleSide }));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.buildingsMesh = mesh;
      this.add('buildings', mesh);
    }
    this.drawHighlight();
  }

  private pickAt(e: PointerEvent) {
    const mesh = this.buildingsMesh;
    if (!mesh?.visible) return this.select(null);
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObject(mesh)[0];
    const owner = hit?.faceIndex !== undefined && hit.faceIndex !== null ? this.owners[hit.faceIndex] : undefined;
    this.select(owner !== undefined ? editKey(this.built[owner]) : null);
  }

  // An orange outline of the selected building's edges, drawn on top of everything.
  private drawHighlight() {
    this.clearHighlight();
    if (!this.selected || !this.placement) return;
    const parts = this.built.filter((b) => editKey(b) === this.selected);
    const result = parts.length ? buildBuildings(parts, this.placement) : null;
    if (!result) return;
    const edges = new EdgesGeometry(result.geometry, 25);
    result.geometry.dispose();
    this.highlight = new LineSegments(edges, new LineBasicMaterial({ color: SELECTION_COLOR, depthTest: false, transparent: true }));
    this.highlight.renderOrder = 10;
    this.scene.add(this.highlight);
  }

  private clearHighlight() {
    if (!this.highlight) return;
    this.scene.remove(this.highlight);
    this.highlight.geometry.dispose();
    (this.highlight.material as LineBasicMaterial).dispose();
    this.highlight = null;
  }

  private describeBuilding(key: string): BuildingPick | null {
    const parts = this.data?.osm.buildings.filter((b) => editKey(b) === key) ?? [];
    if (!parts.length) return null;
    const tallest = parts.reduce((a, b) => (b.height > a.height ? b : a));
    return {
      key,
      name: parts.find((b) => b.name)?.name,
      height: tallest.height,
      heightFrom: tallest.heightFrom,
      roofShape: tallest.roofShape,
      parts: parts.length,
      editable: this.data!.detail === 'full',
    };
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
    this.buildingsMesh = null;
  }

  private fit() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
