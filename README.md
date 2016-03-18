# Vector-Tile-Server
This sets up a [Tessera server](https://github.com/mojodna/tessera) for use as a vector tile server for [TerriaJS](https://github.com/TerriaJS/terriajs). It contains configuration, data and helper scripts. 

## Packages involved:
This server uses the Tessera server and tilelive module architecture. It uses various customised forks and specific modules. These are:
- Tessera – forked to allow for forked dependencies, and also stripped down (leaflet map removed and static page serving commented out)
- tilelive-bridge – forked to return 0 length buffer instead of an error when a vector tile is empty
- tilelive-hybrid – a new tilelive module that serves tiles from different tilelive sources based on the zoom level
- tilelive-cache – forked to ask tilelive-hybrid sources whether they want a tile cached or not and to change the cache duration from 6 hours to 1 year

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
