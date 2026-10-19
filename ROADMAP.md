# Roadmap

Open work only: built items move to the README and CHANGELOG.

## Milestone 3: 3D viewer

- Three.js scene: terrain mesh, extruded buildings sitting on it, flat or raised roads and water.
- Toggle each category layer on and off.
- Sliders: vertical exaggeration, model scale.

## Milestone 4: object editing

- Each OSM building is its own object: click to select (outline), then delete, scale up or reset.
- Scale from the base so enlarged monuments stay on the ground.
- Later: swap a landmark for a detailed CC-licensed model (Sketchfab, etc.).

## Milestone 5: export

- Physical size in mm, base thickness, minimum feature size so nothing prints too thin.
- Merge into a watertight solid with `manifold-3d` (WASM).
- STL (single solid) and 3MF (one part per category, for multi-color printing).
- Embed the "© OpenStreetMap contributors" credit.

## Later

- Free-shape selection: click points on the map to build a polygon; double-click closes it
  back to the first point. Same edit handles (move, scale, rotate) afterwards.
- Download ETA: time Overpass on selections of different sizes and densities, fit how long
  a request takes per km² (and per building density), and show an estimated time left
  instead of only the elapsed seconds.
- Sea when the selection is entirely water, or the coast is broken near it (today: land).
- Copernicus GLO-30 terrain where the AWS tiles are coarse.
- Clip the base map's buildings to the selection while previewing, instead of hiding all.

- Overture Maps buildings to fill gaps in OSM heights.
- Segmentation for mesh sources (photogrammetry) where objects aren't already separate.
- Deploy as a public site.
