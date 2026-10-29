# Roadmap

Open work only: built items move to the README and CHANGELOG.

## Milestone 0.8: ready to share

What the app needs before strangers use it, all without a server of our own.

### Downloads for the README's gallery

The README shows six places (Yosemite, Geiranger, Portofino, Zurich, Manhattan, the Golden
Gate). Next: each with its selection as a link that opens it in the app, and its GLB to
download, made by a script driving the app so it can be redone after each release.

### General improvements from agents trying the app

A suite of agents that run the app in a real browser (Playwright) the way a newcomer
would, each with a task and no instructions: "print the Colosseum", "a 5 km hexagon of
your hometown", "export a mountain for Blender", "delete a building and restore it",
"a model of a harbor with the sea floor". Each one reports, with screenshots, where it
hesitated, what it misread, what failed or took too long, and what it expected to find
and didn't. A last agent ranks the findings across runs (what several agents tripped on
first), and the fixes become this milestone's general improvements: wording, layout,
defaults, error messages, missing feedback. Rerun after the fixes, and before each release.

## More official 3D buildings

Ongoing, added to as sources turn up: swapping the OSM approximation for something
better, as swissBUILDINGS3D in Switzerland. Google's photorealistic tiles can't be used
(their terms forbid extracting them), and no open worldwide photogrammetry exists. Next:
the Netherlands' 3DBAG (its servers didn't answer when this was built), Japan's PLATEAU,
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
