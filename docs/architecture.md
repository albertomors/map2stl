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
search / map ──► Selection ──► fetchAreaData ──┬─► quick: vector tiles (1–3 s) ──┐
 (draw.ts)      (center, size,                 ├─► full: Overpass (30–90 s) ─────┤
                 rotation[, points])           └─► terrain: Terrarium tiles ─────┤
                                                                                 ▼
                                                     AreaData { osm, terrain, detail }
                                                        │                │
                                          map preview ◄─┘                └─► 3D view
                                          (preview.ts)          applyEdits → clipToSelection
                                                                → meshes (viewer/*)
```

1. **Selection** (`selection.ts`): stored as center + half sizes + rotation, so it can be
   moved, scaled and rotated in place; free shapes add their points normalized to −1…1 in
   the shape's own frame. The outline ring is derived from these.
2. **Fetching** (`area-data.ts`): terrain, the quick tile data and the Overpass query start
   together. The quick version is handed over as soon as it's ready; the function resolves
   with the full one.
3. **OsmData** (`osm.ts`): the common format both sources produce: buildings, roads,
   railways, water areas and lines, green areas, trees, structures, surfaces, paved areas.
   Coordinates are `[lng, lat]`; widths and heights in meters.
4. **3D** (`viewer/`): building edits are applied, everything is cut to the selection
   outline, then turned into meshes in a local metric frame.

## Files

| File | Role |
|---|---|
| `src/main.ts` | Map setup and all panel wiring (selection, fetching, layers, 3D, editing) |
| `src/search.ts` | Photon search box: towns, streets, addresses, landmarks |
| `src/nav.ts` | Orbit drag (grabbed point follows the cursor) and the navigation control |
| `src/draw.ts` | Drawing shapes on the map, free shapes, edit handles |
| `src/selection.ts` | The `Selection` type, outline, handles, persistence |
| `src/geo.ts` | Spherical geometry and polygon helpers |
| `src/area-data.ts` | Fetch orchestration (quick, full, terrain) and per-layer summary |
| `src/vector-tiles.ts` | Quick data from OpenMapTiles vector tiles |
| `src/overpass.ts` | Overpass client: mirrors, retries, per-server timeout, browser cache |
| `src/osm.ts` | Overpass query, sorting into categories, multipolygons, heights |
| `src/coast.ts` | Sea polygons rebuilt from coastline lines |
| `src/terrain.ts` | Terrarium tiles → elevation grid, sampling |
| `src/eta.ts` | Download time estimate (ridge regression toward measured defaults) |
| `src/preview.ts` | MapLibre layers showing the fetched data |
| `src/clip.ts` | Cuts data to the selection outline (polygon-clipping, line splitting) |
| `src/edits.ts` | Building edits (delete, enlarge) and applying them |
| `src/local.ts` | Local metric frame: meters east/south of the selection center |
| `src/viewer/viewer.ts` | Three.js scene, lights, camera, layer toggles, picking |
| `src/viewer/terrain-mesh.ts` | Terrain tile: grid cut exactly to the outline, walls, base |
| `src/viewer/ground.ts` | Flat layers painted into the terrain texture |
| `src/viewer/objects.ts` | Buildings, structures, bridges, trees |
| `src/viewer/roofs.ts` | Roof shapes from `roof:shape` |
| `src/viewer/gltf.ts` | The 3D view as GLB / glTF: relief baked into the texture, trees as one mesh |
| `src/bug-report.ts` | The "?" bug report: message, context, screenshot, recent errors, zipped |
| `src/credits.ts` | Credits a model's sources ask for (3MF, glTF, the export card) |
| `src/viewer/mesh.ts` | Triangle collector with per-triangle owners, OSM color parsing |

## Design decisions

- **No API keys, no backend.** Every source is free and keyless, so the app can be served
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
  point, or shrinking rings): exact for rectangles, approximate otherwise. A straight
  skeleton is on the roadmap.

## Testing

There's no automated test suite yet. Changes are checked with `npm run build` (strict
type-checking) and by driving the app in a headless browser (Playwright) against saved
Overpass answers, to avoid loading the public servers.
