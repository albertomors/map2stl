# Roadmap

Open work only: built items move to the README and CHANGELOG.

## Milestone 4: object editing

- Each OSM building is its own object: click to select (outline), then delete, scale up or reset.
- Scale from the base so enlarged monuments stay on the ground.
- Later: swap a landmark for a detailed CC-licensed model (Sketchfab, etc.).

## Milestone 5: export

- Physical size in mm, base thickness, minimum feature size so nothing prints too thin.
- Roofs that follow concave footprints exactly (straight skeleton); today gabled and hipped
  roofs are exact only for rectangular footprints.
- Merge into a watertight solid with `manifold-3d` (WASM).
- STL (single solid) and 3MF (one part per category, for multi-color printing).
- Embed the "© OpenStreetMap contributors" credit.

## Faster, more reliable data

Overpass is the most complete OSM source but the slowest part of the app (40–100 s for a
city center, and the public servers are often busy).

- Add the `overpass.kumi.systems` mirror.
- Overture Maps buildings to fill gaps in OSM heights (cloud GeoParquet, no API).
- Our own Overpass instance (or a commercial extract service) before going public.
- National LiDAR terrain where available (e.g. Norway's høydedata, 1 m), Copernicus GLO-30
  elsewhere when the AWS tiles are coarse.

## Later

- Sea when the selection is entirely water, or the coast is broken near it (today: land).
- Clip the base map's buildings to the selection while previewing, instead of hiding all.
- Segmentation for mesh sources (photogrammetry) where objects aren't already separate.
- Deploy as a public site.
