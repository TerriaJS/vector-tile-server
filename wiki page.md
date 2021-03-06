*Region mapping* is the process of matching a value in a CSV file to a pre-defined boundary, such as a postcode, local government area or electorate. The allowed boundaries for a given TerriaJS instance are given in a file such as `wwwroot/data/regionMapping.json`.

## Basic methodology for distinction between files included in the repo and files in the data archive:

- All files included in the repo should work with any shapefile that defines a region map (a shapefile with only – or predominately – polygon geometry which define regions in features which can be uniquely identified by FID or some other identifier)
- Files from the archive are for serving nationalmap's specific region maps

# Method for setting up standard vector tile server:

## Download and test the server

1. Checkout `mapbox_vt_region_provider` branches of nationalmap and TerriaJS

1. Rebuild nationalmap

1. Clone the server from Github:
    `git clone https://github.com/TerriaJS/server-config`

2. Install dependencies of the server:
    `npm install`

3. Extract the data folder (called `data2/`) from the provided archive (https://dl.dropboxusercontent.com/u/18091071/MVTResources.zip) into the root directory of the repo

3. Build the config files with `node setup.js regionMapping.json`

4. Run the server `./server.sh`

5. Test the server using `SA2`, `SA4` and `WORLD_BORDERS` region maps. Other region types will use WMS (so you can compare the two easily).
    - ABS has 2011 Census data for testing WMS (`SA3`) and MVT (`SA2`, `SA4`)
    - The `test` init file has `Country Regions` and `Droughts by Country` which both use `WORLD_BORDERS`

## If you want to re-generate shapeindex files and mbtiles cache

1. Get the original geoserver shapefiles (or the reprojected ones in the data archive, just not the ones from GeoServer WFS requests)

2. Reproject the shapefiles to EPSG:3857

2. Compile Mapnik from source (need to checkout and build commit 2b725dd, since the binary format changes not long after that commit and that wouldn't be compatible).

    _Actually, it looks like this issue has been solved since the bug fix and the binary change are in Mapnik v3.0.10, which is the binary version included in node-mapnik 3.5.0, which is the version the latest tilelive-bridge uses. This means I can update to the new binary format of shapeindex and not need to compile Mapnik from source (I think)._

3. Generate shapeindexes `find . -name *.shp -print0 | xargs -0 shapeindex` or within `setup.js` if node-mapnik shapeindex is used

4. Run `save_tiles.js` from `setup.js`

# Method for adding custom region maps:

## Prepare the shapefiles

  * One shapefile should contain all the polygons.
  * There should be a `FID` (case-sensitive) attribute, numbering each polygon starting from 0. If no FID attribute is present, use ogr2ogr to add it:

    `ogr2ogr -f "ESRI Shapefile" precincts-fid.shp precincts.shp -sql 'select FID,* from precincts'`

    If you have several files to process, use a line like this:

    `for i in GCCSA IARE ILOC IREG SOS SOSR SUA UCL; do ogr2ogr -f "ESRI Shapefile" ${i}_2011_AUST_fid.shp ${i}_2011_AUST.shp -sql 'select FID,* from '"${i}_2011_AUST"; done`

  * There should be an attribute containing the identifiers you wish to match against (eg, for postcode boundaries, a `postcode` attribute containing the 4 digit codes themselves).
  * The projection should be EPSG:4326 (unprojected lat/long on WGS84).
  * **Why use EPSG:4326? Is this something that GeoServer works well with, or is it something WebMapService needs, or is it for convenience for Cesium, or something else?**
  * Vector tile server prefers the shapefile in EPSG:3857 (or at least I've written it to use that...)

## Add as a new layer

This functionality hasn't really been written yet, but my `setup.js` could be adapted to help

Things we have from the user:
- Shapefile of new region map
- data.xml template

Things we need to get server-side:
- Specific data.xml
- Add layer to config
- Shapeindex
- Tiles generated
- hybrid.json

`setup.js` can do all of those

Things we need to get client-side:
- The `region_map-*.json` (Is this needed? If the properties come in the vector tile, we won't need these as long as the regionProp and disambigProp are in the vector tile)
- An entry in regionMapping.json (which can be generated by `setup.js` from a WMS equivalent regionMapping.json entry)

Method would look a little like:

1. Write up the regionMapping.json entry (like below)
2. Give the shapefile and the regionMapping.json entry to a nodejs script (say `make_region_map.js`). The script should have the option of generating and saving tiles to a certain zoom, or generating on-the-fly
3. Modify `wwwroot/data/regionMapping.json`, adding the section output by the nodejs script


## Configure the regions in your TerriaJS-based map

Modify `wwwroot/data/regionMapping.json`. Add a section like this:

        "SA4": {
            "layerName":"region_map:FID_SA4_2011_AUST",
            "server": "http://geoserver.nationalmap.nicta.com.au/region_map/ows",
            "regionProp": "SA4_CODE11",
            "aliases": ["sa4_code", "sa4_code", "sa4"],
            "description": "Statistical Area Level 4"
        },

* `"SA4"`: this identifier does not serve any machine-readable purpose outside this file.
* `layerName`: the WMS layer of your new regions, including the workspace.
* `server`: the URL of your GeoServer, up to and including `/ows`.
* `regionProp`: the name of the attribute containing region identifiers that will be matched against (case-sensitive)
* `aliases`: alias of CSV column header names that will be recognised as matching this kind of feature. Must be lowercase.
* `description`: May be used in GUI elements and error messages.
