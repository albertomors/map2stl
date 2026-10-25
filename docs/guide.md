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

Type a city, region or country in the search box. Suggestions appear as you type;
**↑ / ↓** and **Enter** pick one, or click it. Only places are searched, not streets or
shops.

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
(about 28 s plus 12.6 s per km²) and learns from your own downloads. Public servers are
often busy, so expect ±20 s. If a server is busy or silent for 100 s, the next mirror is
tried. If every server fails, the quick version stays and the panel tells you to fetch
again later. Answers are cached in the browser for a week, so fetching the same area
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
| **Terrain** | An elevation grid over the area, a few meters per sample. |

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

- **Left-drag:** orbit. **Right-drag:** pan. **Scroll:** zoom.
- **Terrain height multiplier** (×1–5) exaggerates the terrain; **Object height
  multiplier** (×0.5–3) everything standing on it: buildings, bridges, towers, trees and
  forests. Both rebuild the scene, which takes a moment on big areas (making them
  instant is on the roadmap).
- The layer **checkboxes** work in 3D too.
- **Back to map** returns to the map.

What you see:

- **The tile:** terrain cut exactly to your shape, with side walls and a flat base, the way
  the print will be. Where the area touches the sea, the sea floor in the elevation data is
  flattened to the water surface.
- **Ground layers** (water, green areas, squares, sand, roads, rails) are painted onto the
  terrain, so they follow every slope.
- **Buildings** stand on the lowest ground under them, with roofs from OSM: gabled, hipped,
  pyramidal, dome, onion and skillion (other shapes are approximated as hipped or gabled),
  and with OSM colors when tagged.
- **Bridges** are decks level with their higher bank; **piers, walls and towers** are solid;
  **trees** are cones.
- **Everything is cut at the tile edge.** Buildings crossing it get a flat face and a flat
  roof there.

## 5. Editing objects

In the 3D view, **click a building, tree, bridge or structure** (pier, wall, tower, mast…)
to select it. It turns orange, and the panel shows its name, height (and whether it's
tagged, from floors or estimated), roof and number of parts. Click empty space or press
**Esc** to deselect.

| Control | Effect | Available for |
|---|---|---|
| **Delete** (or the Delete key) | Removes it | Everything |
| **Size** ×1–4 | Enlarges it from the center of its base, all dimensions together | Buildings, trees, towers, piers |
| **Height only** ×0.5–4 | Stretches it vertically, on top of Size | Buildings, trees, towers, piers, walls |
| **Reset** | Puts this object back | Everything |

- **Restore deleted** (under the 3D controls) brings back every deleted object.
  **Reset all** clears every edit and puts both height multipliers back to their defaults.
- A building made of several parts (Nidarosdomen has 161) is selected and edited as one,
  under the name of the whole building.
- Edits are applied before the cut at the tile edge, so an enlarged landmark is still
  trimmed there. They last until you fetch a new area; the export will use them.
- Selecting waits for the detailed data: the quick version's buildings are split at tile
  seams and have no parts, and their identities change when the detailed data arrives.

## Known limits

- **Gabled and hipped roofs are exact only on rectangular footprints.** On L-shapes and
  other irregular outlines they're approximations.
- **Courtyard buildings** always get flat roofs.
- **A selection that's entirely sea** comes out as land: the sea is built from coastlines,
  and there are none inside it.
- **Terrain detail** is about 30 m in many places, even though the grid is finer.
- **Busy servers:** the public Overpass servers are often overloaded. The quick version
  always works; for the detailed one, retry later.
- **Large areas** (above ~10 km²) are slow to download and heavy in 3D.
