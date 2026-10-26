// The 3D view of a fetched area: terrain tile with the flat layers painted on, buildings with
// roofs, structures, bridges and trees. Layers toggle on and off; the two height multipliers
// rebuild it. A click on a building, tree, bridge or structure selects it for editing (delete,
// enlarge, stretch its height): the object lifts off the ground, tinted light orange.

import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MOUSE,
  MeshDepthMaterial,
  MeshLambertMaterial,
  RGBADepthPacking,
  PCFShadowMap,
  PerspectiveCamera,
  Raycaster,
  Scene,
  TOUCH,
  Vector2,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { AreaData, Layer } from '../area-data';
import type { PrintModel, ThinObjects } from '../export';
import { clipObjects, clipToSelection } from '../clip';
import { applyEdits, editedTrees, editKey, type Edits, type GroundKind, type ObjectEdit } from '../edits';
import { centroid, pointInRing, ringArea, type LngLat } from '../geo';
import { elevationAt } from '../terrain';
import { isSea, type Area, type Building, type Line, type OsmData } from '../osm';
import type { Boat } from '../boats';
import { FOREST, forestAreas, type Canopy } from '../forest';
import { GroundTexture } from './ground';
import { groundAt } from './ground-pick';
import { buildBoats, buildBridges, buildBuildings, buildStructures, buildTrees, COLORS, TREE_HEIGHT_M, treeInstances, type PickableMesh, type Placement } from './objects';
import type { ObjectsReply, ObjectsRequest } from './objects-worker';
import type { SceneObjects, SolidArrays } from './scene-objects';
import { modelAssets, type Axis, type ModelAsset } from '../model-assets';
import { buildModels, fittedHeight, footprints } from './models';
import { addRelief, reliefMaterial } from './relief';
import { prepareScene } from './scene';
import { buildTerrain } from './terrain-mesh';

// What the panel shows about a clicked object, and which edits it supports.
export interface ObjectPick {
  key: string;
  title: string;
  info: string;
  // Enlarge in all dimensions; stretch the height alone.
  canSize: boolean;
  canHeight: boolean;
  // Buildings can be replaced by a 3D model; `model` names the one in use, `landmark` is
  // what to search for one by.
  canModel: boolean;
  model?: string;
  landmark?: { wikidata?: string; name?: string };
  // The model's height fitted to the footprint, against the building's (meters), and
  // whether OSM's height is real (tagged or from floors) rather than estimated.
  modelFit?: { height: number; building?: number; known: boolean };
  // Streets, railways, rivers, paths: their width can change. Areas: what they print as.
  canWidth?: boolean;
  ground?: GroundKind;
  // A wood with its trees: Delete takes the trees, not the wood.
  forest?: boolean;
  // Other buildings in the same place (OSM sometimes has one drawn over another): picking
  // gets the one on top, these are the others, to select by name.
  alsoHere?: { key: string; title: string }[];
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
// How far off a click may land and still pick a thin object.
const PICK_SLACK_PX = 5;
const CLICK_PX = 5;
// Print preview: objects narrower than the nozzle.
const THIN = new Color('#e5322d');
// Print preview of a single-color file (STL): every part in one plain filament color.
const MONO = new Color('#d9d3c9');

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
  // The print preview: the exported model in place of the scene, while it's on.
  private print = new Group();
  // One color for every part (an STL), or each part's own (a 3MF).
  private printMono = false;
  private liftKey: string | null = null;
  // The lifted copy's scaling pivot (center of its base), and the edit it was built with.
  private liftPivot: Group | null = null;
  // The layer the selected object belongs to: its checkbox hides the lifted copy too.
  private liftLayer: Layer | null = null;
  private liftEdit: ObjectEdit | null = null;
  // Set when the merged meshes lag behind edits made to the selected object.
  private objectsStale = false;
  private liftHeight = 0;
  private unhide: (() => void) | null = null;
  // The multipliers the scene was built with, and the live stretch the sliders apply on top.
  private builtScales: ViewScales | null = null;
  private stretch = { uTerrainK: { value: 1 }, uHeightK: { value: 1 } };
  // Shadows follow the stretch too: one depth material with the same vertex patch.
  private stretchDepth: MeshDepthMaterial | null = null;
  // Trees are instances: the sliders scale their matrices (ground y, cone height) directly.
  private trees: { mesh: InstancedMesh; built: Float32Array } | null = null;
  // Boats at the piers (boats.ts), as built.
  private boats: Boat[] = [];
  // Forests' canopy (forest.ts), its height field, and its colors as built (the selected
  // wood is tinted over them).
  private canopy: { mesh: Mesh; field: Canopy; colors: Float32Array } | null = null;
  // The terrain's top, with the painted map (exported with the relief baked in).
  private terrainTop: Mesh | null = null;
  // How far above the ground the camera stays (scene units, from the tile's size), and the
  // tile's outline (scene x, z), which the orbit's center stays inside.
  private clearance = 2;
  private disposed = false;
  // The objects' worker (placeObjects), the latest request to it, and what it already holds.
  private objectsWorker: Worker | null = null;
  private objectsJob = 0;
  private sentData: AreaData | null = null;
  private sentModels = new Set<string>();
  // Something changed since the last frame drawn.
  private dirty = true;
  private outline: [number, number][] = [];
  // Terrain height → scene height, as last built.
  private groundHeight: (h: number) => number = (h) => h;
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
    this.scene.add(this.sun, this.sun.target, this.terrain, this.objects, this.highlight, this.print);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    // The map's controls: drag pans, right-drag (or Ctrl+drag) orbits.
    this.controls.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE };
    this.controls.touches = { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_ROTATE };
    // Never below the ground plane: drags pan along it (in screen space they'd also move the
    // orbit's center up and down, down under the tile), and the camera stays above the
    // horizon of its center.
    this.controls.screenSpacePanning = false;
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
    // Drawn only when something changed: the camera moving (or still gliding), the selected
    // object lifting, or a change the methods below flag. A big city takes long to draw, and
    // drawing it every frame for nothing keeps the page (and the fan) busy. Once a second
    // anyway, in case some change went unflagged.
    let lastDrawn = 0;
    this.renderer.setAnimationLoop((now) => {
      const target = this.liftKey ? this.liftHeight : 0;
      const y = this.highlight.position.y;
      const lifting = Math.abs(target - y) > 1e-3;
      this.highlight.position.y = reducedMotion || !lifting ? target : y + (target - y) * LIFT_EASE;
      const moved = this.controls.update();
      if (!moved && !lifting && !this.dirty && now - lastDrawn < 1000) return;
      this.keepAboveGround();
      this.renderer.render(this.scene, this.camera);
      this.dirty = false;
      lastDrawn = now;
    });
  }

  // The orbit's center stays over the tile (dragging it off leaves an empty view, with no
  // way back but Back to map); and zoomed in close over a mountain, the camera can be inside
  // the ground under it: it's lifted to clear the terrain.
  private keepAboveGround() {
    if (!this.data || !this.placement || !this.outline.length) return;
    const t = this.controls.target;
    const [cx, cz] = pointInRing([t.x, t.z], this.outline) ? [t.x, t.z] : nearestOnRing([t.x, t.z], this.outline);
    const [dx, dz] = [cx - t.x, cz - t.z];
    if (dx || dz) {
      t.x += dx;
      t.z += dz;
      this.camera.position.x += dx;
      this.camera.position.z += dz;
    }
    const { x, y, z } = this.camera.position;
    const [lng, lat] = this.placement.frame.toLngLat([x, z]);
    const [w, s, e, n] = this.data.terrain.bbox;
    if (lng < w || lng > e || lat < s || lat > n) return;
    const floor = this.groundHeight(elevationAt(this.data.terrain, lng, lat)) * this.terrain.scale.y + this.clearance;
    if (y < floor) this.camera.position.y = floor;
  }

  // Selecting needs the detailed data: tile buildings are split at tile seams and come
  // without parts, and their ids change when the detailed data replaces them.
  get canSelect(): boolean {
    return this.data?.detail === 'full' && !this.print.children.length;
  }

  // The model exactly as it will print, one color per part (or one for all: `mono`), objects
  // narrower than the nozzle in red; null goes back to the normal view.
  showPrint(model: PrintModel | null, thin?: ThinObjects, mono = this.printMono) {
    this.dirty = true;
    this.printMono = mono;
    disposeChildren(this.print);
    if (model) this.select(null);
    for (const g of [this.terrain, this.objects, this.highlight]) g.visible = !model;
    if (!model) return;
    for (const part of model.parts) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(part.triangles, 3));
      geometry.computeVertexNormals();
      const flagged = thin?.objects.get(part);
      // Which triangles are too thin, to keep them red whatever the colors.
      const thinTris = flagged ? Uint8Array.from(part.objects, (o) => (flagged.has(o) ? 1 : 0)) : null;
      if (thinTris) geometry.setAttribute('color', new BufferAttribute(new Float32Array(part.triangles.length), 3));
      const mesh = new Mesh(geometry, new MeshLambertMaterial({ vertexColors: !!thinTris }));
      mesh.userData = { color: part.color, thinTris };
      this.paintPrint(mesh);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(model.toScene);
      this.print.add(mesh);
    }
  }

  // Which way is up for a new model of this building: the file's own up axis, unless
  // another makes it come out much closer to the building's known height (a model lying on
  // its side comes out as tall as the building is wide).
  suggestModelUp(key: string, asset: ModelAsset): Axis {
    const foot = this.footprintOf(key);
    const frame = this.placement?.frame;
    if (!frame || !foot) return asset.up;
    const height = (up: Axis) => fittedHeight(asset, { asset: asset.id, up, turns: 0 }, foot.points, frame) ?? Infinity;
    // How far off each axis comes out (lower is better): against the known height, or, for a
    // bridge (long and low, with no height in OSM), just its height: the lowest lies right.
    const target = foot.known ? foot.height : undefined;
    const bridge = !this.data?.osm.buildings.some((b) => editKey(b) === key);
    if (!target && !bridge) return asset.up;
    const off = (up: Axis) => {
      const h = height(up);
      return target ? Math.max(h / target, target / h) : h;
    };
    const best = (['x', 'y', 'z'] as const).reduce((a, b) => (off(b) < off(a) ? b : a), asset.up);
    // Only when clearly better: the file's own convention usually holds.
    return off(best) * 1.3 < off(asset.up) ? best : asset.up;
  }

  // Other buildings sharing this one's place: either holds the other's middle.
  private buildingsOverlapping(key: string, parts: Building[]): { key: string; title: string; name?: string; wikidata?: string }[] {
    const osm = this.data?.osm;
    if (!osm) return [];
    const mid = (b: Building) => centroid(b.outer);
    const box = (rings: LngLat[][]) => {
      const pts = rings.flat();
      return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
    };
    const [w, s, e, n] = box(parts.map((b) => b.outer));
    const found = new Map<string, { title: string; name?: string; wikidata?: string }>();
    for (const b of osm.buildings) {
      const other = editKey(b);
      if (other === key || found.has(other)) continue;
      const [bw, bs, be, bn] = box([b.outer]);
      if (be < w || bw > e || bn < s || bs > n) continue;
      const overlaps = parts.some((p) => pointInRing(mid(p), b.outer) || pointInRing(mid(b), p.outer));
      const name = b.groupName ?? b.name;
      if (overlaps) found.set(other, { title: name ?? 'Unnamed building', name, wikidata: b.groupWikidata ?? b.wikidata });
    }
    // Named ones first: the landmark the rest are drawn over.
    return [...found].map(([k, o]) => ({ key: k, ...o })).sort((a, b) => Number(!a.name) - Number(!b.name));
  }

  // The 3D model standing in for this object, if any, and how tall it comes out fitted
  // (against the object's height in OSM, where that's known).
  private modelInfo(key: string): Pick<ObjectPick, 'model' | 'modelFit'> {
    const choice = this.edits.get(key)?.model;
    const asset = choice && modelAssets.get(choice.asset);
    const frame = this.placement?.frame;
    const foot = this.footprintOf(key);
    if (!asset || !choice || !frame || !foot) return {};
    const height = fittedHeight(asset, choice, foot.points, frame);
    return { model: asset.source.title, modelFit: height ? { height, building: foot.height, known: !!foot.known } : undefined };
  }

  // The footprint a model of this object fits: a building's, or a bridge's.
  private footprintOf(key: string) {
    const osm = this.data?.osm;
    if (!osm) return undefined;
    return footprints(osm, 'buildings', key).get(key) ?? footprints(osm, 'bridges', key).get(key);
  }

  // Switches the print preview between one color for all parts and each part's own.
  // The scene as shown (layers on, edits, multipliers), as a glTF file (gltf.ts). The
  // selected object goes back into place for it, untinted.
  async exportGltf(binary: boolean, credits: string): Promise<Blob> {
    // Loaded on first use: the exporter isn't needed to look at the view.
    const { sceneToGltf } = await import('./gltf');
    const selected = this.selected;
    if (selected) this.select(null);
    try {
      return await sceneToGltf(this.renderer, [this.terrain, this.objects], this.terrainTop, binary, credits);
    } finally {
      if (selected) this.select(selected);
    }
  }

  // The view as it is now, as a PNG (bug reports). Drawn again first: the canvas keeps no
  // copy of the last frame.
  screenshot(): Promise<Blob | null> {
    this.renderer.render(this.scene, this.camera);
    return new Promise((resolve) => this.renderer.domElement.toBlob(resolve));
  }

  cameraState() {
    return { position: this.camera.position.toArray(), target: this.controls.target.toArray() };
  }

  setPrintMonochrome(mono: boolean) {
    this.dirty = true;
    this.printMono = mono;
    for (const mesh of this.print.children) this.paintPrint(mesh as Mesh);
  }

  private paintPrint(mesh: Mesh) {
    const { color, thinTris } = mesh.userData as { color: string; thinTris: Uint8Array | null };
    const base = this.printMono ? MONO : new Color(color);
    const material = mesh.material as MeshLambertMaterial;
    if (!thinTris) {
      material.color.copy(base);
      return;
    }
    const attr = mesh.geometry.getAttribute('color') as BufferAttribute;
    const colors = attr.array as Float32Array;
    thinTris.forEach((thin, tri) => {
      const c = thin ? THIN : base;
      for (let v = 0; v < 3; v++) colors.set([c.r, c.g, c.b], tri * 9 + v * 3);
    });
    attr.needsUpdate = true;
  }

  // `keepCamera` when new data replaces what's shown (the full version after the quick one).
  show(data: AreaData, visible: Set<Layer>, scales: ViewScales, { keepCamera = false, edits = new Map() as Edits } = {}) {
    this.dirty = true;
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

  // The same as show(), a stage per frame, so the page can say how far it got (a big city
  // takes a while): `onStage` gets each stage's name and how many came before it out of
  // BUILD_STAGES.
  async showStaged(data: AreaData, visible: Set<Layer>, scales: ViewScales, edits: Edits, onStage: (name: string, done: number) => void) {
    this.data = data;
    this.edits = edits;
    this.clipped = null;
    this.ground?.dispose();
    this.ground = null;
    this.visible = new Set(visible);
    this.selected = null;
    let done = 0;
    for (const stage of this.building(scales, true)) {
      this.dirty = true;
      // The objects, from the worker: waited for, the page responsive meanwhile.
      if (typeof stage !== 'string') {
        await stage;
        if (this.disposed) return;
        continue;
      }
      onStage(stage, done++);
      // A frame for the bar to show; a background tab gets no frames, so not longer than this.
      await new Promise((resolve) => {
        requestAnimationFrame(resolve);
        setTimeout(resolve, 100);
      });
      // Closed meanwhile (a new selection): stop building.
      if (this.disposed) return;
    }
    this.onPick(null);
  }

  // While a multiplier slider moves: stretch what's built on the GPU, no rebuild. The terrain
  // scales as a whole; objects split each vertex into ground + height above it.
  previewScales(scales: ViewScales) {
    this.dirty = true;
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
    this.dirty = true;
    if (this.data) this.build(scales, false);
  }

  // Edits changed: rebuild the objects, not the terrain.
  // `selectedOnly`: the edit touched just the selected object (its size sliders). Rebuild
  // only its lifted copy now; the rest of the scene catches up when the selection changes,
  // and until then the object is hidden there anyway.
  setEdits(edits: Edits, { selectedOnly = false } = {}) {
    this.dirty = true;
    this.edits = edits;
    if (!this.data || !this.placement) return;
    // Streets and areas are painted on the ground: repaint it with the edits.
    if (this.ground && this.clipped) {
      this.ground.setData(applyEdits(this.clipped, edits));
      this.paintGround();
    }
    if (selectedOnly && this.selected) {
      this.objectsStale = true;
      this.drawHighlight();
    } else {
      this.objectsStale = false;
      this.buildObjects();
    }
  }

  // While an object's Size or Height slider moves: stretch its lifted copy from the center of
  // its base on the GPU, relative to the edit it was built with. No rebuild.
  previewEdit(edit: ObjectEdit | undefined) {
    this.dirty = true;
    const built = this.liftEdit;
    const pivot = this.liftPivot;
    if (!built || !pivot) return;
    const kSize = (edit?.scale ?? 1) / (built.scale ?? 1);
    const kHeight = (edit?.heightScale ?? 1) / (built.heightScale ?? 1);
    pivot.scale.set(kSize, kSize * kHeight, kSize);
  }

  select(key: string | null) {
    this.dirty = true;
    this.selected = key;
    // Edits made while the last object was selected reach the merged meshes now.
    if (this.objectsStale && this.placement) {
      this.objectsStale = false;
      this.buildObjects();
    } else {
      this.drawHighlight();
    }
    this.paintGround();
    this.onPick(key ? this.describeObject(key) : null);
  }

  // The ground, with the selected street or area (if that's what's selected) highlighted.
  private paintGround() {
    this.ground?.paint(this.visible, this.selected);
    this.tintCanopy();
  }

  // The selected wood's canopy tinted like a selected object; the rest as built.
  private tintCanopy() {
    if (!this.canopy || !this.clipped) return;
    const { mesh, field, colors } = this.canopy;
    const attr = mesh.geometry.getAttribute('color') as BufferAttribute;
    const live = attr.array as Float32Array;
    live.set(colors);
    const woods = this.selected ? applyEdits(this.clipped, this.edits).green.filter((a) => a.id === this.selected && FOREST.test(a.kind)) : [];
    const frame = this.placement!.frame;
    const tint = new Color('#ff6b2c');
    for (const wood of woods) {
      const outer = wood.outer.map((p) => frame.toLocal(p));
      const holes = wood.holes.map((h) => h.map((p) => frame.toLocal(p)));
      const xs = outer.map((p) => p[0]);
      const zs = outer.map((p) => p[1]);
      const cell = (v: number, v0: number) => Math.round((v - v0) / field.cell);
      const [i0, i1] = [Math.max(0, cell(Math.min(...xs), field.x0)), Math.min(field.cols - 1, cell(Math.max(...xs), field.x0))];
      const [j0, j1] = [Math.max(0, cell(Math.min(...zs), field.z0)), Math.min(field.rows - 1, cell(Math.max(...zs), field.z0))];
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const p: [number, number] = [field.x0 + i * field.cell, field.z0 + j * field.cell];
          if (!pointInRing(p, outer) || holes.some((h) => pointInRing(p, h))) continue;
          const k = (j * field.cols + i) * 3;
          for (let c = 0; c < 3; c++) live[k + c] += ([tint.r, tint.g, tint.b][c] - live[k + c]) * 0.45;
        }
      }
    }
    attr.needsUpdate = true;
  }

  setLayerVisible(layer: Layer, visible: boolean) {
    this.dirty = true;
    if (visible) this.visible.add(layer);
    else this.visible.delete(layer);
    for (const o of this.layerObjects.get(layer) ?? []) o.visible = visible;
    if (layer === this.liftLayer) this.highlight.visible = visible && !this.print.children.length;
    if (TEXTURE_LAYERS.includes(layer)) this.paintGround();
    // Water on or off moves the ground itself where there's sea: sea level, or the sea floor.
    if (layer === 'water' && this.data?.osm.waterAreas.some(isSea) && this.builtScales) this.build(this.builtScales, false);
  }

  dispose() {
    this.disposed = true;
    this.objectsWorker?.terminate();
    this.renderer.setAnimationLoop(null);
    this.resize.disconnect();
    for (const g of [this.terrain, this.objects, this.highlight, this.print]) disposeChildren(g);
    this.ground?.dispose();
    this.stretchDepth?.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private build(scales: ViewScales, frameCamera: boolean) {
    drain(this.building(scales, frameCamera));
  }

  // The scene built stage by stage: each yield names the stage about to run.
  private *building(scales: ViewScales, frameCamera: boolean): Generator<string | Promise<void>> {
    this.builtScales = scales;
    this.stretch.uTerrainK.value = 1;
    this.stretch.uHeightK.value = 1;
    this.terrain.scale.y = 1;
    const data = this.data!;
    const { terrain } = data;
    disposeChildren(this.terrain);

    // Water off: the sea floor shows (its real depths), the deepest point the lowest.
    const { ring, frame, bounds, placement, groundHeight } = prepareScene(data, scales, !this.visible.has('water'));
    this.ring = ring;
    this.placement = placement;
    this.groundHeight = groundHeight;
    // Nothing may stick out past the tile edge.
    const osm = (this.clipped ??= clipToSelection(data.osm, ring));

    yield 'Painting the map onto the ground';
    if (!this.ground) {
      this.ground = new GroundTexture(applyEdits(osm, this.edits), frame, bounds, this.renderer.capabilities.maxTextureSize);
      this.paintGround();
    }
    yield 'Shaping the terrain';
    const tile = buildTerrain(terrain, ring, frame, bounds, groundHeight, BASE_DEPTH_M);
    // Rock on steep ground, darker hollows (relief.ts), over the painted map.
    addRelief(tile.top);
    const top = new Mesh(tile.top, reliefMaterial(new MeshLambertMaterial({ map: this.ground.texture })));
    top.name = 'terrain';
    top.receiveShadow = true;
    this.terrainTop = top;
    const sides = new Mesh(tile.sides, new MeshLambertMaterial({ color: '#b9ab96', side: DoubleSide }));
    sides.name = 'terrain sides';
    this.terrain.add(top, sides);
    yield 'Raising the buildings, bridges and trees';
    yield this.placeObjects();

    // Sun from the south-west, its shadow box sized to the tile.
    const radius = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2;
    this.clearance = Math.max(2, radius / 200);
    this.outline = ring.map((p) => frame.toLocal(p));
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -radius * 1.2;
    cam.right = cam.top = radius * 1.2;
    cam.near = 1;
    cam.far = radius * 6;
    cam.updateProjectionMatrix();
    // Push shadow lookups out by about two shadow-map pixels: less and walls shade themselves
    // in stripes ("shadow acne"), much more and shadows detach from the buildings.
    this.sun.shadow.normalBias = 2 * ((2.4 * radius) / this.sun.shadow.mapSize.x);
    // Low enough (about 30° up) for long shadows that bring out the relief.
    this.sun.position.set(-radius * 1.2, radius * 1.1, radius * 1.4);
    this.sun.target.position.set(0, 0, 0);

    if (frameCamera) {
      this.camera.near = Math.max(0.5, radius / 2000);
      this.camera.far = radius * 30;
      // Aimed at the middle of the terrain's heights, and further back the taller it stands:
      // in the mountains, a camera framed for a flat tile starts on a cliff face, the peaks
      // off the screen.
      tile.top.computeBoundingBox();
      const { min, max } = tile.top.boundingBox!;
      const mid = Math.max(0, (min.y + max.y) / 2);
      const back = 1 + (max.y - min.y) / (2 * radius);
      this.camera.position.set(0, mid + radius * 1.1 * back, radius * 1.6 * back);
      this.controls.target.set(0, mid, 0);
      this.controls.maxDistance = radius * 8;
      // Not so close that a building fills the screen and the view seems empty.
      this.controls.minDistance = radius / 100;
      this.fit();
    }
  }

  private buildObjects() {
    void this.placeObjects();
  }

  // The objects (buildings, structures, bridges, boats, trees, forests) are built in a worker
  // (scene-objects.ts): a big city takes seconds, on opening and on every edit, and the page
  // would freeze meanwhile. Until they arrive the old ones stay; a newer request makes an
  // older answer obsolete. Edits first, then the cut at the tile edge (an enlarged landmark
  // is still trimmed there): the worker does both.
  private placeObjects(): Promise<void> {
    const id = ++this.objectsJob;
    const data = this.data!;
    this.objectsWorker ??= new Worker(new URL('./objects-worker.ts', import.meta.url), { type: 'module' });
    const worker = this.objectsWorker;
    // Only the models the worker hasn't been sent yet (official ones come by the hundred).
    const models = [...this.edits.values()].flatMap((e) => {
      const asset = e.model && modelAssets.get(e.model.asset);
      return asset && !this.sentModels.has(asset.id) ? [asset] : [];
    });
    for (const m of models) this.sentModels.add(m.id);
    const request: ObjectsRequest = {
      id,
      job: { scales: this.builtScales!, seaFloor: !this.visible.has('water'), edits: this.edits },
      models,
      // The data travels once per area: copying a city's takes a moment.
      ...(data !== this.sentData ? { data } : {}),
    };
    this.sentData = data;
    return new Promise((resolve) => {
      const reply = (e: MessageEvent<ObjectsReply>) => {
        if (e.data.id !== id) return;
        worker.removeEventListener('message', reply);
        if (id === this.objectsJob && !this.disposed) {
          if (e.data.ok) this.showObjects(e.data.objects);
          else console.error('Building the 3D objects failed', e.data.message);
        }
        resolve();
      };
      worker.addEventListener('message', reply);
      worker.postMessage(request);
    });
  }

  private showObjects(o: SceneObjects) {
    // The old meshes go away, and the object hidden in them with them.
    this.unhide = null;
    disposeChildren(this.objects);
    for (const layer of ['buildings', 'structures', 'roads', 'railways', 'trees', 'water'] as Layer[]) this.layerObjects.delete(layer);
    this.pickables = [];
    for (const s of o.solids) this.showSolid(s);
    this.boats = o.boats;
    this.showTrees(o.trees);
    this.showCanopy(o.canopy);
    this.drawHighlight();
    this.dirty = true;
  }

  private showSolid(s: SolidArrays) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(s.positions, 3));
    g.setAttribute('normal', new BufferAttribute(s.normals, 3));
    g.setAttribute('color', new BufferAttribute(s.colors, 3));
    g.setAttribute('groundY', new BufferAttribute(s.grounds, 1));
    const color = s.color === undefined ? undefined : new Color(s.color);
    const material = this.stretchable(new MeshLambertMaterial(color ? { color, side: DoubleSide } : { vertexColors: true, side: DoubleSide }));
    const mesh = new Mesh(g, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.customDepthMaterial = this.depthMaterial();
    this.add(s.layer, mesh);
    this.pickables.push({
      object: mesh,
      keyAt: (face) => (face === undefined ? undefined : s.keys[s.owners[face]]),
      // Collapse the object's triangles to a point; keep the originals to put them back.
      hide: (key) => {
        const pos = mesh.geometry.getAttribute('position') as BufferAttribute;
        const array = pos.array as Float32Array;
        const saved: [number, Float32Array][] = [];
        s.owners.forEach((owner, tri) => {
          if (s.keys[owner] !== key) return;
          saved.push([tri * 9, array.slice(tri * 9, tri * 9 + 9)]);
          array.fill(0, tri * 9, tri * 9 + 9);
        });
        if (!saved.length) return null;
        pos.needsUpdate = true;
        // Picking caches the mesh's bounds: computed now, with the object collapsed, they'd
        // miss it forever after (a model alone in its mesh would never be clickable again).
        mesh.geometry.boundingSphere = mesh.geometry.boundingBox = null;
        return () => {
          for (const [at, values] of saved) array.set(values, at);
          pos.needsUpdate = true;
          mesh.geometry.boundingSphere = mesh.geometry.boundingBox = null;
        };
      },
    });
  }

  // OSM's single trees and the forests' border trees, one cone each.
  private showTrees(trees: SceneObjects['trees']) {
    this.trees = null;
    if (!trees || !trees.keys.length) return;
    const { keys, matrices } = trees;
    const treeMesh = treeInstances(keys.length, COLORS.tree, matrices);
    this.trees = { mesh: treeMesh, built: matrices.slice() };
    this.add('trees', treeMesh);
    this.pickables.push({
      object: treeMesh,
      // A forest's tree isn't an object of its own: the click goes to its wood (pickAt).
      keyAt: (_face, instance) => {
        const key = instance === undefined ? undefined : keys[instance];
        return key?.startsWith('forest/') ? undefined : key;
      },
      hide: (key) => {
        const i = keys.indexOf(key);
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

  // The forests' canopy.
  private showCanopy(canopy: SceneObjects['canopy']) {
    this.canopy = null;
    if (!canopy) return;
    const { field, positions, grounds, index, colors } = canopy;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(positions, 3));
    g.setAttribute('groundY', new Float32BufferAttribute(grounds, 1));
    g.setAttribute('color', new BufferAttribute(colors.slice(), 3));
    g.setIndex(new BufferAttribute(index, 1));
    g.computeVertexNormals();
    const mesh = new Mesh(g, this.stretchable(new MeshLambertMaterial({ vertexColors: true })));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.customDepthMaterial = this.depthMaterial();
    this.add('trees', mesh);
    this.canopy = { mesh, field, colors };
    this.tintCanopy();
  }

  private pickAt(e: PointerEvent) {
    if (!this.canSelect) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new Raycaster();
    ray.setFromCamera(ndc, this.camera);
    // A click on the lifted object itself keeps it selected.
    if (this.liftKey && this.highlight.visible && ray.intersectObjects(this.highlight.children, true).length) return;
    const visible = this.pickables.filter((p) => p.object.visible);
    const objectAt = (dx: number, dy: number): string | undefined => {
      const probe = new Raycaster();
      probe.setFromCamera(new Vector2(ndc.x + (dx * 2) / rect.width, ndc.y - (dy * 2) / rect.height), this.camera);
      const hit = probe.intersectObjects(visible.map((p) => p.object), false)[0];
      return hit && visible.find((p) => p.object === hit.object)?.keyAt(hit.faceIndex ?? undefined, hit.instanceId);
    };
    // Thin things (a mast, the London Eye's rim) are hard to hit to the pixel: a near miss
    // still finds them.
    const near = Array.from({ length: 8 }, (_, k) => [Math.cos((k * Math.PI) / 4) * PICK_SLACK_PX, Math.sin((k * Math.PI) / 4) * PICK_SLACK_PX]);
    for (const [dx, dy] of [[0, 0], ...near]) {
      const key = objectAt(dx, dy);
      if (key) return this.select(key);
    }
    // No object: a forest's canopy (its wood), or the street, river or area painted on the
    // ground there, if any.
    const top = this.terrain.children[0];
    const canopy = this.canopy?.mesh.visible ? this.canopy.mesh : null;
    const ground = top && ray.intersectObjects(canopy ? [canopy, top] : [top], false)[0];
    if (ground && ground.object === canopy && this.clipped && this.placement) {
      const at = this.placement.frame.toLngLat([ground.point.x, ground.point.z]);
      const bare = (id: string) => !!this.edits.get(id)?.noTrees;
      const wood = forestAreas(applyEdits(this.clipped, this.edits), bare).find((a) => pointInRing(at, a.outer) && !a.holes.some((h) => pointInRing(at, h)));
      if (wood) return this.select(wood.id);
    }
    if (ground && this.clipped && this.placement) {
      const at = this.placement.frame.toLngLat([ground.point.x, ground.point.z]);
      return this.select(groundAt(applyEdits(this.clipped, this.edits), this.visible, at, this.placement.frame));
    }
    this.select(null);
  }

  // The selected object vanishes from its merged mesh and is drawn again on its own, tinted
  // light orange and lifted (the render loop eases it up).
  private drawHighlight() {
    this.unhide?.();
    this.unhide = null;
    disposeChildren(this.highlight);
    this.liftPivot = null;
    const key = this.selected;
    const at = this.placement;
    const data = this.data;
    // A new object starts from the ground; a rebuild of the same one keeps its height, and
    // its lift: editing its size must not make it jump higher or lower.
    const newSelection = key !== this.liftKey;
    if (newSelection) this.highlight.position.y = 0;
    this.liftKey = key;
    if (!key || !at || !data) return;

    const undos = this.pickables.map((p) => p.hide(key)).filter((u): u is () => void => !!u);
    this.unhide = () => undos.forEach((u) => u());

    // Built from this object alone (edited and cut at the tile edge), so it's cheap.
    const osm = data.osm;
    const own = clipObjects(
      applyEdits(
        {
          ...osm,
          buildings: osm.buildings.filter((b) => editKey(b) === key),
          roads: osm.roads.filter((l) => l.id === key),
          railways: osm.railways.filter((l) => l.id === key),
          structureAreas: osm.structureAreas.filter((s) => s.id === key),
          structureLines: osm.structureLines.filter((s) => s.id === key),
          towers: osm.towers.filter((t) => t.id === key),
        },
        this.edits,
      ),
      this.ring,
    );
    // Meshes go in `inner`, offset so the pivot sits at the center of the object's base.
    const inner = new Group();
    const add = (result: PickableMesh | null, color?: Color) => {
      if (!result) return;
      // Vertex colors are multiplied by the material color: the tint keeps each part's own hue.
      const tint = color ? color.clone().multiply(TINT) : TINT;
      const material = this.stretchable(
        new MeshLambertMaterial({ color: tint, emissive: TINT_GLOW, vertexColors: !color, side: DoubleSide }),
      );
      const mesh = new Mesh(result.geometry, material);
      mesh.castShadow = true;
      inner.add(mesh);
    };
    if (key.startsWith('boat/')) {
      add(buildBoats(this.boats.filter((b) => b.key === key), at));
    } else if (key.startsWith('tree/')) {
      const tree = editedTrees(osm.trees, this.edits, TREE_HEIGHT_M).find((t) => t.key === key);
      const mesh = tree ? buildTrees([tree], at, COLORS.tree.clone().lerp(new Color('#ff6b2c'), 0.45)) : null;
      if (mesh) inner.add(mesh);
    } else {
      add(buildBuildings(own.buildings, at));
      add(buildModels(osm, this.edits, at, 'buildings', key));
      add(buildModels(osm, this.edits, at, 'bridges', key));
      add(buildStructures({ ...osm, ...own }, at));
      add(buildBridges(own.roads, at, COLORS.road), COLORS.road);
      add(buildBridges(own.railways, at, COLORS.rail), COLORS.rail);
    }
    const box = new Box3().setFromObject(inner);
    if (box.isEmpty()) return;
    const pivot = new Group();
    pivot.position.set((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
    inner.position.copy(pivot.position).negate();
    pivot.add(inner);
    this.highlight.add(pivot);
    this.liftPivot = pivot;
    this.liftLayer = key.startsWith('boat/')
      ? 'water'
      : key.startsWith('tree/')
      ? 'trees'
      : own.buildings.length || osm.buildings.some((b) => editKey(b) === key)
        ? 'buildings'
        : own.roads.length
          ? 'roads'
          : own.railways.length
            ? 'railways'
            : 'structures';
    this.highlight.visible = this.visible.has(this.liftLayer);
    this.liftEdit = { ...this.edits.get(key) };
    if (newSelection) this.liftHeight = Math.max(LIFT_M * at.heightScale, LIFT_SHARE * (box.max.y - box.min.y));
  }

  private describeObject(key: string): ObjectPick | null {
    const osm = this.data?.osm;
    if (!osm) return null;
    const m = (v: number) => `${Math.round(v)} m`;
    const nice = (kind: string) => kind[0].toUpperCase() + kind.slice(1).replace(/_/g, ' ');

    const no = { canModel: false };
    if (key.startsWith('tree/')) return { key, title: 'Tree', info: `${m(TREE_HEIGHT_M)} tall (typical)`, canSize: true, canHeight: true, ...no };
    const boat = key.startsWith('boat/') ? this.boats.find((b) => b.key === key) : undefined;
    if (boat) return { key, title: 'Boat', info: `${m(boat.length)} long · placed at the pier (not in OpenStreetMap)`, canSize: false, canHeight: false, ...no };

    const parts = osm.buildings.filter((b) => editKey(b) === key);
    if (parts.length) {
      const tallest = parts.reduce((a, b) => (b.height > a.height ? b : a));
      const from = { height: 'tagged', levels: 'from floors', estimate: 'estimated' }[tallest.heightFrom];
      const roof = tallest.roofShape && tallest.roofShape !== 'flat' ? `${tallest.roofShape} roof` : 'flat roof';
      const count = parts.length > 1 ? ` · ${parts.length} parts` : '';
      const title = parts[0].groupName ?? parts.find((b) => b.name)?.name ?? 'Unnamed building';
      const { model, modelFit } = this.modelInfo(key);
      const wikidata = parts[0].groupWikidata ?? parts.find((b) => b.wikidata)?.wikidata;
      const name = parts[0].groupName ?? parts.find((b) => b.name)?.name;
      const overlapping = this.buildingsOverlapping(key, parts);
      const alsoHere = overlapping.map(({ key: k, title: t }) => ({ key: k, title: t }));
      // Unnamed, but drawn over a named landmark (a detailed remapping of it): search by that.
      const named = !name && !wikidata ? overlapping.find((o) => o.name || o.wikidata) : undefined;
      const landmark = named ? { wikidata: named.wikidata, name: named.name } : { wikidata, name };
      return { key, title, info: `${m(tallest.height)} (${from}) · ${roof}${count}`, canSize: true, canHeight: true, canModel: true, model, landmark, modelFit, alsoHere };
    }
    const area = osm.structureAreas.find((s) => s.id === key);
    // A bridge deck spans between banks: resizing it would lift it off them.
    // A bridge can be replaced by a 3D model (then sized like one).
    if (area?.kind === 'bridge') {
      const info = this.modelInfo(key);
      const landmark = { name: area.name, wikidata: area.wikidata };
      return { key, title: area.name ?? 'Bridge deck', info: 'Deck outline', canSize: !!info.model, canHeight: !!info.model, canModel: true, landmark, ...info };
    }
    if (area) return { key, title: nice(area.kind), info: m(area.height), canSize: true, canHeight: true, ...no };
    const wall = osm.structureLines.find((s) => s.id === key);
    if (wall) return { key, title: nice(wall.kind), info: `${m(wall.height)} tall`, canSize: false, canHeight: true, ...no };
    const tower = osm.towers.find((t) => t.id === key);
    if (tower) return { key, title: nice(tower.kind), info: `${m(tower.height)} tall`, canSize: true, canHeight: true, ...no };
    const ground = this.describeGround(key);
    if (ground) return ground;
    const bridge = [...osm.roads, ...osm.railways].find((l) => l.id === key && l.bridge);
    if (bridge) {
      const rail = osm.railways.includes(bridge);
      const info = this.modelInfo(key);
      const landmark = { name: bridge.name, wikidata: bridge.wikidata };
      const title = bridge.name ?? (rail ? 'Rail bridge' : 'Road bridge');
      return { key, title, info: `${nice(bridge.kind)} · ${m(bridge.width)} wide`, canSize: !!info.model, canHeight: !!info.model, canModel: true, landmark, ...info };
    }
    return null;
  }

  // A street, railway, river or path (its width can change), or an area (what it prints as
  // can change): their edit applied, as the ground shows them.
  private describeGround(key: string): ObjectPick | null {
    const osm = this.data?.osm;
    if (!osm) return null;
    const nice = (kind: string) => kind[0].toUpperCase() + kind.slice(1).replace(/_/g, ' ');
    const e = this.edits.get(key);
    const lines: [string, Line[]][] = [
      ['Street', osm.roads],
      ['Railway', osm.railways],
      ['Waterway', osm.waterways],
      ['Path', osm.pavedLines],
    ];
    for (const [what, list] of lines) {
      const l = list.find((x) => x.id === key && !x.bridge);
      if (!l) continue;
      const width = l.width * (e?.width ?? 1);
      return { key, title: l.name ?? `${what}: ${nice(l.kind)}`, info: `${nice(l.kind)} · ${Math.round(width * 10) / 10} m wide`, canSize: false, canHeight: false, canModel: false, canWidth: true };
    }
    const areas: [GroundKind, Area[]][] = [
      ['water', osm.waterAreas],
      ['green', osm.green],
      ['paved', osm.pavedAreas],
      ['surfaces', osm.surfaces],
    ];
    for (const [kind, list] of areas) {
      const parts = list.filter((a) => a.id === key);
      if (!parts.length) continue;
      const m2 = parts.reduce((n, a) => n + ringArea(a.outer) - a.holes.reduce((h, r) => h + ringArea(r), 0), 0);
      const size = m2 > 1e4 ? `${(m2 / 1e4).toFixed(1)} ha` : `${Math.round(m2)} m²`;
      const forest = (e?.ground ?? kind) === 'green' && FOREST.test(parts[0].kind) && !e?.noTrees;
      const trees = FOREST.test(parts[0].kind) && e?.noTrees ? ' · trees deleted' : '';
      return { key, title: parts[0].name ?? nice(parts[0].kind), info: `${nice(parts[0].kind)} · ${size}${trees}`, canSize: false, canHeight: false, canModel: false, ground: e?.ground ?? kind, forest };
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
    object.name = layer;
    object.visible = this.visible.has(layer);
    this.objects.add(object);
    this.layerObjects.set(layer, [...(this.layerObjects.get(layer) ?? []), object]);
  }

  private fit() {
    this.dirty = true;
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

// Stages of a build (see building()), for a progress bar.
export const BUILD_STAGES = 3;

// Runs a staged build to the end at once (the objects follow from the worker).
function drain(stages: Generator<string | Promise<void>>) {
  while (!stages.next().done);
}

// The point of a closed ring (its last point repeats the first) nearest to p.
function nearestOnRing(p: [number, number], ring: [number, number][]): [number, number] {
  let best: [number, number] = ring[0];
  let bestD = Infinity;
  for (let i = 1; i < ring.length; i++) {
    const [ax, az] = ring[i - 1];
    const [bx, bz] = ring[i];
    const [vx, vz] = [bx - ax, bz - az];
    const len = vx * vx + vz * vz;
    const f = len ? Math.min(1, Math.max(0, ((p[0] - ax) * vx + (p[1] - az) * vz) / len)) : 0;
    const q: [number, number] = [ax + f * vx, az + f * vz];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < bestD) [best, bestD] = [q, d];
  }
  return best;
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
