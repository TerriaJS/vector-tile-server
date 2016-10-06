# Vector-Tile-Server
This sets up a [Tessera server](https://github.com/mojodna/tessera) for use as a vector tile server for [TerriaJS](https://github.com/TerriaJS/terriajs). It contains configuration, data and helper scripts. 

## Important notes:
- The server-version.tar.gz packages need to be created on a similar operating system (to the Amazon Linux AMI used)

## Helper scripts:
- setup_layer.py: Script to add shapefile layers. Generates all neccessary TerriaMap and vector-tiles-server files and uploads the server files to S3
- deploy.py: Script to deploy the server to AWS with any subset of the layers available in the S3 bucket, based on past deployments, all newest layers, or a selection of layers

## Packages involved:
This server uses the Tessera server and tilelive module architecture. It uses various customised forks and specific modules. These are:
- Tessera – forked to allow for forked dependencies, and also stripped down (leaflet map removed and static page serving commented out)
- tilelive-bridge – forked to return 0 length buffer instead of an error when a vector tile is empty
- tilelive-hybrid – a new tilelive module that serves tiles from different tilelive sources based on the zoom level
- tilelive-cache – forked to ask tilelive-hybrid sources whether they want a tile cached or not and to change the cache duration from 6 hours to 1 year

## Node versions:
This package depends on Mapnik which downloads pre-built binaries on install. Pre-built binaries are not available from Mapnik for all Node versions, so some Node versions may not be supported (see [node-mapnik](https://github.com/mapnik/node-mapnik#installing) for more information). The Node versions that this package has been tested with are: Node v5.1.0, v0.12.9 and v0.10.42.
