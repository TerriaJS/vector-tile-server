# server-config
Configuration, data and helper scripts for [Tessera server](https://github.com/mojodna/tessera). Designed to work as a vector tile server for [TerriaJS](https://github.com/TerriaJS/terriajs)

## Steps to install:
1. Clone from github
2. Get original shapefiles (on regionmap-dev, cannot use the ones retrieved by WFS from Geoserver as these have attributes with bad type information)
3. Run `npm install`
4. Run `node setup.js /path/to/regionMapping.json`
5. Run `server.sh`

## Helper scripts:
- setup.js: reprojects shapefiles in `geoserver_shapefiles/` corresponding to layers in a given regionMapping.json and generates tiles and config files for each layer.
- server.sh: runs the server with the generated config file

## Node versions:
This package depends on Mapnik which downloads pre-built binaries on install. Pre-built binaries are not available from Mapnik for all Node versions, so some Node versions may not be supported (see [node-mapnik](https://github.com/mapnik/node-mapnik#installing) for more information). The Node versions that this package has been tested with are: Node v5.1.0, v0.12.9 and v0.10.42.
