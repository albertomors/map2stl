# Roadmap

Open work only: built items move to the README and CHANGELOG.

## Milestone 0.7.x: real terrain, real objects, and the look

LiDAR terrain, official 3D data and photogrammetry, and the rest of the look, released as
0.7.x steps.

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

- **Rock and vegetation as 3MF parts:** the relief shading's rock (steep ground) printed in
  its own filament.
- **Forest heights from LiDAR:** the surface model minus the ground model gives each
  forest's real canopy height, instead of placed trees.
- **Sea depths beyond Europe:** EMODnet covers European seas; GEBCO (worldwide, about
  450 m) or national charts elsewhere.

## Export for other 3D software

Besides STL and 3MF for printing, the model to reuse elsewhere (Blender, Unity, Unreal,
Sketchfab, Cesium, the web), exported from the 3D view's scene as it looks on screen:
smooth terrain, colors, trees; not the print geometry (base, thickened details).

- **GLB** (binary glTF): the main one. One file with geometry, materials and textures,
  read by almost every 3D tool (three.js's `GLTFExporter`).
- **OBJ + MTL** (optional): for older tools; plain geometry and material colors.
- **USDZ** (optional): view in AR on an iPhone or iPad (three.js's `USDZExporter`).
- Not FBX (closed format, no browser exporter; the tools that use it import glTF) or
  COLLADA (superseded by glTF).

## Bug reports with the full context

A "?" button, always visible, opening a "Found a bug? Report it" window: a free-text box
for the user to describe the bug in words, and a Send button. Everything needed to
reproduce the same conditions is gathered automatically:

- **The selection:** shape kind and its original coordinates (center, sizes, rotation, or
  the polygon's points).
- **The view the user is in:** map, 3D view or export preview, and for each what matters
  there: the map's center and zoom; the camera, the layers on and off, the height
  multipliers, the edits (deleted, restored, moved, landmark models);
  the export settings (longest side, base, thinnest detail, nozzle, format) and the
  preview's status line.
- **The scene:** the data summary (counts per layer, terrain range and source, sea depths),
  the data sources and their versions, the selected object if any.
- **The app:** version, browser, screen, WebGL renderer, and recent errors from the
  console.

Send packs the message and the context (JSON, plus a screenshot of the view) into a zip
for the maintainer's email. A browser can't send an email with an attachment by itself
(mailto can't attach files), so it needs either a small server endpoint (or a form/email
service) that receives the zip and forwards it, or, until then, a fallback: download the
zip and open a mailto with the message, for the user to attach it.

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
