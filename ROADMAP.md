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

- Sea: OSM draws coastlines as open lines, so harbors and fjords don't come back as water
  areas yet. Build sea polygons from `natural=coastline`, or use the osmdata.openstreetmap.de
  water polygons.
- Copernicus GLO-30 terrain where the AWS tiles are coarse.
- Clip the base map's buildings to the selection while previewing, instead of hiding all.

- Overture Maps buildings to fill gaps in OSM heights.
- Segmentation for mesh sources (photogrammetry) where objects aren't already separate.
- Deploy as a public site.
