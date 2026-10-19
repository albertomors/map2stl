// Drawing a selection shape by dragging on the map, then editing it with handles:
// center = move, corner = scale (keeps the ratio), top = rotate in place.
// A plain click outside the shape clears it.

import { Marker, type GeoJSONSource, type Map, type MapMouseEvent, type MapTouchEvent } from 'maplibre-gl';
import { bearingTo, destination, distance, type LngLat } from './geo';
import {
  contains,
  fromDrag,
  rotateHandle,
  scaleHandle,
  toGeoJSON,
  type Selection,
  type ShapeKind,
} from './selection';

const SOURCE = 'selection';
// Drags shorter than this are clicks, not shapes.
const MIN_DRAG_PX = 5;
const MIN_HALF_SIZE_M = 20;

type Handle = 'move' | 'scale' | 'rotate';

export class DrawController {
  private tool: ShapeKind | null = null;
  private start: { lngLat: LngLat; x: number; y: number } | null = null;
  private current: Selection | null = null;
  private dragging: Handle | null = null;
  private handles: Record<Handle, Marker>;

  constructor(
    private map: Map,
    private onToolChange: (tool: ShapeKind | null) => void,
    private onSelection: (sel: Selection | null, final: boolean) => void,
  ) {
    map.addSource(SOURCE, { type: 'geojson', data: emptyCollection() });
    map.addLayer({
      id: 'selection-fill',
      type: 'fill',
      source: SOURCE,
      paint: { 'fill-color': '#ff6b2c', 'fill-opacity': 0.15 },
    });
    map.addLayer({
      id: 'selection-line',
      type: 'line',
      source: SOURCE,
      paint: { 'line-color': '#ff6b2c', 'line-width': 2.5 },
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
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.setTool(null);
    });
  }

  setTool(tool: ShapeKind | null) {
    this.tool = tool;
    this.start = null;
    this.map.getCanvasContainer().style.cursor = tool ? 'crosshair' : '';
    if (tool) this.map.dragPan.disable();
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

  clear() {
    this.show(null);
    this.onSelection(null, true);
  }

  // Drawing

  private down(e: MapMouseEvent | MapTouchEvent) {
    if (!this.tool) return;
    if ('points' in e && e.points.length !== 1) return;
    // Right button and Ctrl+drag belong to the orbit control.
    if (e.originalEvent instanceof MouseEvent && (e.originalEvent.button !== 0 || e.originalEvent.ctrlKey)) return;
    e.preventDefault();
    this.start = { lngLat: [e.lngLat.lng, e.lngLat.lat], x: e.point.x, y: e.point.y };
  }

  private move(e: MapMouseEvent | MapTouchEvent) {
    if (!this.tool || !this.start) return;
    const sel = fromDrag(this.tool, this.start.lngLat, [e.lngLat.lng, e.lngLat.lat], this.map.getBearing());
    this.show(sel);
    this.onSelection(sel, false);
  }

  private up(e: MapMouseEvent | MapTouchEvent) {
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
    if (this.tool || !this.current) return;
    // Clicks on the handles bubble up too; only the bare map counts.
    if (e.originalEvent.target !== this.map.getCanvas()) return;
    if (!contains(this.current, [e.lngLat.lng, e.lngLat.lat])) this.clear();
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
