# server-config
Configuration, data and helper scripts for [Tessera server](https://github.com/mojodna/tessera). Designed to work as a vector tile server for [TerriaJS](https://github.com/TerriaJS/terriajs)

## Steps to install:
1. Clone from github
2. Run `npm install`
3. Run `node setup.js /path/to/regionMapping.json`
4. Run `server.sh`

## Helper scripts:
- server.sh: runs the server with the included config file and a test data set
- setup.js: downloads shapefiles corresponding to region maps defined in a given regionMapping.json and generates tiles and config files for each region map.

## Node versions:
This package depends on Mapnik which downloads pre-built binaries on install. Pre-built binaries are not available from Mapnik for all Node versions, so some Node versions may not be supported (see [node-mapnik](https://github.com/mapnik/node-mapnik) for more information). The Node versions that this package has been tested with are: Node v5.1.0 and Node v0.12.9
