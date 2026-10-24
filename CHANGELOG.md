# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Print preview: a Preview print button in the Export card shows, in the 3D view, the model
  exactly as it will be exported: the base thickness, the thinnest-detail widening (walls,
  masts, trees, bridges) and one color per part, as in the 3MF. Changing the print settings,
  multipliers or layers rebuilds it; editing objects is paused meanwhile.
- Nozzle width in the Export card (0.4 mm by default), and a warning when objects come out
  narrower than it at the chosen print size: they're shown in red in the preview, counted per
  part, with what to do about it. The width is that of the whole object seen from above, so a
  thin part flush against a wider one isn't flagged.
- The print preview follows the chosen format: one plain color for an STL (what a single
  filament prints), each part's own color for a 3MF. Switching repaints it at once.
- Streets, water, squares, parks and sand in the print, carved into the ground like a
  relief, in steps of the thinnest detail (the smallest height that prints): squares, parks
  and sand flush with the ground, streets a step below, water two steps below, so a river
  always lies lowest. Each follows the terrain's own triangles, so nothing cuts into a slope
  or floats above it. In a 3MF each is its own part (Water, Streets, Squares, Parks, Sand
  and rock), carved a step deeper and filled back, so a slicer can give it its own filament
  or the terrain's. Each spot belongs to one kind (water first, then streets, squares,
  sand, parks). Streets, railways and streams are widened to the thinnest detail if
  narrower; footpaths, tracks and steps print only if their real width is enough, so a
  city center doesn't turn into thick bands. Gaps and slivers far too thin to print are
  tidied away.
- Every export is merged into one watertight solid with manifold-3d (WebAssembly, about
  200 kB, loaded on the first export): no hidden faces where objects overlap, as CAD tools,
  mesh checkers and print services expect. A 3MF gets one solid per colored part. A solid
  that can't be merged is included as it is, and the status line says so.

### Changed

- The 3D view uses the map's controls: drag pans, right-drag (or Ctrl+drag) orbits, scroll
  zooms. One hint at the top right explains both; the "click to edit" hint moved to the
  edits card below it.
- Print settings have only a minimum (longest side and base 1 mm, thinnest detail and nozzle
  0.01 mm) and no maximum; a value below it is refused with a message instead of silently
  replaced. Thinnest detail now defaults to 0.4 mm, the nozzle width.
- 3MF files list each point of a solid by its exact position: points a hair apart are no
  longer fused, which folded the tiny triangles between them.
- The print preview and downloads are built in a background worker: the page stays
  responsive while a big area builds, and a change made meanwhile (say to the thinnest
  detail) drops the stale build instead of queueing behind it. A job that runs over a
  second shows a progress bar with the step it's on.

## [0.5.2] - 2026-10-22

Gentler, chunked requests to the OSM servers, a better download estimate, and exports that
open cleanly in OrcaSlicer.

### Changed

- Big selections are requested in parts, one after another: at most about 10 km² or 25,000
  buildings each (planned from the quick data), merged without duplicates. Each part is
  cached on its own, so a retry only asks for what's missing.
- Gentler on the public servers: before each request the main server is asked when a slot
  is free, and a refusal is followed by a wait that doubles each time (5 s up to 60 s, or
  the server's Retry-After), as the server asks. The progress bar shows the part and the
  wait; the estimate is the sum over the parts.
- The download time estimate follows the building count instead of the area: about 44 s
  per request (the server's wait, whatever the size) plus 1.9 s per 1,000 buildings (what
  comes back). On 10 real requests it's off by 6 s on average instead of 10 s, and a dense
  5.9 km² area is now estimated at 107 s (real: 103 s) instead of 61 s.
- Exports keep the shape the way it was drawn: a rectangle or hexagon drawn on a turned
  map lies straight on the print bed, and the print size is its own longest side.
- 3MF for OrcaSlicer and Bambu Studio: parts are named (Terrain, Buildings, Bridges and
  structures, Trees) and pre-assigned to filaments 1–4. Other slicers ignore this.
- The map's controls hint moved to a box at the top right, the same box that shows the 3D
  controls in the 3D view.
- README screenshots of Vatican City.

### Fixed

- 3MF: neighbouring buildings no longer share points where their walls touch, which
  slicers reported as non-manifold edges.

## [0.5.1] - 2026-10-22

Fixes for landmarks, editing and the export panel, and a tidier 3D view.

### Changed

- The 3D view's left panel holds only the two height multipliers and the layers. The
  controls hint, the edit summary (Restore deleted, Reset all) and the selected object's
  card float at the top right, above the export card.

### Fixed

- Multi-part landmarks stand together: all parts of a building share one ground level (on a
  slope like the Vatican hill, St. Peter's dome stood on different ground from its body and
  drifted further when enlarged).
- Parts mapped in mid-air with nothing of their building under them (St. Peter's drum and
  corner domes, some of the Palace of Westminster) are extended down to what's below them
  or to the ground, instead of floating.
- Parts that stick out past a roughly drawn outline still join it (Cologne Cathedral's nave
  roof), and parts mapped without any outline are grouped with the parts they touch.
- Enlarging an object no longer shifts it when the slider is released: the preview and the
  rebuild both scale around the middle of its bounding box.
- The export fields no longer show values the browser restored into the wrong fields
  (3 / 0.8 / 0.8 instead of 150 / 3 / 0.8).

## [0.5.0] - 2026-10-22

Milestone 5, first part: export to STL and 3MF.

### Added

- **Export to STL and 3MF**: print size of the longest side, base thickness and thinnest
  detail in millimeters, in a floating card at the bottom right of the 3D view once the
  detailed data has arrived. Exports what the 3D view shows: edits, height multipliers and
  visible layers. Every object is a closed solid (sunk 1 m into the ground so nothing floats
  on slopes), the terrain is one closed block with a flat base, and both files credit
  OpenStreetMap. The 3MF is one object with a named, colored part per layer.
- Ko-fi support link in the README and a Sponsor button on the GitHub page.

### Changed

- A selected object lifts off the ground (6 m, or 12% of its height for tall ones) and is
  tinted light orange, keeping the shading of its own colors.
- The height multiplier sliders are instant: dragging stretches the scene on the graphics
  card (trees and shadows included), and the scene is rebuilt once when you let go.
- An object's own Size and Height sliders are instant too: dragging stretches the lifted
  object, letting go rebuilds just that object, and the rest of the scene catches up when
  the selection changes.
- The download time estimate is fitted on real requests: about 43 s plus 3 s per km² (the
  public server has a ~44 s floor for almost any area), instead of 28 s + 12.6 s/km².
- Shorter README, aimed at hobbyists: what it's for, three steps, features, how to run it.

### Fixed

- Gabled and hipped roofs are closed solids: their two sides now meet in the same ridge
  points (before, irregular footprints left hairline gaps along the ridge).
- Landmarks with arched parts stay one building: the Eiffel Tower's four legs were
  selected separately because the center of an arch lies outside the tower's outline.
- Hiding a layer also hides its selected (lifted) object.
- A selected object no longer jumps higher when its Height or Size slider is released.

## [0.4.0] - 2026-10-21

Milestone 4: editing objects in the 3D view.

### Added

- README walkthrough of Nidarosdomen in Trondheim with screenshots, a user guide
  (`docs/guide.md`) and an architecture overview (`docs/architecture.md`).
- **Object editing** (milestone 4): click a building, tree, bridge or structure (pier,
  wall, tower…) in the 3D view to select it, then delete it, enlarge it ×1–4 from its base
  (all dimensions), or stretch its height alone; Reset per object. Multi-part buildings are
  edited as one.
- **Restore deleted** brings back deleted objects; **Reset all** clears every edit and puts
  both height multipliers back to their defaults.

### Fixed

- A multi-part building shows the name of the whole building (Nidarosdomen), not of its
  first named part.

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
