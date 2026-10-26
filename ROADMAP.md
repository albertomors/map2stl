# Roadmap

Open work only: built items move to the README and CHANGELOG.

## Milestone 0.8: ready to share

What the app needs before strangers use it, all without a server of our own.

### Fit the request-size prediction on real use

Requests are now planned by the answer's predicted size (about 1 KB per building, 3 KB per
road, 0.5 KB per other feature in the quick tile data), up to 30 MB and 100 km² each, and
a request the server gives up on is split in two and asked again. The weights are a first
fit on whole fetches, and run low on sparse ground (the Isle of Coll: 261 KB predicted,
745 KB received, likely the coastline and sea). The dev server now logs every request with
its prediction (debug/parts.jsonl): once there are enough, refit the weights (maybe a fixed
cost per request, the sea and big polygons counted by size) and the 30 MB and 100 km²
limits.

### A gallery in the README

A set of famous places, each shown twice side by side: the 3D view, and its export preview
(the model exactly as it prints). Chosen to show what the app does well: a landmark
(the Colosseum, the Eiffel Tower), a dense old town (Venice), a mountain (the Matterhorn,
with LiDAR terrain), a harbor with the sea floor (Sydney), a bridge (the Golden Gate). Each
with its selection, so anyone can make the same one, and the GLB to download. Made with the
app itself (a script driving it), so it can be redone after each release.

### General improvements from agents trying the app

A suite of agents that run the app in a real browser (Playwright) the way a newcomer
would, each with a task and no instructions: "print the Colosseum", "a 5 km hexagon of
your hometown", "export a mountain for Blender", "delete a building and restore it",
"a model of a harbor with the sea floor". Each one reports, with screenshots, where it
hesitated, what it misread, what failed or took too long, and what it expected to find
and didn't. A last agent ranks the findings across runs (what several agents tripped on
first), and the fixes become this milestone's general improvements: wording, layout,
defaults, error messages, missing feedback. Rerun after the fixes, and before each release.

## More countries

Ongoing, added to as sources turn up: swapping the OSM approximation for something
better. Google's photorealistic tiles can't be used (their terms forbid extracting them),
and no open worldwide photogrammetry exists, so:

- **Better terrain in more countries:** national LiDAR terrain models (about 1 m), country by
  country where the service lets a browser load it. Done: Norway, the Netherlands, England,
  the US. Left: Switzerland (swissALTI3D: only per-kilometer files in the Swiss grid, no
  service cutting out an area), Denmark (needs an access token), and others as found.
  Sampled to what the print can hold: at 150 mm for 2 km, 2–5 m already shows every ridge a
  nozzle can make. Everywhere else falls back to today's tiles (about 10–30 m), and the
  panel says which source the terrain (and so the print) uses. Not Copernicus GLO-30: it's
  a surface model, with buildings and tree canopy in its heights, so the ground would bump
  up under every city block. FABDEM (GLO-30 cleaned of them) is non-commercial only, and
  served as archives a browser can't read.
- **More official 3D buildings:** Switzerland (swissBUILDINGS3D) is done. Next the
  Netherlands' 3DBAG (its servers didn't answer when this was built), Japan's PLATEAU,
  German states, New York, Helsinki, Vienna, Zurich's city model; where a source isn't 3D
  Tiles, a CityJSON reader. Per source: an endpoint a browser can load, and the license.

## Faster, more reliable data

Overpass is the most complete OSM source but the slowest part of the app (40–100 s for a
city center, and the public servers are often busy).

- Overture Maps buildings to fill gaps in OSM heights (cloud GeoParquet, no API).

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

## Later

- Sea when the selection is entirely water, or the coast is broken near it (today: land).
