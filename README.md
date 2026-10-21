# map2stl

Pick any place on Earth and turn it into a 3D-printable model.

Search a place, draw the area you want (rectangle, hexagon or circle), and later steps will
download its buildings, terrain, water and greenery, let you toggle and edit them in 3D
(delete buildings, enlarge monuments), and export STL or 3MF.

## Run

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production build in dist/
```

## What works now

### 1. Find the place and select the area


- **Map**: OpenStreetMap vector tiles from [OpenFreeMap](https://openfreemap.org), no API key.
  The URL keeps the map position (`#zoom/lat/lng`), so links can be shared.
- **Search**: cities, regions and countries, with suggestions while you type, from
  [Photon](https://photon.komoot.io) (OSM data, no API key). Arrow keys + Enter pick a result.
- **Navigation**: drag to pan, scroll to zoom, **right-drag or Ctrl+drag to orbit and tilt**:
  horizontal turns, vertical tilts, and the point you grabbed stays under the cursor
  (replaces MapLibre's center-spinning rotate).
  On-screen: zoom buttons, a compass you drag to rotate (click to face north), 2D/3D toggle.
- **Area selection**: pick a shape and drag on the map.
  - Rectangle: drag corner to corner.
  - Hexagon (flat top) and circle: drag from the center outward.
  - Free shape: click points (drag to pan between clicks); double-click, or click the first
    point, to close it. The area shows while drawing; an edge that would cross another
    turns the outline red and the click is refused.
  - Shapes are drawn aligned to the current view, not to north: rotate the map first,
    then draw.
  - Edit after drawing with the handles: **center** moves, **corner** resizes (rectangles
    and free shapes stretch freely, hexagons and circles keep their ratio), **top** rotates
    in place.
  - Click outside the shape to clear it. Esc cancels drawing.
  - The panel shows size, area, radius, rotation and center, and warns above 10 km².
  - The selection survives reloads (localStorage).

### 2. Fetch the 3D data

**Fetch 3D data** downloads everything inside the selection and shows it on the map,
colored by category, with a checkbox per layer:

- **OpenStreetMap features** from the [Overpass API](https://overpass-api.de), one toggleable
  layer each:
  - **Buildings** and `building:part`s, with roof shape, roof height and colors when tagged.
  - **Bridges, piers, walls, towers**: bridge decks, piers and breakwaters, walls and city
    walls, towers, chimneys, masts and lighthouses, each with a height.
  - **Roads & paths** and **railways & trams**, with bridges marked (darker on the map).
  - **Squares, parking, sports**: pedestrian squares, car parks, pitches and tracks,
    airport runways, taxiways and aprons.
  - **Water**: lakes, rivers and streams, plus the **sea**, rebuilt from the coastline
    (OSM stores coasts as lines with the water on their right, not as areas).
  - **Green areas**, **sand, rock, glacier** and single **trees**.
  - Tunnels and underground features are skipped.
  - Buildings are kept whole when their center is inside the shape (a building cut at the
    edge would print as a broken wall). Lines and areas are kept when they touch it;
    cutting them to the shape happens at export.
  - Building height: `height` tag, else `building:levels` × 3 m, else an estimate from the
    building type (1–3 floors). The panel shows how many have real heights.
  - Untagged structures get typical heights (city wall 6 m, chimney 40 m, mast 12 m…).
  - Outlines that contain `building:part`s are replaced by their parts.
  - Answers are cached in the browser for a week. Busy servers (429/5xx, or no answer in
    100 s) are skipped for the next mirror; dense city centers take 30–60 s.
  - The progress bar shows an **estimated time left**: `28 s + 12.6 s per km²` to start
    with, fitted on timed requests (0.25–3.2 km², dense centers and a suburb; typically
    ±17 s, because server load varies a lot: the same km² took 17–39 s). Each real
    download is remembered and the fit moves toward this browser's experience, including a
    term for the building count read from the base map's tiles.
- **Terrain** from [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
  (Terrarium PNG): an elevation grid over the selection, at most 16 tiles, up to zoom 14
  (a few meters per sample; the source data is coarser in many places).

The result (`AreaData` in `src/area-data.ts`) is what the 3D view builds from.

### 3. 3D view

**Open 3D view** builds the area in Three.js (loaded only when first opened):

- **Terrain tile** cut to the selection shape, with side walls and a flat base, like the
  print will be. Where there's sea, the sea floor in the terrain data is flattened to the
  water surface.
- **Ground layers** (water, green areas, squares, sand, roads, rails) painted onto the
  terrain as one texture, so they follow every slope.
- **Buildings** on the lowest ground under them, with roofs from `roof:shape`: gabled,
  hipped, pyramidal, dome, onion, skillion (others approximated as hipped), and colors from
  `building:colour` / `roof:colour`.
- **Bridges** as decks level with the higher bank; **piers, walls, towers** as solids;
  **trees** as cones. Shadows from a low sun.
- The layer checkboxes switch layers in 3D too. Sliders: **terrain height** (×1–5) and
  **building height** (×0.5–3). Left-drag orbits, right-drag pans, scroll zooms.

## Code

| File | Role |
|---|---|
| `src/main.ts` | Map setup, panel wiring |
| `src/search.ts` | Photon city search box |
| `src/nav.ts` | Orbit drag and the on-screen navigation control |
| `src/draw.ts` | Drag-to-draw on the map, edit handles |
| `src/selection.ts` | The `Selection` type (center, size, rotation; points for free shapes), persistence |
| `src/geo.ts` | Spherical geometry: distance, destination, bearing, area, point in polygon |
| `src/area-data.ts` | Fetches OSM data and terrain for a selection, per-layer summary |
| `src/overpass.ts` | Overpass client: mirrors, retries, timeout, browser cache |
| `src/osm.ts` | Overpass query, sorting into categories, multipolygons, building heights |
| `src/coast.ts` | Sea polygons from coastline lines |
| `src/terrain.ts` | Terrarium tiles → elevation grid |
| `src/preview.ts` | Map layers showing the fetched data |
| `src/eta.ts` | Download time estimate, learning from past downloads |
| `src/local.ts` | Local metric frame (meters east/south of the selection center) |
| `src/viewer/viewer.ts` | Three.js scene, lights, camera, layer toggles |
| `src/viewer/terrain-mesh.ts` | Terrain tile: grid cut to the shape, walls, base |
| `src/viewer/ground.ts` | Flat layers painted into the terrain texture |
| `src/viewer/objects.ts` | Buildings, structures, bridges, trees |
| `src/viewer/roofs.ts` | Roof shapes |
| `src/viewer/mesh.ts` | Triangle collector, OSM color parsing |

## Data sources and terms

Going public means respecting each service's terms:

- **OpenFreeMap**: free, no limits; keep the OSM attribution.
- **Photon** (komoot's public instance): fair use only. For heavy public traffic,
  self-host Photon or move to a commercial geocoder.
- **Overpass API**: shared public servers, fair use. Heavy public traffic needs our own
  instance or a commercial OSM extract service.
- **AWS Terrain Tiles**: open data, free, no key.
- **OSM data** is ODbL: exported models must credit "© OpenStreetMap contributors".
- **Google Photorealistic 3D Tiles** are deliberately **not** used: their terms forbid
  exporting the meshes, which is the whole point here.

See [ROADMAP.md](ROADMAP.md) for what's next.
