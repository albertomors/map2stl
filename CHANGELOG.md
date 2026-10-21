# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- README with screenshots and a quick start, a user guide (`docs/guide.md`) and an
  architecture overview (`docs/architecture.md`).
- **Object editing** (milestone 4): click a building, tree, bridge or structure (pier,
  wall, tower…) in the 3D view to select it, then delete it, enlarge it ×1–4 from its base
  (all dimensions), or stretch its height alone; Reset per object. Multi-part buildings are
  edited as one.
- **Restore deleted** brings back deleted objects; **Reset all** clears every edit and puts
  both height multipliers back to their defaults.

### Changed

- The selected object is tinted orange instead of outlined with its 3D edges.
- Selecting waits for the detailed data: the quick tile data has buildings split at tile
  seams and without their parts.
- The 3D sliders are now named "Terrain height multiplier" and "Building height
  multiplier".

## [0.3.0] - 2026-10-21

Milestone 3: the 3D view, plus free shapes and quick data.

### Added

- **3D view** (milestone 3): the selection as a terrain tile with side walls and base,
  ground layers painted on, buildings with roof shapes and OSM colors, bridges, piers,
  walls, towers and trees, with shadows. Layer checkboxes work in 3D; sliders for terrain
  and building height.
- **Free shape** selection: click points, double-click or click the first point to close.
  The area shows while drawing; edges that would cross are refused.
- **Quick data in 1–3 s** from the base map's vector tiles, shown on the map and in 3D
  while the detailed Overpass download runs; the detailed version replaces it in place, and
  the quick one stays if every server fails.
- Everything in the 3D view is cut to the selection outline: terrain edges are exact
  instead of stepped, and buildings, bridges, walls and areas stop at the tile edge.
- **Estimated time left** for the OSM download, from the area (fitted on timed requests)
  and learning from each real download.

### Changed

- One progress bar, for the detailed download; terrain loads in the background.
- Rectangles and free shapes resize freely from the corner handle; hexagons and circles
  keep their ratio.

### Fixed

- Striped shading on roofs and walls in 3D (faces pointing the wrong way).
- Clicks with a small mouse wobble (4–8 px) no longer get lost while drawing a free shape.

## [0.2.0] - 2026-10-19

Milestone 2: fetch the 3D data for the selected area.

### Added

- **Fetch 3D data** (milestone 2): downloads the OpenStreetMap buildings, roads, railways,
  water, green areas and trees inside the selection, plus a terrain elevation grid.
- Per-category counts in the panel (with road length and how many buildings have real
  heights) and a colored map preview with a checkbox per category.
- Building heights from `height`, `building:levels` or an estimate by building type;
  `building:part`s replace their outline.
- Roof shape, roof height and building/roof colors are kept for each building.
- Sea areas, rebuilt from OSM coastlines.
- Bridges marked on roads, railways and streams; bridge decks fetched.
- New layers: bridges, piers, walls and towers; squares, parking and sports (incl. airport
  runways and aprons); sand, rock and glacier.
- Progress bars for the OSM download (waiting time, server, megabytes received) and the
  terrain tiles; Cancel button.
- OSM answers are cached in the browser for a week; busy or silent servers fall back
  to mirrors.

### Changed

- Orbit (right-drag or Ctrl+drag) now holds the map like a hand: the point you grab
  follows the cursor while you turn and tilt, and is still under it when you release.
  Grabbing the sky or a point near the horizon turns and tilts around the view center.

### Fixed

- Orbiting at a steep tilt no longer flings the camera across the city.

## [0.1.0] - 2026-10-19

Milestone 1: find a place and select the area to print.

### Added

- Map with OpenStreetMap vector tiles from OpenFreeMap (no API key). The URL keeps the
  map position, so links can be shared.
- City and region search with suggestions while typing, from Photon. Arrow keys and
  Enter pick a result.
- Navigation: drag to pan, scroll to zoom, right-drag or Ctrl+drag to orbit and tilt
  around the point under the cursor.
- On-screen navigation control: zoom buttons, a draggable compass (click to face north),
  and a 2D/3D toggle.
- Area selection with rectangle, hexagon and circle tools, drawn aligned to the current
  view direction.
- Edit handles on the selection: move from the center, scale from the corner (keeping
  the ratio), rotate from the top.
- Clicking outside the selection clears it.
- Selection panel with size, area, radius, rotation and center, plus a warning for
  areas above 10 km².
- The selection is saved in the browser and restored on reload.
