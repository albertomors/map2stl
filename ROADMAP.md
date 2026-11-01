# Roadmap

Open work only: built items move to the README and CHANGELOG.

## Milestone 0.9: bigger prints, better buildings

### More official 3D buildings

Swapping the OSM approximation for measured models. Google's photorealistic tiles can't be
used (their terms forbid extracting them), and no open worldwide photogrammetry exists.
Per source: an endpoint a browser can load (CORS), and the license.

Fit the reader as it is, to add next:

- **Luxembourg** (ACT, the whole country, LoD2.2, CC0): its tiles are found over the
  capital.
- **Zaragoza** (the city's LoD2, b3dm): to be tried again, its server dropped the
  connection.
- **Auvergne-Rhône-Alpes** (CRAIG, Licence Ouverte 2.0): about 15 urban areas (Clermont,
  Saint-Étienne, Valence, Vichy, the Isère…), each its own tileset with no common root: a
  source holding a list of tilesets.
- **Slovenia** (GURS): fits, but it's the public viewer's own API, not a published
  service, and how much of the country it covers is unclear.

An I3S reader: many cities publish their official models only as Esri scene layers (I3S
1.7+: JSON node pages, oriented boxes in lon/lat or Web Mercator, Draco meshes with a
feature index per vertex), keyless and open to browsers. One reader unlocks about 12:

- Estonia (the whole country, LoD2; EPSG:3301 coordinates, CC BY 4.0), Riga, Vilnius,
  Zagreb (one layer per district, open licence), Prague (IPR's own layer on ArcGIS Online,
  `Budovy_3D_WSL1`, CC BY), Vienna (SynerGIS's copy of the city's LoD2; license to be
  confirmed, the city's own is CC BY 4.0), Munich (Esri Deutschland's, from the Bavarian
  survey's LoD2, CC BY 4.0).
- Washington DC (2024, CC BY 4.0), Ottawa (2026, LoD2), Hong Kong (Esri China's copy of
  LandsD's buildings), Wellington (per suburb or ward, CC BY 4.0), Adelaide (the CBD), Perth.
- Calgary (the whole city): its open-data terms and the scene layer's "all rights
  reserved" disagree; to be cleared first. Licenses for Ottawa, Adelaide and Perth to be
  checked too.

A CityGML reader: some publish their models only as CityGML files per square kilometer or
county, large and in projected coordinates, read in a worker and cut to the selection:

- Berlin (LoD2 per km², EPSG:25833, dl-de/zero-2-0; its server lets a browser in),
  North Rhine-Westphalia (LoD2 per km², EPSG:25832, plain GML a browser can read in ranges;
  56 MB for a km² of central Cologne), Montreal (LoD2 tiles, CC BY 4.0), Brussels (UrbIS 3D,
  also GeoJSON), Poland (LoD2 in 10 voivodeships, LoD1 nationwide, zipped per county).
- Their servers' CORS to be checked one by one (Berlin's and NRW's answer; the others
  untested), and zips need unpacking in the browser (fflate, already used for bug reports).

Flat-roofed blocks: where there's no roof model, footprints with measured heights are still
better than OSM's guesses; extruded like OSM buildings, as their height:

- France (IGN's BD TOPO buildings on the Géoplateforme WFS, `BDTOPO_V3:batiment`: height
  and ground altitude, CORS open, Licence Ouverte), New York (NYC Open Data's building
  footprints, roof height in feet, CORS open), Vienna
  (the city's WFS of building bodies, top and ground heights, CORS open, CC BY 4.0), Toronto
  (3D massing, zipped shapefiles), Flanders (3D GRB LoD1, download only), Overture (heights
  worldwide, one PMTiles file a browser can read in pieces; for OSM buildings that have
  none).

Later, once their owners say yes: France's LoD2 (IGN's Bâtiments 3D: its server lets only
IGN's site in, and its terms ask for IGN's agreement; to ask on forum.geocommuns.fr),
Vienna's and Bavaria's own servers (no CORS), Germany's basemap.de (its license allows only
testing).

- **A key for Hong Kong:** its 3D Spatial Data works without a key today, but the API
  documents one (`?key=`), free on request by email to 3dmap@landsd.gov.hk. Ask for one,
  and confirm in the same email that a public web page may use it and that printing the
  buildings is fine, so the app doesn't depend on access that could close.

### Print in pieces: what's left

Built: the grid, the pieces' sizes against the bed, each piece built on its own outline, the
pulled-apart preview, the files, the tabs and pockets. Next:

- **Merge a sliver into its neighbor:** a piece under 15% of a cell (a free shape's odd
  corner, a circle's edge in a fine grid) is flagged; one click should join it to the piece
  beside it (that piece's region becomes two cells).
- **Bowtie keys,** the locking option: a dovetail pocket open at the bottom on each side of a
  cut, and a small key printed apart, pushed in from below, so the pieces hold without glue.
- **Cut lines along streets** rather than through buildings: each cut nudged, within a few
  millimeters, to where it crosses the fewest buildings.

## Publishing

What going public needs.

- Our own Overpass instance (or a commercial extract service): the public servers are too
  busy and slow for many users.
- **Sketchfab without a token:** an approved integration (Sketchfab requires it for
  downloads without each user logging in), with our own server. Until then, a "Log in
  with Sketchfab" button instead of pasting a token needs our app registered with them.
- **Bug reports sent from the app:** a small endpoint (or a form/email service) that
  receives the report's zip and forwards it to the maintainer, instead of the user
  attaching it to an email themselves.
- Deploy as a public site.
