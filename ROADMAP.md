# Roadmap

Open work only: built items move to the README and CHANGELOG.

## Milestone 2: fetch the 3D data

- Download OSM data for the selection with the Overpass API, clipped to the shape.
- Sort it into categories: buildings (footprint + `height` / `building:levels`, `building:part`),
  roads, railways, water, green areas, trees.
- Terrain elevation from AWS Terrain Tiles (Terrarium PNG, free, no key); Copernicus GLO-30 later.
- Show a count per category, cache responses, and handle Overpass rate limits.

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

- Overture Maps buildings to fill gaps in OSM heights.
- Segmentation for mesh sources (photogrammetry) where objects aren't already separate.
- Deploy as a public site.
