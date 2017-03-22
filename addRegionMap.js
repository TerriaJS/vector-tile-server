// JS script to automate conversion of shapefile region map to vector tile region map for Tessera server
//
//    node addRegionMap.js addRegionMapConfig.json
//

// This script must:
// 1. Convert the given shapefile to the correct projection [x]
// 2. Create an FID field                                   [x]
// 3. Generate mbtiles & hybrid config files and data.xml   [x]
// 4. Generate a regionMapping.json entry                   [x]
// 5. Generate a/multiple region_maps-... .json             [x]
// 6. Append region map to config.json                      [x]

// Input needs to tell us:
// - Where the shapefile is
// - What the layerName is
// - If tiles should be generate tiles
// - What zoom level tiles should be generated to
// - Whether the shapefile already has a suitable FID

// Use JSON:
config = {
    "layerName": "okcounties",
    "shapefile": "okcounties.shp",
    "generateTilesTo": 10,
    "addFID": true,
//    "uniqueIdProp": undefined,                     // Defaults to FID, but must be set when addFID is false
    "nameProp": "name",
    "server": "http://127.0.0.1:8000/okcounties/{z}/{x}/{y}.pbf",      // May need to be corrected
    "serverSubdomains": [],

    "regionMappingEntries": {                        // Probably should be renamed
        "okcounty": {
            "regionProp": "county",
//            "disambigProp": "state",               // disambigProp not needed
//            "disambigRegionId": "STE_NAME",
            "aliases": [
                "okcounty"
            ],
            "description": "Oklahoma Counties"
        },
        "okcounty_name": {
            "regionProp": "name",
//            "disambigProp": "state",
            "aliases": [
                "okcounty_name"
            ],
            "description": "Oklahoma Counties"
        },
    }
}

// Use path.resolve(path.dirname(regionMapConfigFile), shapefile) to get path of shapefile


'use strict';

var exec = require('child_process').exec;

var when = require('when');
var nodefn = require('when/node');
var fs = require('fs');
var path = require('path');
var shapefile = require('shapefile');
var merc = new (require('sphericalmercator'))();

// Promise versions of node-style functions
fs.writeFilePromise = nodefn.lift(fs.writeFile);
fs.readFilePromise = nodefn.lift(fs.readFile);
var execPromise = nodefn.lift(exec);

var const_minZ = 0;
var const_headers = { "Cache-Control": "public,max-age=86400" };

var steps = {
    reprojection: true,
    tileGeneration: true,
    config: true
}


var dataDir = 'data/';
var tempDir = 'temp/';
var outputDir = 'output_files/';
var reprojected_shapefile_dir = 'epsg4326_shapefiles/'
var configJsonDir = 'config/'
var gdal_env_setup = '';// '"C:\\Program Files\\GDAL\\GDALShell.bat" && ';
var regionMapConfigFile = process.argv[2];


// From Mozilla MDN. Polyfill for old Node versions
if (typeof Object.assign != 'function') {
  (function () {
    Object.assign = function (target) {
      if (target === undefined || target === null) {
        throw new TypeError('Cannot convert undefined or null to object');
      }

      var output = Object(target);
      for (var index = 1; index < arguments.length; index++) {
        var source = arguments[index];
        if (source !== undefined && source !== null) {
          for (var nextKey in source) {
            if (source.hasOwnProperty(nextKey)) {
              output[nextKey] = source[nextKey];
            }
          }
        }
      }
      return output;
    };
  })();
}


function determineNameProp(properties) {
    // Adapted from Cesium ImageryLayerFeatureInfo.js (https://github.com/AnalyticalGraphicsInc/cesium/blob/1.19/Source/Scene/ImageryLayerFeatureInfo.js#L57)
    var namePropertyPrecedence = 10;
    var nameProperty;

    for (var key in properties) {
        if (properties.hasOwnProperty(key) && properties[key]) { // Is this logic bad? properties[key] may be 0 or null
            var lowerKey = key.toLowerCase();

            if (namePropertyPrecedence > 1 && lowerKey === 'name') {
                namePropertyPrecedence = 1;
                nameProperty = key;
            } else if (namePropertyPrecedence > 2 && lowerKey === 'title') {
                namePropertyPrecedence = 2;
                nameProperty = key;
            } else if (namePropertyPrecedence > 3 && /name/i.test(key)) {
                namePropertyPrecedence = 3;
                nameProperty = key;
            } else if (namePropertyPrecedence > 4 && /title/i.test(key)) {
                namePropertyPrecedence = 4;
                nameProperty = key;
            }
        }
    }
    return nameProperty;
}

function processLayer(c) {
    var geoJsonFile = tempDir + c.layerName + '.geojson';
    var mbtilesFile = dataDir + c.layerName + '.mbtiles';
    var layerRectangle;
    var maxDetail = (32-c.generateTilesTo); // For tippecanoe
    var shapefile_loc = path.resolve(path.dirname(regionMapConfigFile), c.shapefile).replace(/ /g, '\\ ');

    return when().then(function() {
        // Reproject to EPSG:4326 and add an FID
        if (!steps.reprojection) return;
        return execPromise('ogr2ogr -t_srs EPSG:4326 -clipsrc -180 -85.0511 180 85.0511 -overwrite -f "ESRI Shapefile" ' + reprojected_shapefile_dir + c.layerName + '_clean.shp ' + shapefile_loc + ' -dialect SQLITE -sql "SELECT ST_MakeValid(geometry) as geometry, * FROM ' + c.layerName + '"').then(function () {
            var fidCommand = c.addFID ? ' -sql "select FID,* from ' + c.layerName + '_clean"' : '';
            return execPromise(gdal_env_setup + 'ogr2ogr -t_srs EPSG:4326 -clipsrc -180 -85.0511 180 85.0511 -overwrite -f "ESRI Shapefile" '
            + reprojected_shapefile_dir + c.layerName + '.shp ' + reprojected_shapefile_dir + c.layerName + '_clean.shp ' + fidCommand);
        });
    }).then(function() {
        // Iterate over new shapefile and generate region_map json (FID -> property) files
        if (!steps.config) return;

        // Get all the columns
        var columns = {};
        if ('regionIdColumns' in c) {
            columns = c.regionIdColumns;
        } else {
            Object.keys(c.regionMappingEntries).forEach(function (key) {
                if (c.regionMappingEntries[key].regionProp) {
                    columns[c.regionMappingEntries[key].regionProp] = true;
                }
                if (c.regionMappingEntries[key].disambigProp) {
                    columns[c.regionMappingEntries[key].disambigProp] = true;
                }
            })
        }

        var regionidJSONs = Object.keys(columns).map(function(column) {
            return {
                "layer": c.layerName,
                "property": column,
                "values": []
            };
        });

        var reader = shapefile.reader(reprojected_shapefile_dir + c.layerName + '.shp');
        var nextRecord = function() { return nodefn.call(reader.readRecord.bind(reader)); };
        return nodefn.call(reader.readHeader.bind(reader)).then(function(header) {
            layerRectangle = header.bbox;
            return nextRecord();
        }).tap(function(record) {
            // Tap the first record and use it to set nameProp
            if (c.nameProp === undefined) {
                c.nameProp = determineNameProp(record.properties);
                // c.nameProp may still be undefined if no suitable property was found
            }
        }).then(function(firstRecord) {
            // Iterate over records until shapefile.end
            return when.iterate(nextRecord, function(record) { return record === shapefile.end; }, function(record) {
                // With every record, get the value of each property required
                regionidJSONs.forEach(function(json) {
                    json.values.push(record.properties[json.property]);
                });
            }, firstRecord);
        }).then(function() {
            // Save regionid json files
            return when.map(regionidJSONs, function(json) {
                var outFile = outputDir + 'region_map-' + json.layer + '_' + json.property + '.json'
                console.log('Writing a regionids file to ' + path.resolve(outFile));
                return fs.writeFilePromise(outFile, JSON.stringify(json));
            });
        });
    }).then(function() {
        if (steps.config && 'regionMappingEntries' in c) {
            // Write out regionMapping-layerName.json
            var regionWmsMap = {}
            var promises = Object.keys(c.regionMappingEntries).map(function(key) {
                var configEntry = c.regionMappingEntries[key];
                var regionMappingEntry = {
                    layerName: c.layerName,
                    server: c.server,
                    serverType: "MVT",
                    serverSubdomains: c.serverSubdomains,
                    serverMinZoom: const_minZ,
                    serverMaxNativeZoom: c.generateTilesTo,
                    serverMaxZoom: 28, // For tippecanoe generated vector tiles so that the maximum zoom tile still has detail 4 (28 == 32 - 4)
                    bbox: layerRectangle,
                    uniqueIdProp: c.uniqueIdProp !== "FID" ? c.uniqueIdProp : undefined, // Only set if not FID
                    regionProp: configEntry.regionProp,
                    aliases: configEntry.aliases,
                    nameProp: c.nameProp,
                    description: configEntry.description,
                    regionIdsFile: 'data/regionids/region_map-' + c.layerName + '_' + configEntry.regionProp + '.json',
                };

                if (configEntry.disambigProp) {
                    regionMappingEntry.disambigProp = configEntry.disambigProp;
                    regionMappingEntry.disambigRegionId = configEntry.disambigRegionId;
                    regionMappingEntry.regionDisambigIdsFile = 'data/regionids/region_map-' + c.layerName + '_' + configEntry.disambigProp + '.json';
                }

                regionWmsMap[key] = regionMappingEntry;

                // Also make a csv to test the layer in nationalmap
                var testCsvFile = outputDir + 'test-' + c.layerName + '_' + configEntry.regionProp + '.csv';
                console.log('Writing TerriaMap test csv file to ' + path.resolve(testCsvFile));
                return execPromise('ogr2ogr -overwrite -f csv ' + testCsvFile + ' ' + shapefile_loc + ' -dialect sqlite -sql "SELECT ' + configEntry.regionProp + ' as ' + configEntry.aliases[0] + ', random() % 20 as randomval FROM ' + c.layerName + '"');
            });

            var outFile = outputDir + 'regionMapping-' + c.layerName + '.json';
            console.log('Writing a regionMapping.json file to ' + path.resolve(outFile));
            return when.join(promises, fs.writeFilePromise(outFile, JSON.stringify({regionWmsMap: regionWmsMap}, null, 4)));
        }
    }).then(function() {
        if (c.generateTilesTo == null || !steps.tileGeneration) return;
        // Generate mbtiles

        // Using Tippecanoe: // -s_srs EPSG:4326 -t_srs EPSG:4326
        // Convet to GeoJSON, then use Tippecanoe to generate tiles
        return execPromise(gdal_env_setup + 'ogr2ogr -overwrite -f GeoJSON ' + geoJsonFile + ' ' + reprojected_shapefile_dir + c.layerName + '.shp').catch(function(err) {
            // Don't error out if the GeoJSON file has already been created
            if (err.message.match("GeoJSON Driver doesn't support update.")) {
                console.warn('GeoJSON file ' + geoJsonFile + ' already exists. Delete this and run again to replace');
            } else {
                throw err;
            }
        }).then(function() {
            // Use Tippecanoe with the following options:
            // -q = quiet
            // -f = force overwrite
            // -P = parallel mode
            // -pp = don't split complex polygons
            // -pS = don't simplify the max zoom level (max zoom level tiles are exact geometry, for overzooming)
            // -l str = mbtiles layer name
            // -z # = maximum zoom
            // -d # = detail at max zoom level (maximum allowed is 32 - max zoom, probably because Tippecanoe uses unsigned 32 bit integers)
            return execPromise('tippecanoe -q -f -P -pp -pS -l ' + c.layerName + ' -z ' + c.generateTilesTo + ' -d ' + maxDetail + ' -o ' + mbtilesFile + ' ' + geoJsonFile + ' > /dev/null');
        });
    }).then(function() {
        // Add/overwrite layerName.json to configJsonDir
        var configJson = {};
        configJson['/' + c.layerName] = {source: "mbtiles:///etc/vector-tiles/" + mbtilesFile, headers: const_headers};
        return fs.writeFilePromise(configJsonDir + c.layerName + '.json', JSON.stringify(configJson, null, 4));
    /*}).catch(function(err) {
        console.log('Layer ' + c.layerName + ' failed with error: ' + err);
        throw err;
    */
    });
}



var config = JSON.parse(fs.readFileSync(regionMapConfigFile, 'utf8'));

processLayer(config).then(function() {
    process.exit(0);
}).catch(function(err) {
    console.error(err);
    process.exit(1);
});
