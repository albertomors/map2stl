# Roadmap

Open work only: built items move to the README and CHANGELOG.

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
