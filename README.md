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
  - Shapes are drawn aligned to the current view, not to north: rotate the map first,
    then draw.
  - Edit after drawing with the handles: **center** moves, **corner** scales (keeps the
    ratio), **top** rotates in place.
  - Click outside the shape to clear it. Esc cancels drawing.
  - The panel shows size, area, radius, rotation and center, and warns above 10 km².
  - The selection survives reloads (localStorage).

### 2. Fetch the 3D data

**Fetch 3D data** downloads everything inside the selection and shows it on the map,
colored by category, with a checkbox per layer:

- **OpenStreetMap features** from the [Overpass API](https://overpass-api.de): buildings
  (and `building:part`s), roads and paths, railways and trams, water areas and streams,
  green areas (parks, grass, forest…) and single trees. Tunnels and underground features
  are skipped.
  - Buildings are kept whole when their center is inside the shape (a building cut at the
    edge would print as a broken wall). Lines and areas are kept when they touch it;
    cutting them to the shape happens at export.
  - Building height: `height` tag, else `building:levels` × 3 m, else an estimate from the
    building type (1–3 floors). The panel shows how many have real heights.
  - Outlines that contain `building:part`s are replaced by their parts.
  - Answers are cached in the browser for a week. Busy servers (429/5xx, or no answer in
    100 s) are skipped for the next mirror; dense city centers take 30–60 s.
- **Terrain** from [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
  (Terrarium PNG): an elevation grid over the selection, at most 16 tiles, up to zoom 14
  (a few meters per sample; the source data is coarser in many places).

The result (`AreaData` in `src/area-data.ts`) is what the 3D viewer will build from.

## Code

| File | Role |
|---|---|
| `src/main.ts` | Map setup, panel wiring |
| `src/search.ts` | Photon city search box |
| `src/nav.ts` | Orbit drag and the on-screen navigation control |
| `src/draw.ts` | Drag-to-draw on the map, edit handles |
| `src/selection.ts` | The `Selection` type (center, size, rotation) passed to later steps, persistence |
| `src/geo.ts` | Spherical geometry: distance, destination, bearing, area, point in polygon |
| `src/area-data.ts` | Fetches OSM data and terrain for a selection, per-layer summary |
| `src/overpass.ts` | Overpass client: mirrors, retries, timeout, browser cache |
| `src/osm.ts` | Overpass query, sorting into categories, multipolygons, building heights |
| `src/terrain.ts` | Terrarium tiles → elevation grid |
| `src/preview.ts` | Map layers showing the fetched data |

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
