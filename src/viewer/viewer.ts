// The 3D view of a fetched area: terrain tile with the flat layers painted on, buildings with
// roofs, structures, bridges and trees. Layers toggle on and off; the two height multipliers
// rebuild it. A click on a building, tree, bridge or structure selects it (tinted orange) for
// editing: delete, enlarge, or stretch its height.

import {
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  InstancedMesh,
  Mesh,
  MeshLambertMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { AreaData, Layer } from '../area-data';
import { clipObjects, clipToSelection } from '../clip';
import { applyEdits, editedTrees, editKey, type Edits } from '../edits';
import type { LngLat } from '../geo';
import type { OsmData } from '../osm';
import { describe } from '../selection';
import { LocalFrame } from '../local';
import { elevationAt } from '../terrain';
import { GroundTexture } from './ground';
import { buildBridges, buildBuildings, buildStructures, buildTrees, COLORS, TREE_HEIGHT_M, type PickableMesh, type Placement } from './objects';
import { buildTerrain, type Bounds } from './terrain-mesh';

// What the panel shows about a clicked object, and which edits it supports.
export interface ObjectPick {
  key: string;
  title: string;
  info: string;
  // Enlarge in all dimensions; stretch the height alone.
  canSize: boolean;
  canHeight: boolean;
}

export interface ViewScales {
  // Vertical exaggeration of the terrain, and of everything standing on it.
  terrain: number;
  heights: number;
}

// Below the lowest ground, so the tile reads as a solid block.
const BASE_DEPTH_M = 12;
const TEXTURE_LAYERS: Layer[] = ['green', 'surfaces', 'paved', 'water', 'roads', 'railways'];
const SELECTION_COLOR = new Color('#ff6b2c');
// A press and release closer than this is a click (select), not an orbit.
const CLICK_PX = 5;

// A mesh that can be clicked, with the object key under a hit.
interface Pickable {
  object: Mesh;
  keyAt: (faceIndex: number | undefined, instanceId: number | undefined) => string | undefined;
}

export class Viewer {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(40, 1, 1, 1e5);
  private controls: OrbitControls;
  private sun = new DirectionalLight('#fff6e8', 2.2);
  // The terrain tile: rebuilt by the multipliers only.
  private terrain = new Group();
  // Buildings, structures, bridges, trees: rebuilt on every edit too.
  private objects = new Group();
  private highlight = new Group();
  private layerObjects = new Map<Layer, Object3D[]>();
  private ground: GroundTexture | null = null;
  private data: AreaData | null = null;
  // The data cut to the selection (without edits), kept across rebuilds.
  private clipped: OsmData | null = null;
  private visible = new Set<Layer>();
  private resize: ResizeObserver;
  private edits: Edits = new Map();
  private placement: Placement | null = null;
  private ring: LngLat[] = [];
  private pickables: Pickable[] = [];
  private selected: string | null = null;
  // The edited, clipped objects last built, so the highlight can rebuild just one of them.
  private edited: ReturnType<typeof clipObjects> | null = null;

  constructor(
    private container: HTMLElement,
    private onPick: (pick: ObjectPick | null) => void,
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
    this.scene.add(this.sun, this.sun.target, this.terrain, this.objects, this.highlight);

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

  // Selecting needs the detailed data: tile buildings are split at tile seams and come
  // without parts, and their ids change when the detailed data replaces them.
  get canSelect(): boolean {
    return this.data?.detail === 'full';
  }

  // `keepCamera` when new data replaces what's shown (the full version after the quick one).
  show(data: AreaData, visible: Set<Layer>, scales: ViewScales, { keepCamera = false, edits = new Map() as Edits } = {}) {
    this.data = data;
    this.edits = edits;
    this.clipped = null;
    this.ground?.dispose();
    this.ground = null;
    this.visible = new Set(visible);
    this.selected = null;
    this.build(scales, !keepCamera);
    this.onPick(null);
  }

  setScales(scales: ViewScales) {
    if (this.data) this.build(scales, false);
  }

  // Edits changed: rebuild the objects, not the terrain.
  setEdits(edits: Edits) {
    this.edits = edits;
    if (this.data && this.placement) this.buildObjects();
  }

  select(key: string | null) {
    this.selected = key;
    this.drawHighlight();
    this.onPick(key ? this.describeObject(key) : null);
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
    for (const g of [this.terrain, this.objects, this.highlight]) disposeChildren(g);
    this.ground?.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private build(scales: ViewScales, frameCamera: boolean) {
    const data = this.data!;
    const { terrain, selection } = data;
    disposeChildren(this.terrain);

    const ring = (this.ring = describe(selection).ring);
    // Nothing may stick out past the tile edge.
    const osm = (this.clipped ??= clipToSelection(data.osm, ring));
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
    this.placement = {
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
    this.terrain.add(top, sides);
    this.buildObjects();

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
  private buildObjects() {
    disposeChildren(this.objects);
    for (const layer of ['buildings', 'structures', 'roads', 'railways', 'trees'] as Layer[]) this.layerObjects.delete(layer);
    this.pickables = [];
    const at = this.placement!;
    const osm = this.data!.osm;
    const edited = (this.edited = clipObjects(applyEdits(osm, this.edits), this.ring));

    const solid = (result: PickableMesh | null, layer: Layer, color?: Color) => {
      if (!result) return;
      const material = new MeshLambertMaterial(color ? { color, side: DoubleSide } : { vertexColors: true, side: DoubleSide });
      const mesh = new Mesh(result.geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.add(layer, mesh);
      this.pickables.push({ object: mesh, keyAt: (face) => (face === undefined ? undefined : result.keys[result.owners[face]]) });
    };
    solid(buildBuildings(edited.buildings, at), 'buildings');
    solid(buildStructures({ ...osm, ...edited }, at), 'structures');
    solid(buildBridges(edited.roads, at, COLORS.road), 'roads', COLORS.road);
    solid(buildBridges(edited.railways, at, COLORS.rail), 'railways', COLORS.rail);

    const trees = editedTrees(osm.trees, this.edits, TREE_HEIGHT_M);
    const treeMesh = buildTrees(trees, at);
    if (treeMesh) {
      this.add('trees', treeMesh);
      this.pickables.push({ object: treeMesh, keyAt: (_face, instance) => (instance === undefined ? undefined : trees[instance]?.key) });
    }
    this.drawHighlight();
  }

  private pickAt(e: PointerEvent) {
    if (!this.canSelect) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const visible = this.pickables.filter((p) => p.object.visible);
    const hit = ray.intersectObjects(visible.map((p) => p.object), false)[0];
    const pickable = hit && visible.find((p) => p.object === hit.object);
    this.select(pickable?.keyAt(hit.faceIndex ?? undefined, hit.instanceId) ?? null);
  }

  // The selected object drawn again in solid orange, just in front of itself.
  private drawHighlight() {
    disposeChildren(this.highlight);
    const key = this.selected;
    const at = this.placement;
    const e = this.edited;
    if (!key || !at || !e || !this.data) return;
    const material = () =>
      new MeshLambertMaterial({
        color: SELECTION_COLOR,
        emissive: SELECTION_COLOR.clone().multiplyScalar(0.35),
        side: DoubleSide,
        // Wins the depth test against the object it covers.
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
    const show = (result: PickableMesh | null) => result && this.highlight.add(new Mesh(result.geometry, material()));
    if (key.startsWith('tree/')) {
      const tree = editedTrees(this.data.osm.trees, this.edits, TREE_HEIGHT_M).find((t) => t.key === key);
      const mesh = tree ? buildTrees([tree], at, SELECTION_COLOR) : null;
      if (mesh) {
        mesh.castShadow = false;
        // A hair larger than the tree, so it covers it.
        mesh.scale.setScalar(1.02);
        this.highlight.add(mesh);
      }
      return;
    }
    show(buildBuildings(e.buildings.filter((b) => editKey(b) === key), at));
    show(
      buildStructures(
        {
          ...this.data.osm,
          structureAreas: e.structureAreas.filter((s) => s.id === key),
          structureLines: e.structureLines.filter((s) => s.id === key),
          towers: e.towers.filter((t) => t.id === key),
        },
        at,
      ),
    );
    show(buildBridges([...e.roads, ...e.railways].filter((l) => l.id === key), at, SELECTION_COLOR));
  }

  private describeObject(key: string): ObjectPick | null {
    const osm = this.data?.osm;
    if (!osm) return null;
    const m = (v: number) => `${Math.round(v)} m`;
    const nice = (kind: string) => kind[0].toUpperCase() + kind.slice(1).replace(/_/g, ' ');

    if (key.startsWith('tree/')) return { key, title: 'Tree', info: `${m(TREE_HEIGHT_M)} tall (typical)`, canSize: true, canHeight: true };

    const parts = osm.buildings.filter((b) => editKey(b) === key);
    if (parts.length) {
      const tallest = parts.reduce((a, b) => (b.height > a.height ? b : a));
      const from = { height: 'tagged', levels: 'from floors', estimate: 'estimated' }[tallest.heightFrom];
      const roof = tallest.roofShape && tallest.roofShape !== 'flat' ? `${tallest.roofShape} roof` : 'flat roof';
      const count = parts.length > 1 ? ` · ${parts.length} parts` : '';
      return { key, title: parts.find((b) => b.name)?.name ?? 'Unnamed building', info: `${m(tallest.height)} (${from}) · ${roof}${count}`, canSize: true, canHeight: true };
    }
    const area = osm.structureAreas.find((s) => s.id === key);
    if (area) return { key, title: nice(area.kind), info: m(area.height), canSize: true, canHeight: true };
    const wall = osm.structureLines.find((s) => s.id === key);
    if (wall) return { key, title: nice(wall.kind), info: `${m(wall.height)} tall`, canSize: false, canHeight: true };
    const tower = osm.towers.find((t) => t.id === key);
    if (tower) return { key, title: nice(tower.kind), info: `${m(tower.height)} tall`, canSize: true, canHeight: true };
    const bridge = [...osm.roads, ...osm.railways].find((l) => l.id === key);
    if (bridge) {
      const rail = osm.railways.includes(bridge);
      return { key, title: rail ? 'Rail bridge' : 'Road bridge', info: `${nice(bridge.kind)} · ${m(bridge.width)} wide`, canSize: false, canHeight: false };
    }
    return null;
  }

  private add(layer: Layer, object: Object3D) {
    object.visible = this.visible.has(layer);
    this.objects.add(object);
    this.layerObjects.set(layer, [...(this.layerObjects.get(layer) ?? []), object]);
  }

  private fit() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

function disposeChildren(group: Group) {
  for (const o of [...group.children]) {
    o.traverse((c) => {
      if (c instanceof Mesh || c instanceof InstancedMesh) {
        c.geometry.dispose();
        (c.material as MeshLambertMaterial).dispose();
      }
    });
    group.remove(o);
  }
}
