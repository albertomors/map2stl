// The 3D view of a fetched area: terrain tile with the flat layers painted on, buildings with
// roofs, structures, bridges and trees. Layers toggle on and off; the two height multipliers
// rebuild it. A click on a building, tree, bridge or structure selects it for editing (delete,
// enlarge, stretch its height): the object lifts off the ground, tinted light orange.

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
  MeshDepthMaterial,
  MeshLambertMaterial,
  RGBADepthPacking,
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
// How high a selected object floats (at least LIFT_M, more for tall objects), and its tint:
// a light orange that multiplies the object's own colors, so roofs and walls stay readable.
const LIFT_M = 6;
const LIFT_SHARE = 0.12;
const LIFT_EASE = 0.18;
const TINT = new Color('#ffd5b8');
const TINT_GLOW = new Color('#ff6b2c').multiplyScalar(0.12);
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
  // The selected object, lifted and tinted.
  private highlight = new Group();
  private liftKey: string | null = null;
  private liftHeight = 0;
  private unhide: (() => void) | null = null;
  // The multipliers the scene was built with, and the live stretch the sliders apply on top.
  private builtScales: ViewScales | null = null;
  private stretch = { uTerrainK: { value: 1 }, uHeightK: { value: 1 } };
  // Shadows follow the stretch too: one depth material with the same vertex patch.
  private stretchDepth: MeshDepthMaterial | null = null;
  // Trees are instances: the sliders scale their matrices (ground y, cone height) directly.
  private trees: { mesh: InstancedMesh; built: Float32Array } | null = null;
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

  // While a multiplier slider moves: stretch what's built on the GPU, no rebuild. The terrain
  // scales as a whole; objects split each vertex into ground + height above it.
  previewScales(scales: ViewScales) {
    if (!this.builtScales) return;
    const kTerrain = scales.terrain / this.builtScales.terrain;
    const kHeight = scales.heights / this.builtScales.heights;
    this.stretch.uTerrainK.value = kTerrain;
    this.stretch.uHeightK.value = kHeight;
    this.terrain.scale.y = kTerrain;
    if (this.trees) {
      const { mesh, built } = this.trees;
      const live = mesh.instanceMatrix.array as Float32Array;
      // Column-major 4×4: element 5 is the cone's height, element 13 the ground it stands on.
      for (let i = 0; i < mesh.count; i++) {
        live[i * 16 + 5] = built[i * 16 + 5] * kHeight;
        live[i * 16 + 13] = built[i * 16 + 13] * kTerrain;
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // The slider was released: rebuild for real (picking and shadows use the built geometry).
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
    this.stretchDepth?.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private build(scales: ViewScales, frameCamera: boolean) {
    this.builtScales = scales;
    this.stretch.uTerrainK.value = 1;
    this.stretch.uHeightK.value = 1;
    this.terrain.scale.y = 1;
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
      const material = this.stretchable(new MeshLambertMaterial(color ? { color, side: DoubleSide } : { vertexColors: true, side: DoubleSide }));
      const mesh = new Mesh(result.geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = this.depthMaterial();
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
    this.trees = treeMesh ? { mesh: treeMesh, built: (treeMesh.instanceMatrix.array as Float32Array).slice() } : null;
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

  // The selected object vanishes from its merged mesh and is drawn again on its own, tinted
  // light orange and lifted (the render loop eases it up).
  private drawHighlight() {
    this.unhide?.();
    this.unhide = null;
    disposeChildren(this.highlight);
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
      // Vertex colors are multiplied by the material color: the tint keeps each part's own hue.
      const tint = color ? color.clone().multiply(TINT) : TINT;
      const material = this.stretchable(
        new MeshLambertMaterial({ color: tint, emissive: TINT_GLOW, vertexColors: !color, side: DoubleSide }),
      );
      const mesh = new Mesh(result.geometry, material);
      mesh.castShadow = true;
      this.highlight.add(mesh);
    };
    if (key.startsWith('tree/')) {
      const tree = editedTrees(this.data.osm.trees, this.edits, TREE_HEIGHT_M).find((t) => t.key === key);
      const mesh = tree ? buildTrees([tree], at, COLORS.tree.clone().lerp(new Color('#ff6b2c'), 0.45)) : null;
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

  private depthMaterial(): MeshDepthMaterial {
    if (!this.stretchDepth) {
      this.stretchDepth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, side: DoubleSide });
      this.stretchDepth.onBeforeCompile = (shader) => this.patchShader(shader);
    }
    return this.stretchDepth;
  }

  // A material whose vertices follow the slider stretch: y = ground·kTerrain + above·kHeight.
  private stretchable(material: MeshLambertMaterial): MeshLambertMaterial {
    material.onBeforeCompile = (shader) => this.patchShader(shader);
    return material;
  }

  private patchShader(shader: { uniforms: Record<string, { value: unknown }>; vertexShader: string }) {
    Object.assign(shader.uniforms, this.stretch);
    shader.vertexShader =
      'attribute float groundY;\nuniform float uTerrainK;\nuniform float uHeightK;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\ntransformed.y = groundY * uTerrainK + (position.y - groundY) * uHeightK;',
      );
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
