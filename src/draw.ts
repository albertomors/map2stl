// Drawing a selection shape by dragging on the map (or clicking points, for a free shape),
// then editing it with handles: center = move, corner = resize (rectangles and free shapes
// stretch freely; hexagons and circles keep their ratio), top = rotate in place. A plain click outside the shape clears it.

import { Marker, type GeoJSONSource, type Map, type MapMouseEvent, type MapTouchEvent } from 'maplibre-gl';
import { bearingTo, crossesPath, destination, distance, type LngLat } from './geo';
import {
  contains,
  fromDrag,
  fromPoints,
  rotateHandle,
  scaleHandle,
  toFrame,
  toGeoJSON,
  type Selection,
  type ShapeKind,
} from './selection';

const SOURCE = 'selection';
// Drags shorter than this are clicks, not shapes.
const MIN_DRAG_PX = 5;
const MIN_HALF_SIZE_M = 20;
// Clicking this close to the first point closes a free shape.
const CLOSE_PX = 10;
const INVALID = '#d93025';
// A press and release this close together is a click, even if the hand wobbled.
// (MapLibre's own click allows 3 px, and the rest pans the map: points went missing.)
const CLICK_TOLERANCE_PX = 8;
// The two clicks of a double-click arrive within this time: the second adds no point.
const DOUBLE_CLICK_MS = 400;

type Handle = 'move' | 'scale' | 'rotate';

export class DrawController {
  private tool: ShapeKind | null = null;
  private start: { lngLat: LngLat; x: number; y: number } | null = null;
  private current: Selection | null = null;
  private dragging: Handle | null = null;
  // Free shape being drawn: the points clicked so far, where the last press started, and
  // when the last point was added.
  private points: LngLat[] = [];
  private press: { lngLat: LngLat; x: number; y: number } | null = null;
  private lastPointAt = 0;
  // The click that closes a free shape also reaches the map's click handler, as a click on
  // the outline, which reads as "outside": it must not clear the new shape.
  private finishedAt = 0;
  private handles: Record<Handle, Marker>;

  constructor(
    private map: Map,
    private onToolChange: (tool: ShapeKind | null) => void,
    private onSelection: (sel: Selection | null, final: boolean) => void,
    // A message for the user while drawing (null puts the tool's usual hint back).
    private onMessage: (message: string | null) => void,
  ) {
    map.addSource(SOURCE, { type: 'geojson', data: emptyCollection() });
    map.addLayer({
      id: 'selection-fill',
      type: 'fill',
      source: SOURCE,
      filter: ['==', ['geometry-type'], 'Polygon'],
      // A free shape whose edges would cross shows red.
      paint: { 'fill-color': ['case', ['boolean', ['get', 'invalid'], false], INVALID, '#ff6b2c'], 'fill-opacity': 0.15 },
    });
    map.addLayer({
      id: 'selection-line',
      type: 'line',
      source: SOURCE,
      paint: { 'line-color': ['case', ['boolean', ['get', 'invalid'], false], INVALID, '#ff6b2c'], 'line-width': 2.5 },
    });
    // Clicked points while drawing a free shape.
    map.addLayer({
      id: 'selection-points',
      type: 'circle',
      source: SOURCE,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 4, 'circle-color': '#ffffff', 'circle-stroke-color': '#ff6b2c', 'circle-stroke-width': 2 },
    });

    this.handles = {
      move: this.makeHandle('move', 'Drag to move', '✥'),
      scale: this.makeHandle('scale', 'Drag to resize', ''),
      rotate: this.makeHandle('rotate', 'Drag to rotate', '↻'),
    };

    map.on('mousedown', (e) => this.down(e));
    map.on('touchstart', (e) => this.down(e));
    map.on('mousemove', (e) => this.move(e));
    map.on('touchmove', (e) => this.move(e));
    map.on('mouseup', (e) => this.up(e));
    map.on('touchend', (e) => this.up(e));
    map.on('click', (e) => this.click(e));
    map.on('dblclick', (e) => {
      if (this.tool !== 'polygon') return;
      // Not a zoom: it finishes the shape.
      e.preventDefault();
      this.finishPolygon();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.setTool(null);
    });
  }

  get activeTool(): ShapeKind | null {
    return this.tool;
  }

  setTool(tool: ShapeKind | null) {
    // Leaving a half-drawn free shape puts back what was there before.
    if (this.points.length) {
      this.points = [];
      this.show(this.current);
    }
    this.tool = tool;
    this.start = null;
    this.map.getCanvasContainer().style.cursor = tool ? 'crosshair' : '';
    // Free shapes are clicked, not dragged: the map can still pan between clicks.
    if (tool && tool !== 'polygon') this.map.dragPan.disable();
    else this.map.dragPan.enable();
    this.showHandles();
    this.onToolChange(tool);
  }

  show(sel: Selection | null) {
    this.current = sel;
    const source = this.map.getSource(SOURCE) as GeoJSONSource;
    source.setData(sel ? { type: 'FeatureCollection', features: [toGeoJSON(sel)] } : emptyCollection());
    this.showHandles();
  }

  // A selection made elsewhere (around a search result): shown and reported like a drawn one.
  select(sel: Selection) {
    this.setTool(null);
    this.show(sel);
    this.onSelection(sel, true);
  }

  clear() {
    this.show(null);
    this.onSelection(null, true);
  }

  // Drawing

  private down(e: MapMouseEvent | MapTouchEvent) {
    if (this.tool === 'polygon') {
      const mouse = e.originalEvent instanceof MouseEvent ? e.originalEvent : null;
      // Right button and Ctrl+drag belong to the orbit control.
      if (mouse && (mouse.button !== 0 || mouse.ctrlKey)) return;
      this.press = { lngLat: [e.lngLat.lng, e.lngLat.lat], x: e.point.x, y: e.point.y };
      return;
    }
    if (!this.tool) return;
    if ('points' in e && e.points.length !== 1) return;
    // Right button and Ctrl+drag belong to the orbit control.
    if (e.originalEvent instanceof MouseEvent && (e.originalEvent.button !== 0 || e.originalEvent.ctrlKey)) return;
    e.preventDefault();
    this.start = { lngLat: [e.lngLat.lng, e.lngLat.lat], x: e.point.x, y: e.point.y };
  }

  private move(e: MapMouseEvent | MapTouchEvent) {
    if (this.tool === 'polygon' && this.points.length) {
      this.showDraft([e.lngLat.lng, e.lngLat.lat]);
      return;
    }
    if (!this.tool || !this.start) return;
    const sel = fromDrag(this.tool, this.start.lngLat, [e.lngLat.lng, e.lngLat.lat], this.map.getBearing());
    this.show(sel);
    this.onSelection(sel, false);
  }

  private up(e: MapMouseEvent | MapTouchEvent) {
    if (this.tool === 'polygon') {
      const press = this.press;
      this.press = null;
      if (press && Math.hypot(e.point.x - press.x, e.point.y - press.y) <= CLICK_TOLERANCE_PX) this.addPoint(press);
      return;
    }
    if (!this.tool || !this.start) return;
    const dragged = Math.hypot(e.point.x - this.start.x, e.point.y - this.start.y) >= MIN_DRAG_PX;
    if (dragged && this.current) {
      this.onSelection(this.current, true);
      this.setTool(null);
    } else {
      // A click leaves no real shape: keep the tool armed.
      this.start = null;
    }
  }

  private click(e: MapMouseEvent) {
    if (this.tool || !this.current || performance.now() - this.finishedAt < DOUBLE_CLICK_MS) return;
    // Clicks on the handles bubble up too; only the bare map counts.
    if (e.originalEvent.target !== this.map.getCanvas()) return;
    if (!contains(this.current, [e.lngLat.lng, e.lngLat.lat])) this.clear();
  }

  // Free shape

  // At the press position: that's where the user aimed, even if the map then panned a little.
  private addPoint(press: { lngLat: LngLat; x: number; y: number }) {
    const p = press.lngLat;
    const px = (q: LngLat) => this.map.project(q);
    const near = (q: LngLat) => Math.hypot(px(q).x - px(p).x, px(q).y - px(p).y) < CLOSE_PX;
    if (this.points.length >= 3 && near(this.points[0])) return this.finishPolygon();
    // Edges that cross make a shape with no clear inside: refuse the point.
    const last = this.points[this.points.length - 1];
    if (last && crossesPath(last, p, this.points)) {
      this.onMessage('That edge would cross another one. Click somewhere else.');
      return;
    }
    // A double-click sends two clicks first: don't add the same point twice.
    const now = performance.now();
    if (this.points.length && now - this.lastPointAt < DOUBLE_CLICK_MS && near(this.points[this.points.length - 1])) return;
    this.lastPointAt = now;
    this.onMessage(null);
    this.points.push(p);
    this.showDraft(p);
  }

  private finishPolygon() {
    const pts = this.points;
    if (pts.length >= 3 && crossesPath(pts[pts.length - 1], pts[0], pts)) {
      this.onMessage('Closing here would cross an edge. Add a point that keeps the outline from crossing.');
      return;
    }
    this.points = [];
    this.onMessage(null);
    this.finishedAt = performance.now();
    if (pts.length < 3) return this.show(this.current);
    const sel = fromPoints(pts, this.map.getBearing());
    this.show(sel);
    this.onSelection(sel, true);
    this.setTool(null);
  }

  // The shape so far, filled, including the edges to the cursor and back to the start;
  // red when those edges would cross the outline.
  private showDraft(cursor: LngLat) {
    const source = this.map.getSource(SOURCE) as GeoJSONSource;
    const pts = this.points;
    const last = pts[pts.length - 1];
    const invalid = pts.length >= 2 && (crossesPath(last, cursor, pts) || crossesPath(cursor, pts[0], pts.slice(1)));
    // A crossed outline has no inside to fill: just the red line then.
    const shape: GeoJSON.Geometry =
      pts.length < 2
        ? { type: 'LineString', coordinates: [...pts, cursor] }
        : invalid
          ? { type: 'LineString', coordinates: [...pts, cursor, pts[0]] }
          : { type: 'Polygon', coordinates: [[...pts, cursor, pts[0]]] };
    source.setData({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { invalid }, geometry: shape },
        ...pts.map((p): GeoJSON.Feature => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } })),
      ],
    });
  }

  // Edit handles

  private makeHandle(kind: Handle, title: string, symbol: string): Marker {
    const el = document.createElement('div');
    el.className = `handle handle-${kind}`;
    el.title = title;
    el.textContent = symbol;
    const marker = new Marker({ element: el, draggable: true });

    let startSel: Selection | null = null;
    let startCursor: LngLat = [0, 0];
    let startDist = 0;

    marker.on('dragstart', () => {
      if (!this.current) return;
      this.dragging = kind;
      startSel = this.current;
      startCursor = toLngLat(marker);
      startDist = distance(startSel.center, scaleHandle(startSel));
    });
    marker.on('drag', () => {
      if (!startSel) return;
      const cursor = toLngLat(marker);
      let sel: Selection;
      if (kind === 'move') {
        const center = destination(startSel.center, distance(startCursor, cursor), bearingTo(startCursor, cursor));
        sel = { ...startSel, center };
      } else if (kind === 'scale' && (startSel.kind === 'rectangle' || startSel.kind === 'polygon')) {
        // The corner follows the cursor on both axes; the center stays put.
        const { x, y } = toFrame(startSel.center, startSel.rotation, cursor);
        sel = { ...startSel, halfWidth: Math.max(Math.abs(x), MIN_HALF_SIZE_M), halfHeight: Math.max(Math.abs(y), MIN_HALF_SIZE_M) };
      } else if (kind === 'scale') {
        const k = Math.max(
          distance(startSel.center, cursor) / startDist,
          MIN_HALF_SIZE_M / Math.min(startSel.halfWidth, startSel.halfHeight),
        );
        sel = { ...startSel, halfWidth: startSel.halfWidth * k, halfHeight: startSel.halfHeight * k };
      } else {
        sel = { ...startSel, rotation: bearingTo(startSel.center, cursor) };
      }
      this.show(sel);
      this.onSelection(sel, false);
    });
    marker.on('dragend', () => {
      startSel = null;
      this.dragging = null;
      // Snap the dragged handle back onto the shape.
      this.showHandles();
      this.onSelection(this.current, true);
    });
    return marker;
  }

  private showHandles() {
    const sel = this.current;
    for (const [kind, marker] of Object.entries(this.handles) as [Handle, Marker][]) {
      if (!sel || this.tool) {
        marker.remove();
      } else if (kind !== this.dragging) {
        // The handle being dragged stays under the pointer.
        const at = kind === 'move' ? sel.center : kind === 'scale' ? scaleHandle(sel) : rotateHandle(sel);
        marker.setLngLat(at).addTo(this.map);
      }
    }
  }
}

function toLngLat(marker: Marker): LngLat {
  const p = marker.getLngLat();
  return [p.lng, p.lat];
}

function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}
