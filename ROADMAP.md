# Roadmap

Open work only: built items move to the README and CHANGELOG.

## Milestone 0.7.x: real terrain, real objects, and the look

LiDAR terrain, official 3D data and photogrammetry, aerial imagery, and the rest of the
look, released as 0.7.x steps.

### Improve objects and terrain

Swapping the OSM approximation for something better. Google's photorealistic tiles can't be
used (their terms forbid extracting them), and no open worldwide photogrammetry exists, so:

- **Better terrain where it exists:** national LiDAR terrain models (about 1 m), country by
  country where the service lets a browser load it: Norway first (høydedata, nationwide),
  then the Netherlands (AHN), Denmark, Switzerland (swissALTI3D), England and the US (3DEP).
  Sampled to what the print can hold: at 150 mm for 2 km, 2–5 m already shows every ridge a
  nozzle can make. Everywhere else falls back to today's tiles (about 10–30 m), and the
  panel says which source the terrain (and so the print) uses. Not Copernicus GLO-30: it's
  a surface model, with buildings and tree canopy in its heights, so the ground would bump
  up under every city block. FABDEM (GLO-30 cleaned of them) is non-commercial only, and
  served as archives a browser can't read.
- **Improve with official 3D data:** an "Improve" button on a building (and "Improve all"
  for the selection) that swaps the OSM block for the official open 3D city model where one
  exists: measured roof shapes and heights (LoD2), from the Netherlands' 3DBAG, Switzerland's
  swissBUILDINGS3D, Japan's PLATEAU (about 200 cities), German states (North
  Rhine-Westphalia, Bavaria, Berlin, Hamburg…), New York, Helsinki, Vienna, Zurich; and
  open photogrammetry meshes where a city publishes one (Helsinki). They carry real
  coordinates, so they go exactly in place, no fitting. Two readers cover most of them: 3D
  Tiles (walked down to the tiles over the building) and CityJSON. Per source: find the
  endpoint a browser can load (CORS), and the license; the panel shows the source and the
  export credits it. Where nothing covers the building, the button says so. (Google's
  Photorealistic 3D Tiles stay out: their terms forbid extracting, storing, offline use
  and deriving models.)
- **Sketchfab without a token:** an approved integration (Sketchfab requires it for
  downloads without each user logging in), with our own server: see "Faster, more reliable
  data". Until then, a "Log in with Sketchfab" button instead of pasting a token needs our
  app registered with them.
- **Better name matching:** a landmark with no Wikidata tag is searched by its local name
  alone, which can match a namesake elsewhere ("Cattedrale di Santa Maria Assunta" in Atri
  for Pisa's): add the town's name, from reverse geocoding.
- **Photogrammetry from tourist photos** (research): reconstruct famous landmarks from
  hundreds of openly licensed photos (Wikimedia Commons) with COLMAP-style structure from
  motion. Real geometry, but heavy server compute: needs a backend.

### Closer to the Google Earth look

Compared on Store Ådnøy (Norway), the gap is mostly terrain detail (LiDAR, above), then
surface texture, color and water:

- **Slope-based color and shading** (cheap, big gain): rock gray on steep ground, green on
  gentle ground, darker hollows; hillshade or ambient occlusion and a lower sun. Rock and
  vegetation could also be their own 3MF parts.
- **Forest as texture:** a slightly raised, rough canopy layer, or scattered trees, inside
  OSM's wood areas (or from LiDAR: surface model minus ground model gives tree heights).
- **Shallow sea:** the terrain data has the sea floor (flattened at sea level today): a
  stepped coastal shelf printed as depth.
- **Aerial imagery on screen** (optional): Sentinel-2 cloudless mosaics (10 m) are open; the
  best national aerial photos often aren't open for commercial use. Screen only, unless
  full-color printers become a target.

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
