# Architecture

A static web app: TypeScript, [Vite](https://vite.dev), [MapLibre GL JS](https://maplibre.org)
for the map, [Three.js](https://threejs.org) for 3D. No backend: the browser talks
directly to public open-data services.

```sh
npm run dev      # dev server with hot reload, http://localhost:5173
npm run build    # type-check (tsc --noEmit) + production build in dist/
npm run preview  # serve dist/
```

## Data flow

```
search / map ──► Selection ──► fetchAreaData ──┬─► quick: vector tiles (1–3 s) ──────┐
 (draw.ts)      (center, size,                 ├─► full: Overpass, in parts (30–90 s) ┤
                 rotation[, points])           ├─► terrain: Terrarium tiles,         │
                                               │     then national LiDAR if any ──────┤
                                               └─► sea depths (areas with sea) ───────┤
                                                                                      ▼
                                              AreaData { osm, terrain, bathymetry, detail }
                                                 │                │
                                   map preview ◄─┘                └─► 3D view
                                   (preview.ts)          applyEdits → clipToSelection
                                                         → meshes (viewer/*)
                                                                  │
                                                                  ├─► print: STL, 3MF (print-worker)
                                                                  └─► scene: GLB, glTF (viewer/gltf.ts)
```

1. **Selection** (`selection.ts`): stored as center + half sizes + rotation, so it can be
   moved, scaled and rotated in place; free shapes add their points normalized to −1…1 in
   the shape's own frame. The outline ring is derived from these.
2. **Fetching** (`area-data.ts`): terrain, the quick tile data and the Overpass query start
   together. The quick version is handed over as soon as it's ready; the function resolves
   with the full one. Overpass is asked in parts sized by the answer predicted from the
   quick data; the terrain is upgraded to national LiDAR where `lidar.ts` has a source, and
   sea depths come from `bathymetry.ts` when the area has sea.
3. **OsmData** (`osm.ts`): the common format both sources produce: buildings, roads,
   railways, water areas and lines, green areas, trees, structures, surfaces, paved areas.
   Coordinates are `[lng, lat]`; widths and heights in meters.
4. **3D** (`viewer/`): building edits are applied, everything is cut to the selection
   outline, then turned into meshes in a local metric frame.
5. **Export** (`export.ts`, in `print-worker.ts`): the same scene built as closed solids in
   millimeters, ground layers carved in (`print-ground.ts`), merged with manifold-3d
   (`merge.ts`) and written as STL or 3MF (`export-files.ts`). GLB and glTF are written from
   the 3D view itself (`viewer/gltf.ts`).

## Files

| File | Role |
|---|---|
| `src/main.ts` | Map setup and all panel wiring (selection, fetching, layers, 3D, editing) |
| `src/search.ts` | Photon search box: towns, streets, addresses, landmarks |
| `src/nav.ts` | Orbit drag (grabbed point follows the cursor) and the navigation control |
| `src/draw.ts` | Drawing shapes on the map, free shapes, edit handles |
| `src/selection.ts` | The `Selection` type, outline, handles, persistence |
| `src/geo.ts` | Spherical geometry and polygon helpers |
| `src/area-data.ts` | Fetch orchestration (quick, full, terrain), request parts sized by predicted answer, per-layer summary |
| `src/vector-tiles.ts` | Quick data from OpenMapTiles vector tiles |
| `src/overpass.ts` | Overpass client: mirrors, retries, per-server timeout, browser cache |
| `src/osm.ts` | Overpass query, sorting into categories, multipolygons, heights |
| `src/coast.ts` | Sea polygons rebuilt from coastline lines |
| `src/terrain.ts` | Terrarium tiles → elevation grid, sampling |
| `src/lidar.ts` | National LiDAR terrain (and surface, for canopy heights): Norway, the Netherlands, England, the US |
| `src/bathymetry.ts` | Sea depths: EMODnet in European seas, NOAA ETOPO 2022 and coastal DEMs elsewhere |
| `src/official-sources.ts` | Where official 3D buildings exist (swissBUILDINGS3D), free of three.js |
| `src/official3d.ts` | Reads official 3D buildings from 3D Tiles (b3dm, Draco) and matches them to OSM buildings |
| `src/commons.ts` | Openly licensed 3D models on Wikimedia Commons (Wikidata model, depicts, name) |
| `src/sketchfab.ts` | Downloadable 3D models on Sketchfab: search, and download with the user's token |
| `src/model-assets.ts` | The 3D models standing in for buildings: what each is and where it came from |
| `src/model-files.ts` | Reads STL, OBJ, glTF/GLB and zipped glTF into triangles, simplifying huge scans |
| `src/model-worker.ts` | Reads model files off the main thread |
| `src/eta.ts` | Download time estimate (ridge regression toward measured defaults) |
| `src/preview.ts` | MapLibre layers showing the fetched data |
| `src/clip.ts` | Cuts data to the selection outline (polygon-clipping, line splitting) |
| `src/edits.ts` | Object edits (delete, size, height, width, prints as) and applying them |
| `src/local.ts` | Local metric frame: meters east/south of the selection center |
| `src/viewer/viewer.ts` | Three.js scene, lights, camera, layer toggles, picking |
| `src/viewer/terrain-mesh.ts` | Terrain tile: grid cut exactly to the outline, walls, base |
| `src/viewer/ground.ts` | Flat layers painted into the terrain texture |
| `src/viewer/objects.ts` | Buildings, structures, bridges, trees |
| `src/forest.ts` | Forests as one canopy of treetops, at LiDAR-measured heights where known |
| `src/boats.ts` | Boats moored along piers |
| `src/viewer/models.ts` | 3D models fitted in place of buildings and bridges |
| `src/viewer/relief.ts` | Relief shading: steep ground as rock, hollows darker |
| `src/viewer/scene.ts` | The shared frame (local meters, bounds, terrain heights) for the 3D view and the export |
| `src/viewer/ground-pick.ts` | What street, river or area lies under a click on the ground |
| `src/viewer/drape.ts` | Flat layers laid on the terrain as solids for the print |
| `src/export.ts` | The printable model: closed solids in millimeters, a part per layer |
| `src/print-ground.ts` | Streets, water, parks, squares and sand carved into the print |
| `src/print-worker.ts` | Builds the print preview and the files off the main thread |
| `src/merge.ts` | Unites the solids into one watertight solid per part (manifold-3d) |
| `src/export-files.ts` | Binary STL and colored 3MF, with the OpenStreetMap credit |
| `src/viewer/roofs.ts` | Roof shapes from `roof:shape` |
| `src/viewer/gltf.ts` | The 3D view as GLB / glTF: relief baked into the texture, trees as one mesh |
| `src/bug-report.ts` | The "?" bug report: message, context, screenshot, recent errors, zipped |
| `src/dev-log.ts` | Dev server only: records from real use (each request's size and time) to `debug/*.jsonl` |
| `src/credits.ts` | Credits a model's sources ask for (3MF, glTF, the export card) |
| `src/viewer/mesh.ts` | Triangle collector with per-triangle owners, OSM color parsing |

## Design decisions

- **No API keys, no backend.** Every source is free and keyless (Sketchfab downloads use
  the user's own token), so the app can be served
  as static files. The price is depending on shared public servers (Overpass, Photon);
  see the roadmap for self-hosting before heavy public use.
- **Quick then full data.** Overpass is complete but slow and often overloaded; the base
  map's vector tiles are instant but simplified. Showing the tiles first and swapping in
  Overpass keeps the app responsive and gives a fallback when every server fails.
- **Cookie-cutter clipping.** Everything touching the selection is fetched, then cut to the
  outline before meshing, so the model ends exactly at the tile edge. Edits happen before
  the cut, so an enlarged landmark is still trimmed.
- **Coordinates.** Data stays in `[lng, lat]`. Meshes use a local frame (x east, z south,
  y up) around the selection center: accurate to well under a meter over a few km. The
  terrain grid lives in Web Mercator pixel space; the tile cut happens there so heights
  interpolate exactly on the terrain surface.
- **One mesh per layer.** Each layer is merged into a single geometry (one draw call);
  buildings keep a per-triangle owner index so clicks can be traced back to one building.
- **Roofs** are strips between the eave outline and an inner outline (a ridge line, a
  point, or shrinking rings): exact for rectangles, approximate otherwise.

## Testing

There's no automated test suite yet. Changes are checked with `npm run build` (strict
type-checking) and by driving the app in a headless browser (Playwright) against saved
Overpass answers, to avoid loading the public servers.
