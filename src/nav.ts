// Map navigation: orbit that keeps the grabbed point under the cursor, plus an on-screen
// control (zoom, draggable compass, 2D/3D toggle). Replaces MapLibre's right-drag rotate,
// which spins around the screen center and is very sensitive.

import { MercatorCoordinate, type LngLat, type Map } from 'maplibre-gl';
import { distance } from './geo';

const BEARING_PER_PX = 0.3;
const PITCH_PER_PX = 0.25;
const MAX_PITCH = 80;
const PITCH_3D = 60;
// A grabbed point farther from the view center than this many times the center-to-bottom-edge
// distance (near the horizon, or sky) can't be held: drag turns and tilts by distance instead.
const MAX_GRAB_REACH = 2;

export function setupNavigation(map: Map) {
  map.dragRotate.disable();
  map.setMaxPitch(MAX_PITCH);
  setupOrbit(map);
  map.addControl({ onAdd: () => buildControl(map), onRemove: () => {} }, 'bottom-right');
}

// Right-drag or Ctrl+drag: horizontal movement turns, vertical tilts, and the map slides so the
// grabbed point follows the cursor, like holding the map in your hand: on release it is still
// under the cursor. Far-away points and the sky can't be held, so those drags just turn and
// tilt around the view center.
function setupOrbit(map: Map) {
  const canvas = map.getCanvasContainer();
  let dragging = false;
  let start = { x: 0, y: 0, bearing: 0, pitch: 0 };
  let cursor = { x: 0, y: 0 };
  let grab: LngLat | null = null;
  let frame = 0;

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  const local = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (!(e.button === 2 || (e.button === 0 && e.ctrlKey))) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    cursor = local(e);
    start = { ...cursor, bearing: map.getBearing(), pitch: map.getPitch() };
    grab = pickGrab(map, cursor);
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    cursor = local(e);
    if (!frame) frame = requestAnimationFrame(step);
  });

  const stop = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = '';
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  function step() {
    frame = 0;
    map.jumpTo({
      bearing: start.bearing + (cursor.x - start.x) * BEARING_PER_PX,
      pitch: clamp(start.pitch - (cursor.y - start.y) * PITCH_PER_PX, 0, MAX_PITCH),
    });
    if (grab) holdUnderCursor(map, grab, cursor);
  }
}

// The ground point under `at`, or null when it's too far away (or sky) to hold on to.
function pickGrab(map: Map, at: { x: number; y: number }): LngLat | null {
  const canvas = map.getCanvas();
  const center = map.getCenter();
  const point = map.unproject([at.x, at.y]);
  const bottom = map.unproject([canvas.clientWidth / 2, canvas.clientHeight]);
  const reach = MAX_GRAB_REACH * distance(center.toArray(), bottom.toArray());
  return distance(center.toArray(), point.toArray()) > reach ? null : point;
}

// Slide the map so `point` is drawn at screen position `at`. Moving the center slides the
// camera rigidly over the ground, so the fix is the ground offset between `point` and whatever
// is under `at` now, done in Mercator where that slide is linear (a screen-space step overshoots
// under perspective and diverges at steep tilt).
function holdUnderCursor(map: Map, point: LngLat, at: { x: number; y: number }) {
  const want = MercatorCoordinate.fromLngLat(point);
  const got = MercatorCoordinate.fromLngLat(map.unproject([at.x, at.y]));
  const c = MercatorCoordinate.fromLngLat(map.getCenter());
  map.jumpTo({ center: new MercatorCoordinate(c.x + want.x - got.x, c.y + want.y - got.y).toLngLat() });
}

function buildControl(map: Map): HTMLElement {
  const root = document.createElement('div');
  root.className = 'maplibregl-ctrl nav-control';
  root.innerHTML = `
    <button class="zoom-in" title="Zoom in">+</button>
    <button class="zoom-out" title="Zoom out">−</button>
    <button class="compass" title="Drag to rotate, click to face north">
      <svg viewBox="0 0 24 24"><path class="north" d="M12 3 15.5 12h-7Z"/><path class="south" d="M12 21 8.5 12h7Z"/></svg>
    </button>
    <button class="view3d" title="Toggle 3D view">3D</button>`;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;

  q('.zoom-in').addEventListener('click', () => map.zoomIn());
  q('.zoom-out').addEventListener('click', () => map.zoomOut());

  const view3d = q<HTMLButtonElement>('.view3d');
  view3d.addEventListener('click', () => map.easeTo({ pitch: map.getPitch() > 10 ? 0 : PITCH_3D, duration: 800 }));

  // Drag the compass needle around: north follows the pointer.
  const compass = q<HTMLButtonElement>('.compass');
  const needle = compass.querySelector('svg') as SVGElement;
  let start: { angle: number; bearing: number; x: number; y: number } | null = null;
  let moved = false;
  const angleOf = (e: PointerEvent) => {
    const r = compass.getBoundingClientRect();
    return (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
  };
  compass.addEventListener('pointerdown', (e) => {
    compass.setPointerCapture(e.pointerId);
    start = { angle: angleOf(e), bearing: map.getBearing(), x: e.clientX, y: e.clientY };
    moved = false;
  });
  compass.addEventListener('pointermove', (e) => {
    if (!start) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 3) moved = true;
    if (moved) map.setBearing(start.bearing - (angleOf(e) - start.angle));
  });
  compass.addEventListener('pointerup', () => {
    if (start && !moved) map.easeTo({ bearing: 0, duration: 600 });
    start = null;
  });

  const update = () => {
    needle.style.transform = `rotate(${-map.getBearing()}deg)`;
    view3d.textContent = map.getPitch() > 10 ? '2D' : '3D';
  };
  map.on('rotate', update);
  map.on('pitch', update);
  update();
  return root;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
