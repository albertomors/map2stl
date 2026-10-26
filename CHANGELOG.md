# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The search box finds streets, addresses and landmarks, not just towns: "Baker Street",
  "Via Roma 12, Modena", "Eiffel Tower", "Colosseum". Each suggestion says what it is and
  where; famous places come first, then those near the map's center; a street's pieces
  are one result spanning the whole street. **Select** on a street, address or landmark
  flies there and draws a rectangle around it, ready to fetch.
- GLB and glTF export, for Blender, Unity, Unreal, Sketchfab or the web: the 3D view as it
  looks (not the print), from two buttons on the export card, no preview needed. The
  layers that are on, with the edits and height multipliers, in meters with y up; the
  ground's relief shading (rock on steep slopes, darker hollows) baked into its texture,
  trees as one mesh, the credits in the file.
- Bug reports: the "?" button in the panel's header opens "Found a bug? Report it". Send
  saves a zip with the message, a screenshot of the map or 3D view, and what's needed to
  reproduce it (the selection, the view and its camera, layers, multipliers, edits and
  export settings, the data summary and sources, the browser, the graphics card, recent
  errors), and opens an email with the message to attach it to.

### Changed

- Big selections are requested in parts sized by what's in them, not by their area: the
  answer's size is predicted from everything in the quick tile data, and a part holds up to
  about 30 MB and 100 km² (10 km² before, whatever was in it). Each request costs about
  44 s of server queue, so sparse ground goes much faster: a 42 km² rectangle on the Isle
  of Coll is one request instead of eight. A part the server gives up on ("too much data")
  is split in two and asked again, instead of the fetch failing.
- Once the detailed data is in, "Open 3D view" is the main button, right under the status
  line, and fetching again is a secondary "Fetch again"; on the map the layer list folds
  into a line of counts (it opens in the 3D view).
- Opening the 3D view shows a bar with what it's building (the terrain, the buildings, the
  trees), instead of a page that looks stuck on a big city.
- Downloading an STL or 3MF shows its progress and the time left on the Download button.
  The result says when small pieces are kept as separate parts (slicers handle that), and
  why the file has more triangles than the preview.
- The search box's placeholder fits: "Place, address or landmark…".
- Search ranks the best-known place first: one mapped in many pieces, with an outline, or
  tagged for tourists ("Preikestolen" finds the cliff, not a namesake hill), and a name
  made only of the words typed ("Big Ben London": the clock, not a golf course). A landmark
  is shown with a kilometer or two around it, not a close-up of its roof, and a pin stays
  on the place picked. The button on each result says "Select area".
- The download's progress says one thing at a time: the time left while there's an
  estimate, otherwise the time so far; a busy server is "the map data server is busy",
  its name in brackets. Once the detailed data is in, the caption says the terrain and the
  sea floor are being finished.
- The data panel's credit line names the sources actually used (national LiDAR, the sea
  floor's source), terrain below sea level reads "from 370 m below to 705 m above sea
  level", and where there's sea, it says to switch Water off to see the sea floor.
- STL's description no longer promises a single solid: "everything that touches is joined
  into one watertight solid". The GLB/glTF note says the height multipliers are in the
  file, and to set them to ×1 for true heights.
- The 3D view's objects (buildings, structures, bridges, boats, trees, forests) are built in
  a background worker: opening a big city and every edit after it (a delete, a resize) no
  longer freeze the page. Central Paris (10,000 buildings): an edit froze the page 2.9 s,
  now at most 0.4 s.
- Files are named after the place: the landmark searched for, if it's in the area, and the
  town ("map2stl-colosseum-roma.stl"), not coordinates.
- The "?" is a help menu: the user guide, or a bug report.
- The large-area warning says how long the download takes and how wide the narrowest
  printable detail is at the print's size.
- Where a selected building overlaps others (the London Eye and its supports), "Delete all"
  deletes them together; the layer counts follow deletes and restores.
- A click a few pixels off a thin object (a mast, a wheel's rim) still selects it.
- The data panel says how far apart the sea depths are measured, and that harbour basins
  narrower than that come out flat.
- The official 3D model choice is two buttons, this building or every building here, with
  a progress bar while the models load.
- The 3D view draws only when something changes (the camera, an edit, a layer), instead of
  every frame: a big city no longer keeps the computer busy while you look at it. Its
  first view aims at the middle of the terrain's heights, from above the highest point.
- Water is carved into the print one step deep, like streets (it was two).
- Forests print with crowns at a real crown's size, whatever the thinnest detail; when the
  crowns come out narrower than the nozzle, the forest shows in red in the export preview,
  and the warning says how wide they print, as for any object.
- The download estimate learns from every part of a fetch, not only from fetches made of
  one.
- The download estimate starts over when a request is retried or moves to another
  server, instead of running out and saying "Taking longer than usual" for minutes. Its
  formula held up on 162 logged fetches (44 s plus 1.9 s per 1,000 buildings when the
  first server answers); what it missed were the failovers.
- The overpass.private.coffee mirror is no longer used: it answered 1 request in 38, and
  let the rest run into the 100 s timeout before the next server was tried.

### Fixed

- Big landmarks no longer stand in hills of their own shape: the worldwide terrain tiles
  take the top of a large building for the ground (the Colosseum's arena filled up, St.
  Peter's buried to the drum). Under each big building the ground now goes down to the
  level around it (national LiDAR, bare ground already, is left as it is).
- Multipolygons with their rings mistagged (the Colosseum's outer wall: two "outer" rings)
  are read as map renderers draw them: a ring inside another is a hole.
- The sea floor eases from the coastline down to its depth over one depth cell, instead of
  dropping in a wall at the coast; no more thin fins along the tile's edge with Water off.
- The map's preview of the fetched data is cut to the selection, like the 3D view.
- The selected object's card no longer slides under the export card: the column scrolls.
- Very tall terrain (a fjord, a mountain) opens far enough back to show the whole tile.

- The 3D view's camera can no longer go under the tile: drags pan along the ground (they
  could move the orbit's center below it), the camera stays above the terrain under it, the
  orbit's center stays inside the selection, and zooming stops short of the ground.
- Bridge decks slope from one bank's height to the other's, instead of staying level with
  the higher one: a bridge from a hillside to a low causeway (Rundebrua, Norway) no longer
  ends in the air.
- Flat strips sticking out from a free shape's edge, at the base (in the 3D view and the
  print): points cut along the outline are now shared between neighboring grid triangles,
  and the base follows the outline where it pinches through a grid cell.

## [0.7.0] - 2026-10-25

Real terrain, real forests and real buildings: national LiDAR height models (Norway, the
Netherlands, England, the US), forests as a canopy of treetops at their measured height,
the sea floor at its real depths worldwide, boats at the piers, and Switzerland's official
3D buildings in place of OpenStreetMap's blocks.

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
- Official 3D building models, where a country publishes them openly: Switzerland's
  swissBUILDINGS3D (swisstopo) first, with measured roof shapes and heights. Select a
  building and "Use the official 3D model", or use them for every building in the area at
  once. They come in real coordinates, so they go exactly in place (no fitting); each goes
  to the OSM building holding most of it, and an OSM building another's model covers (the
  two split blocks differently) gives way. Models reaching past the selection are left out.
  Remove brings the OSM building back; the export credits swisstopo. Read from swisstopo's
  3D Tiles (b3dm, Draco-compressed), which the browser loads directly.
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
