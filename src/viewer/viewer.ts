// The 3D view of a fetched area: terrain tile with the flat layers painted on, buildings with
// roofs, structures, bridges and trees. Layers toggle on and off; the two height multipliers
// rebuild it. A click on a building, tree, bridge or structure selects it for editing (delete,
// enlarge, stretch its height): the object lifts off the ground, and a red band marks its
// footprint below.

import {
  Box3,
  BufferAttribute,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Shape,
  ShapeGeometry,
  Path,
  Vector2,
  Vector3,
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
// How high a selected object floats (at least LIFT_M, more for tall objects), and its
// footprint band.
const LIFT_M = 6;
const LIFT_SHARE = 0.12;
const LIFT_EASE = 0.18;
const OUTLINE_COLOR = new Color('#d62828');
const OUTLINE_OUT_M = 3.5;
const OUTLINE_IN_M = 0.8;
// A press and release closer than this is a click (select), not an orbit.
const CLICK_PX = 5;

// A mesh that can be clicked, with the object key under a hit.
interface Pickable {
  object: Mesh;
  keyAt: (faceIndex: number | undefined, instanceId: number | undefined) => string | undefined;
  // Makes one object vanish from the merged mesh (it's drawn lifted instead); returns the undo.
  hide: (key: string) => (() => void) | null;
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
  // The selected object, lifted; its footprint band stays on the ground.
  private highlight = new Group();
  private footprint = new Group();
  private liftKey: string | null = null;
  private liftHeight = 0;
  private unhide: (() => void) | null = null;
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
    this.scene.add(this.sun, this.sun.target, this.terrain, this.objects, this.highlight, this.footprint);

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
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.renderer.setAnimationLoop(() => {
      const target = this.liftKey ? this.liftHeight : 0;
      const y = this.highlight.position.y;
      this.highlight.position.y = reducedMotion ? target : y + (target - y) * LIFT_EASE;
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
    for (const g of [this.terrain, this.objects, this.highlight, this.footprint]) disposeChildren(g);
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
    // The old meshes go away, and the object hidden in them with them.
    this.unhide = null;
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
      this.pickables.push({
        object: mesh,
        keyAt: (face) => (face === undefined ? undefined : result.keys[result.owners[face]]),
        // Collapse the object's triangles to a point; keep the originals to put them back.
        hide: (key) => {
          const pos = mesh.geometry.getAttribute('position') as BufferAttribute;
          const array = pos.array as Float32Array;
          const saved: [number, Float32Array][] = [];
          result.owners.forEach((owner, tri) => {
            if (result.keys[owner] !== key) return;
            saved.push([tri * 9, array.slice(tri * 9, tri * 9 + 9)]);
            array.fill(0, tri * 9, tri * 9 + 9);
          });
          if (!saved.length) return null;
          pos.needsUpdate = true;
          return () => {
            for (const [at, values] of saved) array.set(values, at);
            pos.needsUpdate = true;
          };
        },
      });
    };
    solid(buildBuildings(edited.buildings, at), 'buildings');
    solid(buildStructures({ ...osm, ...edited }, at), 'structures');
    solid(buildBridges(edited.roads, at, COLORS.road), 'roads', COLORS.road);
    solid(buildBridges(edited.railways, at, COLORS.rail), 'railways', COLORS.rail);

    const trees = editedTrees(osm.trees, this.edits, TREE_HEIGHT_M);
    const treeMesh = buildTrees(trees, at);
    if (treeMesh) {
      this.add('trees', treeMesh);
      this.pickables.push({
        object: treeMesh,
        keyAt: (_face, instance) => (instance === undefined ? undefined : trees[instance]?.key),
        hide: (key) => {
          const i = trees.findIndex((t) => t.key === key);
          if (i < 0) return null;
          const saved = new Matrix4();
          treeMesh.getMatrixAt(i, saved);
          treeMesh.setMatrixAt(i, new Matrix4().makeScale(0, 0, 0));
          treeMesh.instanceMatrix.needsUpdate = true;
          return () => {
            treeMesh.setMatrixAt(i, saved);
            treeMesh.instanceMatrix.needsUpdate = true;
          };
        },
      });
    }
    this.drawHighlight();
  }

  private pickAt(e: PointerEvent) {
    if (!this.canSelect) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new Raycaster();
    ray.setFromCamera(ndc, this.camera);
    // A click on the lifted object itself keeps it selected.
    if (this.liftKey && ray.intersectObjects(this.highlight.children, true).length) return;
    const visible = this.pickables.filter((p) => p.object.visible);
    const hit = ray.intersectObjects(visible.map((p) => p.object), false)[0];
    const pickable = hit && visible.find((p) => p.object === hit.object);
    this.select(pickable?.keyAt(hit.faceIndex ?? undefined, hit.instanceId) ?? null);
  }

  // The selected object vanishes from its merged mesh and is drawn again on its own, lifted
  // (the render loop eases it up), with a red band around its footprint on the ground.
  private drawHighlight() {
    this.unhide?.();
    this.unhide = null;
    disposeChildren(this.highlight);
    disposeChildren(this.footprint);
    const key = this.selected;
    const at = this.placement;
    const e = this.edited;
    // A new object starts from the ground; a rebuild of the same one keeps its height.
    if (key !== this.liftKey) this.highlight.position.y = 0;
    this.liftKey = key;
    if (!key || !at || !e || !this.data) return;

    const undos = this.pickables.map((p) => p.hide(key)).filter((u): u is () => void => !!u);
    this.unhide = () => undos.forEach((u) => u());

    const add = (result: PickableMesh | null, color?: Color) => {
      if (!result) return;
      const material = new MeshLambertMaterial(color ? { color, side: DoubleSide } : { vertexColors: true, side: DoubleSide });
      const mesh = new Mesh(result.geometry, material);
      mesh.castShadow = true;
      this.highlight.add(mesh);
    };
    if (key.startsWith('tree/')) {
      const tree = editedTrees(this.data.osm.trees, this.edits, TREE_HEIGHT_M).find((t) => t.key === key);
      const mesh = tree ? buildTrees([tree], at) : null;
      if (mesh) this.highlight.add(mesh);
    } else {
      add(buildBuildings(e.buildings.filter((b) => editKey(b) === key), at));
      add(
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
      add(buildBridges(e.roads.filter((l) => l.id === key), at, COLORS.road), COLORS.road);
      add(buildBridges(e.railways.filter((l) => l.id === key), at, COLORS.rail), COLORS.rail);
    }
    const band = footprintBand(this.highlight);
    if (band) this.footprint.add(band);
    const box = new Box3().setFromObject(this.highlight);
    const tall = box.isEmpty() ? 0 : box.max.y - box.min.y;
    this.liftHeight = Math.max(LIFT_M * at.heightScale, LIFT_SHARE * tall);
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
      return { key, title: parts[0].groupName ?? parts.find((b) => b.name)?.name ?? 'Unnamed building', info: `${m(tallest.height)} (${from}) · ${roof}${count}`, canSize: true, canHeight: true };
    }
    const area = osm.structureAreas.find((s) => s.id === key);
    // A bridge deck spans between banks: resizing it would lift it off them.
    if (area?.kind === 'bridge') return { key, title: 'Bridge deck', info: 'Deck outline', canSize: false, canHeight: false };
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

// A flat red band around an object's footprint (the convex outline of everything in `group`,
// seen from above), at the height of its base.
function footprintBand(group: Group): Mesh | null {
  const pts: [number, number][] = [];
  let baseY = Infinity;
  const v = new Vector3();
  group.updateMatrixWorld(true);
  group.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const pos = o.geometry.getAttribute('position');
    const instances = o instanceof InstancedMesh ? o.count : 1;
    const m = new Matrix4();
    for (let i = 0; i < instances; i++) {
      if (o instanceof InstancedMesh) o.getMatrixAt(i, m);
      for (let k = 0; k < pos.count; k++) {
        v.fromBufferAttribute(pos, k);
        if (o instanceof InstancedMesh) v.applyMatrix4(m);
        pts.push([v.x, v.z]);
        baseY = Math.min(baseY, v.y);
      }
    }
  });
  if (pts.length < 3) return null;
  // Convex hull (monotone chain).
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: [number, number][]) => {
    const h: [number, number][] = [];
    for (const p of list) {
      while (h.length > 1 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    return h.slice(0, -1);
  };
  const hull = [...half(pts), ...half([...pts].reverse())];
  if (hull.length < 3) return null;
  const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length;
  const cz = hull.reduce((s, p) => s + p[1], 0) / hull.length;
  const grow = (d: number) =>
    hull.map(([x, z]) => {
      const r = Math.hypot(x - cx, z - cz) || 1;
      return new Vector2(x + ((x - cx) / r) * d, z + ((z - cz) / r) * d);
    });
  const shape = new Shape(grow(OUTLINE_OUT_M));
  shape.holes.push(new Path(grow(OUTLINE_IN_M)));
  const geometry = new ShapeGeometry(shape).rotateX(Math.PI / 2);
  const band = new Mesh(
    geometry,
    // Drawn over everything, so the lifted object can't hide its own footprint.
    new MeshBasicMaterial({ color: OUTLINE_COLOR, side: DoubleSide, depthTest: false, transparent: true, opacity: 0.9 }),
  );
  band.renderOrder = 10;
  band.position.y = baseY + 0.3;
  return band;
}
