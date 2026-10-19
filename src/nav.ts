// Map navigation: smooth orbit around the point under the cursor, plus an on-screen
// control (zoom, draggable compass, 2D/3D toggle). Replaces MapLibre's right-drag rotate,
// which spins around the screen center and is very sensitive.

import type { LngLat, Map, PointLike } from 'maplibre-gl';

const BEARING_PER_PX = 0.3;
const PITCH_PER_PX = 0.25;
const MAX_PITCH = 80;
const PITCH_3D = 60;
// Fraction of the remaining distance covered each frame: lower is smoother but laggier.
const SMOOTHING = 0.3;

export function setupNavigation(map: Map) {
  map.dragRotate.disable();
  map.setMaxPitch(MAX_PITCH);
  setupOrbit(map);
  map.addControl({ onAdd: () => buildControl(map), onRemove: () => {} }, 'bottom-right');
}

// Right-drag or Ctrl+drag orbits: left/right turns, up/down tilts.
// The point clicked stays put on screen, so you circle around what you're looking at.
function setupOrbit(map: Map) {
  const canvas = map.getCanvasContainer();
  let dragging = false;
  let last = { x: 0, y: 0 };
  let anchor = { x: 0, y: 0 };
  let pivot: LngLat | null = null;
  let target = { bearing: 0, pitch: 0 };
  let frame = 0;

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    if (!(e.button === 2 || (e.button === 0 && e.ctrlKey))) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    last = { x: e.clientX, y: e.clientY };
    pivot = map.unproject([anchor.x, anchor.y]);
    target = { bearing: map.getBearing(), pitch: map.getPitch() };
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    target.bearing += (e.clientX - last.x) * BEARING_PER_PX;
    target.pitch = clamp(target.pitch - (e.clientY - last.y) * PITCH_PER_PX, 0, MAX_PITCH);
    last = { x: e.clientX, y: e.clientY };
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
    const bearing = map.getBearing();
    const pitch = map.getPitch();
    const dBearing = target.bearing - bearing;
    const dPitch = target.pitch - pitch;
    const done = Math.abs(dBearing) < 0.05 && Math.abs(dPitch) < 0.05;
    map.jumpTo({
      bearing: done ? target.bearing : bearing + dBearing * SMOOTHING,
      pitch: done ? target.pitch : pitch + dPitch * SMOOTHING,
    });
    if (pivot) keepOnScreen(map, pivot, anchor);
    frame = done ? 0 : requestAnimationFrame(step);
  }
}

// Shift the map so `point` is drawn at screen position `at` again.
function keepOnScreen(map: Map, point: LngLat, at: { x: number; y: number }) {
  const now = map.project(point);
  const center = map.project(map.getCenter());
  const shifted: PointLike = [center.x + now.x - at.x, center.y + now.y - at.y];
  map.jumpTo({ center: map.unproject(shifted) });
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
