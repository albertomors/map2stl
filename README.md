# map2stl

**Turn any place on Earth into a 3D print.**

Want your fav city on the shelf? Or on the wall? Maybe a real-world map for your next board game or tabletop campaign? Pick a city, select the area, customize it, and 3d-print it.

![A 3D tile of Vatican City: St. Peter's Basilica and Square, gardens, trees and the surrounding streets](docs/screenshots/vatican-01-3d-view.png)

## How it works

1. **Pick a city and select the area** you want to print.
2. **Shape it in 3D**: remove what you don't want, make your favorite building stand out.
3. **Export and print** *(STL / 3MF, coming next)*.

![Selecting an area on the map](docs/screenshots/vatican-02-select-area.png)

## Features

- **No API keys, no account.** Open data only: OpenStreetMap, OpenFreeMap, AWS Terrain
  Tiles.
- **Real 3D data.** Building heights, roof shapes and colors, landmarks, bridges, terrain,
  water, parks, single trees.
- **Editable 3D preview.** Delete, resize or stretch any building, tree or bridge. Make the
  cathedral twice as big if you like.
- **Ready to print** *(coming next)*. Exact tile edges, a solid base, STL and multi-color
  3MF.

![St. Peter's Basilica selected and enlarged in the 3D preview](docs/screenshots/vatican-06-edit-building.png)

![Store Ådnøy, Norway: LiDAR terrain with rock outcrops, forests at their measured height, lakes and the fjord](docs/screenshots/adnoy-01-lidar-forests.png)

![Zurich's old town with swisstopo's official 3D buildings: the Grossmünster, roofs with dormers, the river and tram lines](docs/screenshots/zurich-01-swissbuildings3d.png)

## Run it

```sh
git clone https://github.com/albertomors/map2stl.git
cd map2stl
npm install
npm run dev     # http://localhost:5173
```

Needs [Node.js](https://nodejs.org) 20.19+.

## Credits

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL):
prints made with map2stl must credit them. Tiles by [OpenFreeMap](https://openfreemap.org),
search by [Photon](https://photon.komoot.io), detailed data from the
[Overpass API](https://overpass-api.de), terrain from
[AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/). LiDAR terrain from
[Kartverket](https://www.kartverket.no) (CC BY 4.0), [AHN](https://www.ahn.nl) (CC0), the
[Environment Agency](https://environment.data.gov.uk) (OGL) and
[USGS 3DEP](https://www.usgs.gov/3d-elevation-program); sea depths from
[EMODnet Bathymetry](https://emodnet.ec.europa.eu/en/bathymetry) (CC BY 4.0) and
[NOAA ETOPO 2022](https://www.ncei.noaa.gov/products/etopo-global-relief-model); 3D
buildings from [swisstopo](https://www.swisstopo.admin.ch) (swissBUILDINGS3D). Exports credit
the sources they use. Built with [MapLibre](https://maplibre.org) and
[Three.js](https://threejs.org).

More: [user guide](docs/guide.md) · [architecture](docs/architecture.md) ·
[roadmap](ROADMAP.md) · [changelog](CHANGELOG.md)

## Support

Like it? Found it useful? [![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-000000?style=flat&logo=ko-fi&logoColor=white)](https://ko-fi.com/W7A529A7ZI)
