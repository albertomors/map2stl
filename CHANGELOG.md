# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- A landmark with no Wikidata tag is searched by its name and its town (from reverse
  geocoding), not its name alone, which matched namesakes elsewhere ("Cattedrale di Santa
  Maria Assunta" found Atri's for Pisa's).
- The 3D view builds faster: the terrain mesh about 7× (grid corners found by index, not
  by a text key), the forest's crowns and outline about 3× (worked out once each, the mask
  read back from the CPU), and terrain heights at a point without recomputing the map
  projection each time.
- The nozzle goes down to 0.1 mm (such nozzles exist), the thinnest detail to 0.01 mm; their
  arrows step by 0.1 mm, and by 0.01 mm below 0.1 (0.1 up is 0.2, not 0.11).

### Fixed

- Stray terrain-tile pixels far below everything around them (Sydney Harbour has dozens at
  -1300 to -2200 m, where it's 10-40 m deep) no longer sink the model's lowest point into
  a pit: each takes the height of its neighbors.
- The sea floor no longer stands in plateaus where the terrain tiles have the sea a few
  meters above zero: the sea is taken from the map, and the depths replace the tiles'
  heights there.

### Added

- Relief shading in the 3D view: steep ground turns to rock (whatever's painted there:
  wood, fell, grass) as mountainsides do from above, and hollows darken while ridges
  lighten a little, bringing out gullies and crests. The sun is lower, for longer shadows.
- Forests as one canopy of treetops: OpenStreetMap maps a wood as an area, so it's drawn as
  a single surface over the whole wood, whatever its size: pointed crowns on a jittered
  grid, varied in size and height, sloping down to the ground at the edge along a ragged
  line, like trees thinning out, and opened up by roads, railways and water. The same in
  the 3D view and the print (its own Forests part, crowns never finer than the print can
  show); bigger areas get bigger crowns, so it costs the same for a copse or a
  mountainside. A click on it selects its wood (tinted); a wood printed as something else
  loses it. Delete on a wood ("Delete trees") takes only the trees: the wood stays;
  Restore deleted brings them back. The data panel shows forests in hectares.
- The "Building height multiplier" slider is now "Object height multiplier": it raises
  everything standing on the ground, trees and forests too.
- The sea floor, from EMODnet Bathymetry in European seas (about 115 m, CC BY 4.0) and
  NOAA's global DEM mosaic everywhere else (ETOPO 2022, about 450 m, with NOAA's finer
  coastal models where there are any; public domain); the terrain tiles have almost none
  near coasts. Harbors, bays and straits count as sea too (Sydney's Port Jackson has no
  coastline inside it). Switch the Water layer off and the sea
  becomes ground at its real depths, in the 3D view and in the print, the deepest point
  the model's lowest with the base under it (the whole map stands taller). The depths are
  smoothed over about a cell, so the floor slopes gently from the coast, without the
  data's facets or ledges where it stops short of the shore. With Water on,
  sea level is the lowest point, as before. Fetched only for areas with sea; the data
  panel shows how deep it goes and from where, and an export showing the sea floor credits
  its source.
- Boats moored at piers, a few here and there: along the sides of each pier facing water,
  some berths get a boat lying alongside, varied in length (5–14 m) and color, most with a
  cabin; the same place gets the same boats every time. They float on the water, so they
  show with the Water layer (and print with it, as their own Boats part), and each can be
  selected and deleted.
- Steep ground prints as rock, its own part in a 3MF (gray, like the 3D view's relief
  shading), so it can take its own filament.
- National LiDAR terrain where a country publishes it in a form a browser can load: Norway
  (Kartverket, CC BY 4.0), the Netherlands (AHN, CC0), England (the Environment Agency's
  LiDAR composite, Open Government Licence) and the US (USGS 3DEP, public domain; LiDAR
  over most of it, coarser elsewhere), about 0.5–1 m, asked for at the detail the print can use (about 1–2.5 m
  depending on the area's size) and fitted into the same grid as the worldwide tiles, which
  fill anything it doesn't cover. Ridges, gullies and rock faces come out sharp instead of
  rounded. The data panel names the terrain's source and spacing, and the export credits it.
- Forests as tall as they really are, where the LiDAR has the surface model too (Norway,
  the Netherlands, England):
  each crown takes the measured height of the trees under it, and where nothing as tall as
  a tree stands, the wood opens into a clearing, its edge sloping and lined with trees like
  the wood's outline. Elsewhere the canopy stays at 15 m.

## [0.6.0] - 2026-10-24

Landmarks and bridges as real 3D models, your own or openly licensed ones found on
Wikimedia Commons and Sketchfab; streets, rivers and areas you can select and change; and a
preview of the export before downloading it.

### Added

- Replace a building or a bridge with a 3D model (STL, OBJ, GLB, or glTF with its data
  inside): select it, then "Replace with a 3D model…". It's fitted automatically: turned
  upright, its outline lined up with the footprint (the long sides together), scaled evenly
  to fit inside it, standing on the lowest ground under it (for a bridge, the river bed; a
  bridge deck fits its outline, a road or rail bridge its line at its width). Size (now down
  to ×0.25) and Height still apply; Turn 90° and Stand up fix a wrong guess; Remove brings
  the original back. It prints with the buildings (or bridges), merged and checked for thin
  details like the rest.
- Find a 3D model online: openly licensed models on Wikimedia Commons (the landmark's own
  Wikidata model first, then files depicting it, then a name search) and Sketchfab's much
  bigger catalog (the Leaning Tower of Pisa has a dozen). Landmarks are searched by their
  English name from Wikidata as well as the local one from OSM; a search box refines it by
  hand. Every result shows a thumbnail, license, author, size and triangle count;
  NonCommercial and ShareAlike licenses are highlighted, not hidden; the export credits the
  model (in a 3MF's metadata, and in the status line to copy when sharing). Searching needs
  no account; Sketchfab downloads ask once for your API token (a free account works), kept
  in this browser, with a link to forget it.
- Models come as zipped glTF too (as Sketchfab sends them); textures are skipped, and models
  over 300,000 triangles are simplified, all read in the background. A progress bar shows
  the download in the result you clicked, and a line at the top right shows it wherever
  you are; Use becomes Cancel meanwhile, using another model cancels it, and a download
  keeps going if you select something else, landing on the building it was for.
- How tall a model comes out, against the building's height in OpenStreetMap: where that
  height is real and the two differ a lot, a warning says why it may be (a base or square
  around it, a lean, a whole scene) with a one-click "Make it N m tall". A model lying on
  its side stands up by itself (the axis that matches the building's height, or for a
  bridge the one that makes it lowest).
- Streets, railways, rivers and paths, and areas (water, parks, squares, sand), are
  selectable in the 3D view: click them on the ground, they light up in orange. Streets,
  railways and rivers get a Width slider (×0.25 to ×4); areas a "Prints as" choice (water,
  park, square, sand); all can be deleted. The print follows, and Reset, Restore deleted and
  Reset all cover them too. The panel names them as OpenStreetMap does.
- "Also here": where OpenStreetMap has buildings drawn over each other (the Arena di
  Verona's detailed 2024 remapping covers the named outline), the card lists the others,
  named first, one click to select. An unnamed building drawn over a named landmark is
  searched for 3D models by the landmark's name.

### Changed

- "Preview print" is now "Preview export", and the file format and Download appear only in
  the preview: the file is written from the model previewed, merged and saved without being
  built a second time. While the preview rebuilds after a change, Download waits for it.

### Fixed

- Delete, then Restore deleted, brings an object back as it was: its size and height edits
  are kept through the delete.
- Rows a selected object doesn't have (a wall's Size, a bridge's Height) are hidden: they
  showed for every object.

## [0.5.0] - 2026-10-24

Milestone 5: export to STL and 3MF, with a print preview, streets, water and parks carved
into the print as their own colors, every export merged into one watertight solid, and
gentler, chunked requests to the OSM servers.

### Added

- **Export to STL and 3MF**: print size of the longest side, base thickness, thinnest
  detail and nozzle width in millimeters (each with a minimum, none with a maximum), in a
  card at the bottom right of the 3D view once the detailed data has arrived. Exports what
  the 3D view shows: edits, height multipliers and visible layers, the shape lying on the
  bed as it was drawn. Every object is a closed solid (sunk into the ground so nothing
  floats on slopes), the terrain one closed block with a flat base, and both files credit
  OpenStreetMap. The 3MF has a named, colored part per layer (Terrain, Water, Streets,
  Squares, Parks, Sand and rock, Buildings, Bridges and structures, Trees), pre-assigned to
  filaments in OrcaSlicer and Bambu Studio.
- Print preview: the model exactly as it will be exported, in the 3D view, in one plain
  color for an STL or the parts' colors for a 3MF. Objects narrower than the nozzle are
  shown in red, with a warning counting them per part and what to do about it.
- Streets, water, squares, parks and sand in the print, carved into the ground like a
  relief, in steps of the thinnest detail: squares, parks and sand flush with the ground,
  streets a step below, water two steps below, so a river always lies lowest. Each follows
  the terrain's own triangles, so nothing cuts into a slope or floats above it, and each is
  its own 3MF part. Streets, railways and streams are widened to the thinnest detail if
  narrower; footpaths, tracks and steps print only if their real width is enough; gaps and
  slivers far too thin to print are tidied away.
- Every export is merged into one watertight solid with manifold-3d (WebAssembly, about
  200 kB, loaded on the first export); a 3MF gets one solid per colored part.
- The preview and downloads are built in a background worker: the page stays responsive,
  a change made meanwhile drops the stale build, and a job over a second shows a progress
  bar with the step it's on.
- Ko-fi support link in the README and a Sponsor button on the GitHub page.

### Changed

- The 3D view uses the map's controls (drag pans, right-drag or Ctrl+drag orbits, scroll
  zooms), with one hint at the top right; the edit summary and the selected object's card
  float at the top right too, and the left panel holds only the multipliers and layers.
- A selected object lifts off the ground and is tinted light orange; the height
  multipliers and an object's Size and Height sliders are instant, rebuilt when let go.
- Big selections are requested in parts (about 10 km² or 25,000 buildings each), each
  cached on its own; the main server is asked for a free slot first, and refusals are
  followed by a wait that doubles each time, as the server asks.
- The download time estimate follows the building count: about 44 s per request plus 1.9 s
  per 1,000 buildings, fitted on real requests.
- Shorter README aimed at hobbyists, with screenshots of Vatican City.

### Fixed

- Gabled and hipped roofs are closed solids (irregular footprints left hairline gaps along
  the ridge).
- Multi-part landmarks stand together on one ground level; parts mapped in mid-air are
  extended down to what's below them; parts sticking out past a roughly drawn outline, or
  mapped without one, join their building; the Eiffel Tower's legs are one building.
- 3MF: neighbouring buildings no longer share points where their walls touch, and points a
  hair apart are no longer fused (both showed as broken edges in slicers).
- Hiding a layer hides its selected object; a selected object no longer jumps or shifts
  when its sliders are released; the export fields no longer show values the browser
  restored into the wrong fields.

### Known issues

- Where two kinds of ground touch only at a corner, or a street just grazes the edge of the
  selection, the terrain isn't quite closed at that spot (a few in a square kilometer).
  manifold-3d then won't merge it: it goes into the file as it is, and the status line says
  so. Slicers print it fine.

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
