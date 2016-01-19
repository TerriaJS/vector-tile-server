# server-config
Configuration, data and helper scripts for [Tessera server](https://github.com/mojodna/tessera)

## Steps to install:
1. Clone from github
2. Run npm install
3. Modify config.json
3. Run server.sh

## Helper scripts:
- save_tiles.js:  generates mapnik/mapbox vector tiles at certain zoom levels within a rectangle from a mapnik XML file and saves the generated tiles to a mbtiles data store
- server.sh: runs the server with the included config file and a test data set
- setup.py: downloads shapefiles corresponding to region maps defined in a given regionMapping.json and generates tiles and config files for each region map.
