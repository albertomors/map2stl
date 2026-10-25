# Roadmap

Open work only: built items move to the README and CHANGELOG.

## Milestone 0.7.x: real terrain, real objects, and the look

LiDAR terrain, official 3D data, and the rest of the look. What's left of it:

### Improve objects and terrain

Swapping the OSM approximation for something better. Google's photorealistic tiles can't be
used (their terms forbid extracting them), and no open worldwide photogrammetry exists, so:

- **Better terrain in more countries:** national LiDAR terrain models (about 1 m), country by
  country where the service lets a browser load it. Done: Norway, the Netherlands, England,
  the US. Left: Switzerland (swissALTI3D: only per-kilometer files in the Swiss grid, no
  service cutting out an area), Denmark (needs an access token), and others as found.
  Sampled to what the print can hold: at 150 mm for 2 km, 2–5 m already shows every ridge a
  nozzle can make. Everywhere else falls back to today's tiles (about 10–30 m), and the
  panel says which source the terrain (and so the print) uses. Not Copernicus GLO-30: it's
  a surface model, with buildings and tree canopy in its heights, so the ground would bump
  up under every city block. FABDEM (GLO-30 cleaned of them) is non-commercial only, and
  served as archives a browser can't read.
- **More official 3D buildings:** Switzerland (swissBUILDINGS3D) is done. Next the
  Netherlands' 3DBAG (its servers didn't answer when this was built), Japan's PLATEAU,
  German states, New York, Helsinki, Vienna, Zurich's city model; where a source isn't 3D
  Tiles, a CityJSON reader. Per source: an endpoint a browser can load, and the license.

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

## Publishing

What going public needs.

- Our own Overpass instance (or a commercial extract service): the public servers are too
  busy and slow for many users.
- **Sketchfab without a token:** an approved integration (Sketchfab requires it for
  downloads without each user logging in), with our own server. Until then, a "Log in
  with Sketchfab" button instead of pasting a token needs our app registered with them.
- Deploy as a public site.

## Later

- Keep building edits across reloads (today they last until a new area is fetched).
- Sea when the selection is entirely water, or the coast is broken near it (today: land).
- Clip the base map's buildings to the selection while previewing, instead of hiding all.
- Segmentation for mesh sources (photogrammetry) where objects aren't already separate.
- **Photogrammetry from tourist photos** (research): reconstruct famous landmarks from
  hundreds of openly licensed photos (Wikimedia Commons) with COLMAP-style structure from
  motion. Real geometry, but heavy server compute: needs a backend.
