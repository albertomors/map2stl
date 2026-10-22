# Roadmap

Open work only: built items move to the README and CHANGELOG.

## Milestone 5: export (rest)

- A Preview button in the Export card: shows the model exactly as it will be printed, with the
  base thickness and the thinnest-detail widening applied (walls, masts, trees, bridges).
- Roads, water, parks and squares in the print: today they're only painted in the 3D view.
  Raise them slightly (or inset them) as their own 3MF parts, so multi-color prints show them.
- Roofs that follow concave footprints exactly (straight skeleton); today gabled and hipped
  roofs are exact only for rectangular footprints.
- Optionally merge everything into one watertight solid with `manifold-3d` (WASM). Today
  each object is a closed solid and slicers merge the overlaps, which works in practice.
- A print preview of the scale problem: warn when details fall below the nozzle width.

## Improve objects and terrain

An "Improve" button on the selected object (and one for the terrain) that swaps the OSM
approximation for something better. Google's photorealistic tiles can't be used (their terms
forbid extracting them), and no open worldwide photogrammetry exists, so:

- **Better terrain everywhere:** Copernicus GLO-30 / FABDEM, worldwide and open, instead of the
  AWS tiles where those are coarse.
- **Find a model:** search CC0 / CC-BY 3D models of the selected landmark by name (OSM's
  `wikidata` tag makes it precise): Wikimedia Commons first (no key), Sketchfab later (needs
  the user's login). License shown before use; CC-BY credit written into the export.
- **Upload a model:** the user's own STL / glTF / OBJ.
- Both are **scaled and placed automatically**: fitted to the OSM footprint and height,
  rotated to line up with the footprint, standing on the ground; then adjustable with the
  usual handles. Checked for printability like the rest of the export.
- **Photogrammetry from tourist photos** (research): reconstruct famous landmarks from
  hundreds of openly licensed photos (Wikimedia Commons) with COLMAP-style structure from
  motion. Real geometry, but heavy server compute: needs a backend.

## Faster, more reliable data

Overpass is the most complete OSM source but the slowest part of the app (40–100 s for a
city center, and the public servers are often busy).

- Add the `overpass.kumi.systems` mirror.
- Overture Maps buildings to fill gaps in OSM heights (cloud GeoParquet, no API).
- Our own Overpass instance (or a commercial extract service) before going public.
- National LiDAR terrain where available (e.g. Norway's høydedata, 1 m), Copernicus GLO-30
  elsewhere when the AWS tiles are coarse.

## Later

- Keep building edits across reloads (today they last until a new area is fetched).
- Sea when the selection is entirely water, or the coast is broken near it (today: land).
- Clip the base map's buildings to the selection while previewing, instead of hiding all.
- Segmentation for mesh sources (photogrammetry) where objects aren't already separate.
- Deploy as a public site.
