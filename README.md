# map2stl

**Turn any place on Earth into a 3D print.**

Want your neighborhood on the shelf? The old town you fell in love with on holiday? A
real-world map for your next board game or tabletop campaign? Pick a city, select the area,
print it.

![A 3D tile of a city center: cathedral, old town, river, bridges, parks and trees](docs/screenshots/trondheim-01-3d-view.png)

## How it works

1. **Pick a city and select the area** you want to print.
2. **Shape it in 3D**: remove what you don't want, make your favorite building stand out.
3. **Export and print** *(STL / 3MF, coming next)*.

![Selecting an area on the map](docs/screenshots/trondheim-02-select-area.png)

## Features

- **No API keys, no account.** Open data only: OpenStreetMap, OpenFreeMap, AWS Terrain
  Tiles.
- **Real 3D data.** Building heights, roof shapes and colors, landmarks, bridges, terrain,
  water, parks, single trees.
- **Editable 3D preview.** Delete, resize or stretch any building, tree or bridge. Make the
  cathedral twice as big if you like.
- **Ready to print** *(coming next)*. Exact tile edges, a solid base, STL and multi-color
  3MF.

![Enlarging a cathedral in the 3D preview](docs/screenshots/trondheim-06-edit-building.png)

## Run it

```sh
git clone https://github.com/albertomors/map2stl.git
cd map2stl
npm install
npm run dev     # http://localhost:5173
```

Needs [Node.js](https://nodejs.org) 20.19+.

## Support

map2stl is free and has no ads. If it made your favorite place into a print, you can buy me
a coffee:

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-000000?style=flat&logo=ko-fi&logoColor=white)](https://ko-fi.com/W7A529A7ZI)

## Credits

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL):
prints made with map2stl must credit them. Tiles by [OpenFreeMap](https://openfreemap.org),
search by [Photon](https://photon.komoot.io), detailed data from the
[Overpass API](https://overpass-api.de), terrain from
[AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/). Built with
[MapLibre](https://maplibre.org) and [Three.js](https://threejs.org).

More: [user guide](docs/guide.md) · [architecture](docs/architecture.md) ·
[roadmap](ROADMAP.md) · [changelog](CHANGELOG.md)
