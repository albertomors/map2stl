# User guide

Everything map2stl does today, step by step. For a quick tour, see the
[README](../README.md).

## 1. The map

- **Pan:** drag. **Zoom:** scroll, or the **+ / −** buttons.
- **Orbit and tilt:** right-drag, or Ctrl+drag. Horizontal movement turns the map, vertical
  movement tilts it, and the point you grabbed stays under the cursor, like holding the map
  in your hand. Grabbing the sky or a point near the horizon turns around the center of
  the view instead.
- **Compass** (bottom right): drag it to rotate, click it to face north.
- **2D / 3D button:** toggles between a flat and a tilted view.
- The address bar keeps the position (`#zoom/lat/lng/bearing/pitch`), so a link opens the
  same view.

### Search

Type a town, a street, an address ("Via Roma 12, Modena") or a landmark ("Eiffel Tower",
"Colosseum") in the search box. Suggestions appear as you type, each with what it is
(town, street, address, tower, place of worship…) and where; the best-known place comes
first (a landmark mapped in many pieces or tagged for tourists, a name made only of the
words typed), then those near where the map is. **↑ / ↓** and **Enter** pick one, or click
it: the map flies there at the right scale (a landmark with a kilometer or two around it),
and a pin stays on the place. **Select area** next to a street, address or landmark also
draws a rectangle around it, with some ground around, ready to fetch. Shops, bus stops
and the like are left out.

## 2. Selecting the area

Pick a tool under **Select an area**, then:

| Shape | How to draw it |
|---|---|
| **Rectangle** | Drag from one corner to the opposite corner. |
| **Hexagon** | Drag from the center outward. The flat top faces the top of the screen. |
| **Circle** | Drag from the center outward. |
| **Free** | Click point by point (you can drag to pan between clicks). Double-click, or click the first point, to close the shape. |

- Shapes are drawn **aligned to the current view**, not to north: rotate the map first to
  get a tilted rectangle or hexagon.
- While drawing a free shape, the area fills as you go. If the next edge would cross
  another, the outline turns red and the click is refused: a crossed outline has no clear
  inside to print.
- **Esc** cancels drawing.

### Editing the shape

| Handle | What it does |
|---|---|
| Center (✥) | Moves the shape. |
| Corner (square) | Resizes it. Rectangles and free shapes stretch freely; hexagons and circles keep their ratio. |
| Top (↻) | Rotates it in place. |

Click on the map outside the shape to clear it. The selection is saved in the browser and
comes back after a reload.

The **Selection** panel shows the shape's size, area, radius (hexagon and circle), rotation
and center, and warns above 10 km²: large areas download slowly, and small details
disappear at print scale.

## 3. Fetching the 3D data

Press **Fetch 3D data**. It comes in two steps.

### Quick version (1–3 seconds)

Read from the same vector tiles the map draws (OpenMapTiles schema, zoom 14). It includes
buildings with heights and colors, roads and rails with bridges, water including the sea,
parks and landcover, piers and runways. The map preview and the 3D view work right away.

### Detailed version (usually 30–90 seconds)

From the [Overpass API](https://overpass-api.de), the full OpenStreetMap data. When it
arrives it replaces the quick version in place: layers you switched off stay off, and an
open 3D view updates without moving the camera.

The progress bar shows an **estimate of the time left**. It starts from timed downloads
(about 44 s plus 1.9 s per 1,000 buildings) and learns from your own downloads. Public
servers are often busy, so expect ±10 s. If a server is busy or silent for 100 s, the next
mirror is tried, and the estimate starts over from that try. If every server fails, the
quick version stays and the panel tells you to fetch again later. Answers are cached in the browser for a week, so fetching the same area
again is instant.

### What's in the data

| Layer | Contents |
|---|---|
| **Buildings** | Footprints, holes (courtyards), height, roof shape and height, building and roof colors. `building:part`s (a cathedral's nave, towers, spires) replace their outline. |
| **Bridges, piers, walls, towers** | Bridge decks, piers and breakwaters, walls, retaining walls and city walls, towers, chimneys, masts, lighthouses, silos. |
| **Roads & paths** | Every road and path, with a width; bridges marked. |
| **Railways & trams** | Rail, light rail, tram, subway, narrow gauge; bridges marked. |
| **Squares, parking, sports** | Pedestrian squares, car parks, pitches and running tracks, airport runways, taxiways and aprons. |
| **Water** | Lakes, rivers, streams, canals, and the sea. |
| **Green areas** | Parks, gardens, grass, meadows, forests, scrub, cemeteries… |
| **Sand, rock, glacier** | Beaches, sand, bare rock, scree, shingle, glaciers. |
| **Trees** | Single mapped trees. |
| **Terrain** | An elevation grid over the area from worldwide tiles (about 10–30 m underneath). The panel names the source and spacing. |
| **Sea floor** | Depths for areas with sea: EMODnet Bathymetry in European seas, NOAA ETOPO 2022 and its coastal models elsewhere. Shown when the Water layer is off. |

How heights are decided:

- **Buildings:** the `height` tag, else `building:levels` × 3 m (plus roof levels), else an
  estimate from the building type (1 floor for garages and sheds, 2 for houses, 3
  otherwise). The panel shows what share has real heights.
- **Structures without a height:** typical values (city wall 6 m, wall 2 m, chimney 40 m,
  tower 25 m, mast 12 m…).
- Tunnels, culverts and anything underground are skipped.
- The sea is rebuilt from the coastline: OpenStreetMap stores coasts as lines with the water
  on their right, not as areas.

## 4. The 3D view

Press **Open 3D view**. Three.js loads the first time, which takes a moment.

- The same controls as the map: **drag** pans, **right-drag** or **Ctrl+drag** orbits and
  tilts, **scroll** zooms. The camera stays above the ground and the orbit's center inside
  the selection.
- **Terrain height multiplier** (×1–5) exaggerates the terrain; **Object height
  multiplier** (×0.5–3) everything standing on it: buildings, bridges, towers, trees and
  forests. Both show the change while you drag, and rebuild the scene when you let go.
- The layer **checkboxes** work in 3D too.
- **Back to map** returns to the map.

What you see:

- **The tile:** terrain cut exactly to your shape, with side walls and a flat base, the way
  the print will be. Steep ground is shaded as rock, hollows a little darker.
- **The sea:** with the Water layer on, the sea is flat at sea level. Switch Water off and
  the sea floor appears at its real depths, the deepest point at the bottom of the model,
  in the 3D view and in the print.
- **Ground layers** (water, green areas, squares, sand, roads, rails) are painted onto the
  terrain, so they follow every slope.
- **Buildings** stand on the lowest ground under them, with roofs from OSM: gabled, hipped,
  pyramidal, dome, onion and skillion (other shapes are approximated as hipped or gabled),
  and with OSM colors when tagged.
- **Bridges** are decks sloping from one bank's height to the other's; **piers, walls and
  towers** are solid; single **trees** are cones; **forests** are one canopy of treetops
  over the whole wood, 15 m tall; a few **boats** lie moored at piers.
- **Official 3D buildings** (Switzerland, swissBUILDINGS3D): select a building and use its
  official model, or use them for every building in the area at once.
- **Everything is cut at the tile edge.** Buildings crossing it get a flat face and a flat
  roof there.

## 5. Editing objects

In the 3D view, **click a building, tree, bridge or structure** (pier, wall, tower, mast…),
or a street, railway, river or area on the ground, to select it. It turns orange, and the panel shows its name, height (and whether it's
tagged, from floors or estimated), roof and number of parts. Click empty space or press
**Esc** to deselect.

| Control | Effect | Available for |
|---|---|---|
| **Delete** (or the Delete key) | Removes it | Everything |
| **Size** ×1–4 | Enlarges it from the center of its base, all dimensions together | Buildings, trees, towers, piers |
| **Height only** ×0.5–4 | Stretches it vertically, on top of Size | Buildings, trees, towers, piers, walls |
| **Width** ×0.25–4 | Makes it wider or narrower | Streets, railways, rivers |
| **Prints as** | Water, park, square or sand | Areas on the ground |
| **Reset** | Puts this object back | Everything |

- **Restore deleted** (under the 3D controls) brings back every deleted object.
  **Reset all** clears every edit and puts both height multipliers back to their defaults.
- A building made of several parts (Nidarosdomen has 161) is selected and edited as one,
  under the name of the whole building.
- Edits are applied before the cut at the tile edge, so an enlarged landmark is still
  trimmed there. They last until you fetch a new area; the export will use them.
- **Delete** on a forest takes its trees only: the wood stays on the ground.
- Selecting waits for the detailed data: the quick version's buildings are split at tile
  seams and have no parts, and their identities change when the detailed data arrives.

### Replacing a landmark with a 3D model

Select a building or a bridge, then:

- **Find a 3D model online** searches openly licensed models of it on Wikimedia Commons
  (its Wikidata model first, then files depicting it, then its name) and Sketchfab. Each
  result shows its license, author, size and triangles; NonCommercial and ShareAlike
  licenses are highlighted. Sketchfab downloads ask once for your Sketchfab API token (a
  free account works), kept in this browser.
- **Replace with a 3D model…** takes your own file: STL, OBJ, GLB, or glTF with its data
  inside.

The model is fitted to the footprint, turned upright and set on the ground; **Turn 90°**
and **Stand up** fix a wrong guess, Size and Height still apply, and **Remove** brings the
original back. The export credits the model's author.

In Switzerland, **Use the official 3D model** swaps the building for swisstopo's measured
model (swissBUILDINGS3D); **Use official models for every building in the area** does it
for all of them at once.

## 6. Exporting

The **Export** card floats over the 3D view once the detailed data is in.

- **For printing:** set the longest side, base thickness, thinnest detail and nozzle,
  press **Preview export** to see the model exactly as it will print, then download it as
  **STL** (one watertight solid) or **3MF** (one colored part per layer, for multi-color
  printers).
- In the preview, anything narrower than the nozzle shows in **red**, with a warning that
  counts it per part: make the model bigger, or enlarge or delete those objects. Forests
  turn red when their crowns come out narrower than the nozzle.
- Streets and water are carved one step (the thinnest detail) into the ground; parks,
  squares and sand lie flush. Each is its own colored part in a 3MF.
- **For other 3D software** (Blender, Unity, Unreal, Sketchfab, a web page): **GLB** or
  **glTF** saves the 3D view as it looks, not the print: the painted ground with its
  relief shading, the buildings, structures, trees and forests of the layers that are on,
  with your edits and height multipliers. In meters, y up. GLB is one binary file; glTF is
  the same as JSON, for reading or editing by hand. No preview needed.

Credit "© OpenStreetMap contributors" (and any other source the card names) when you
share what you made.

## Reporting a bug

The **?** at the top right of the panel opens **Found a bug? Report it**. Describe what
you did, what you expected and what happened, then **Send**: a zip is saved with your
message, a screenshot, and what's needed to reproduce it (your selection, the view and its
settings, your edits, your browser and graphics card, recent errors; nothing else), and
your email app (or, in builds without a report address, a new GitHub issue) opens with the
message. Attach the zip and send.

## Known limits

- **Gabled and hipped roofs are exact only on rectangular footprints.** On L-shapes and
  other irregular outlines they're approximations.
- **Courtyard buildings** always get flat roofs.
- **Terrain detail** is about 10–30 m, even though the grid is finer.
- **The sea** is built from OSM's coastlines; out at sea, or where the coastline has a gap,
  from the base map's ocean instead, which needs the quick data (selections up to a couple of
  hundred km²). Larger selections with no coastline in them come out as land.
- **Busy servers:** the public Overpass servers are often overloaded. The quick version
  always works; for the detailed one, retry later.
- **Large areas** (above ~10 km²) are slow to download and heavy in 3D.
