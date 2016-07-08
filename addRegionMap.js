// JS script to automate conversion of shapefile region map to vector tile region map for Tessera server
//
//    node addRegionMap.js
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
var binary = require('node-pre-gyp');
var shapefile = require('shapefile');
var merc = new (require('sphericalmercator'))();

// Promise versions of node-style functions
fs.writeFilePromise = nodefn.lift(fs.writeFile);
fs.readFilePromise = nodefn.lift(fs.readFile);
var execPromise = nodefn.lift(exec);

var const_minZ = 0;
var const_maxGenZ = 12;
var const_maxZ = Infinity;
var const_headers = { "Cache-Control": "public,max-age=86400" };

var const_parallel_limit = 3;

var steps = {
    reprojection: true,
    tileGeneration: true,
    config: true
}


var dataDir = 'data/';
var tempDir = 'temp/';
var outputDir = 'output_files/';
var shapefile_dir = 'geoserver_shapefiles/';
var reprojected_shapefile_dir = 'epsg4326_shapefiles/'
var configJsonDir = 'config/'
var gdal_env_setup = '';// '"C:\\Program Files\\GDAL\\GDALShell.bat" && ';
var regionMapConfigFile = process.argv[2];

// From mapnik/bin/mapnik-shapeindex.js
//var shapeindex = path.join(path.dirname( binary.find(require.resolve('mapnik/package.json')) ), 'shapeindex');

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


// var data_xml_template = fs.readFileSync('data.xml.template', 'utf8'); // Use shapefile template
// function generateDataXml(layerName, bbox, pgsql_db) {
//     return data_xml_template.replace(/\{layerName\}/g, layerName).replace(/\{bbox\}/g, bbox.join(',')); // Have to use regex for global (g) option (like sed)
// }


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
    var returnData = {};

    return when().then(function() {
        // Reproject to EPSG:4326 and add an FID
        if (!steps.reprojection) return;
        var shapefile_loc = path.resolve(path.dirname(regionMapConfigFile), c.shapefile).replace(/ /g, '\\ ');
        console.log(shapefile_loc);
        console.log('Converting ' + c.layerName + ' to Web Mercator projection');

        // Add an FID if the input config
        var fidCommand = c.addFID ? ' -sql "select FID,* from ' + c.layerName + '"' : '';
        return execPromise(gdal_env_setup + 'ogr2ogr -t_srs EPSG:4326 -clipsrc -180 -85.0511 180 85.0511 -overwrite -f "ESRI Shapefile" '
                           + reprojected_shapefile_dir.slice(0,-1) + ' ' + shapefile_loc + fidCommand);
    }).then(function() {
        // Iterate over new shapefile and generate region_map json (FID -> property) files
        if (!steps.config) return;

        // Get all the columns
        var columns = {};

        Object.keys(c.regionMappingEntries).forEach(function (key) {
            if (c.regionMappingEntries[key].regionProp) {
                columns[c.regionMappingEntries[key].regionProp] = true;
            }
            if (c.regionMappingEntries[key].disambigProp) {
                columns[c.regionMappingEntries[key].disambigProp] = true;
            }
        })

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
            layerRectangle = merc.convert(header.bbox, "WGS84");
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
                return fs.writeFilePromise(outputDir + 'region_map-' + json.layer + '_' + json.property + '.json', JSON.stringify(json));
            });
        });
    }).then(function() {
        // Write out regionMapping-layerName.json
        var regionWmsMap = {}
        Object.keys(c.regionMappingEntries).forEach(function(key) {
            var configEntry = c.regionMappingEntries[key];
            var regionMappingEntry = {
                layerName: c.layerName,
                server: c.server,
                serverType: "MVT",
                serverSubdomains: c.serverSubdomains,
                serverMinZoom: const_minZ,
                serverMaxZoom: (const_maxZ === Infinity ? undefined : const_maxZ), // JSON can't represent Infinity but both server and client default to Infinity
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
        });

        return fs.writeFilePromise(outputDir + 'regionMapping-' + c.layerName + '.json', JSON.stringify({regionWmsMap: regionWmsMap}, null, 4));

    }).then(function() {
        if (c.generateTilesTo == null || !steps.tileGeneration) return;
        // Generate mbtiles
        console.log('Running tile generation for ' + c.layerName);

        // Using Tippecanoe: // -s_srs EPSG:4326 -t_srs EPSG:4326
        // Convet to GeoJSON, then use Tippecanoe to generate tiles
        return execPromise(gdal_env_setup + 'ogr2ogr -overwrite -f GeoJSON ' + geoJsonFile + ' ' + reprojected_shapefile_dir + c.layerName + '.shp').catch(function(err) {
            // Don't error out if the GeoJSON file has already been created
            if (!err.message.match("GeoJSON Driver doesn't support update."))
                throw err;
        }).then(function() {
            // Use Tippecanoe with the following options:
            // -q = quiet
            // -f = force overwrite
            // -P = parallel mode
            // -pp = don't split complex polygons
            // -pS = don't simplify the max zoom level (max zoom level tiles are exact geometry, for overzooming)
            // -l str = mbtiels layer name
            // -z # = maximum zoom
            // -d # = detail at max zoom level (maximum allowed is 32 - max zoom, probably because Tippecanoe uses unsigned 32 bit integers)
            return execPromise('tippecanoe -q -f -P -pp -pS -l ' + c.layerName + ' -z ' + c.generateTilesTo + ' -d ' + (32-c.generateTilesTo) + ' -o ' + mbtilesFile + ' ' + geoJsonFile + ' > /dev/null');
        });
    }).then(function() {
        // Add/overwrite layerName.json to configJsonDir
        var configJson = {};
        configJson['/' + c.layerName] = {source: "mbtiles://" + path.resolve(mbtilesFile), headers: const_headers};
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
