# Roadmap

Open work only: built items move to the README and CHANGELOG.

## Improve objects and terrain

Swapping the OSM approximation for something better. Google's photorealistic tiles can't be
used (their terms forbid extracting them), and no open worldwide photogrammetry exists, so:

- **Better terrain where it exists:** national LiDAR terrain models (about 1 m: Norway's
  høydedata, the Netherlands' AHN, Switzerland's swissALTI3D, Denmark, much of Spain and the
  US), country by country where the service lets a browser load it. Not Copernicus GLO-30:
  it's a surface model, with buildings and tree canopy in its heights, so the ground would
  bump up under every city block. FABDEM (GLO-30 cleaned of them) is non-commercial only,
  and served as archives a browser can't read.
- **More models:** Sketchfab's downloadable CC models (needs the user's login), next to
  Wikimedia Commons.
- **Photogrammetry from tourist photos** (research): reconstruct famous landmarks from
  hundreds of openly licensed photos (Wikimedia Commons) with COLMAP-style structure from
  motion. Real geometry, but heavy server compute: needs a backend.

## Faster, more reliable data

Overpass is the most complete OSM source but the slowest part of the app (40–100 s for a
city center, and the public servers are often busy).

- Overture Maps buildings to fill gaps in OSM heights (cloud GeoParquet, no API).
- Our own Overpass instance (or a commercial extract service) before going public.

## Later

- Keep building edits across reloads (today they last until a new area is fetched).
- Sea when the selection is entirely water, or the coast is broken near it (today: land).
- Clip the base map's buildings to the selection while previewing, instead of hiding all.
- Segmentation for mesh sources (photogrammetry) where objects aren't already separate.
- Deploy as a public site.
