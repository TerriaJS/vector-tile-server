// JS script to automate conversion of shapefile region map to vector tile region map for Tessera server
//
//    node addRegionMap.js
//

// This script must:
// 1. Convert the given shapefile to the correct projection
// 2. Create an FID field
// 3. Generate mbtiles & hybrid config file
// 4. Generate a regionMapping.json entry
// 5. Generate a/multiple region_maps-... .json
// 6. Append region map to config.json

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
    "server": "http://127.0.0.1:8000/okcounties/{z}/{x}/{y}.pbf",      // May need to be corrected
    "serverSubdomains": [],

    "regionMappingEntries": {                        // Probably should be renamed
        "okcounty": {
            "regionProp": "county",
//            "disambigProp": "state",               // disambigProp not needed
            "aliases": [
                "okcounty"
            ],
            "nameProp": "name",
            "description": "Oklahoma Counties"
        },
        "okcounty_name": {
            "regionProp": "name",
//            "disambigProp": "state",
            "aliases": [
                "okcounty_name"
            ],
            "nameProp": "name",
            "description": "Oklahoma Counties"
        },
    }
}

// Use path.resolve(path.dirname(regionMapConfigFile), shapefile) to get path of shapefile


'use strict';

var exec = require('child_process').exec;

var when = require('when');
var nodefn = require('when/node');
var guard = require('when/guard');
var fs = require('fs');
var path = require('path');
var binary = require('node-pre-gyp');
var shapefile = require('shapefile');
var merc = new (require('sphericalmercator'))();

// Promise versions of node-style functions
fs.writeFilePromise = nodefn.lift(fs.writeFile);
var execPromise = nodefn.lift(exec);


var const_maxZ = 20;
var const_minZ = 0;
var const_maxGenZ = 10;

var const_parallel_limit = 3;

var steps = {
    reprojection: true,
    tileGeneration: true,
    config: true
}


var directory = 'data2/';
var shapefile_dir = 'geoserver_shapefiles/';
var gdal_env_setup = /*'';//*/ '"C:\\Program Files\\GDAL\\GDALShell.bat" && ';

// From mapnik/bin/mapnik-shapeindex.js
var shapeindex = path.join(path.dirname( binary.find(require.resolve('mapnik/package.json')) ), 'shapeindex');

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


var data_xml_template = fs.readFileSync('data.xml.template', 'utf8'); // Use shapefile template
function generateDataXml(layerName, bbox, pgsql_db) {
    return data_xml_template.replace(/\{layerName\}/g, layerName).replace(/\{bbox\}/g, bbox.join(',')); // Have to use regex for global (g) option (like sed)
}

function processLayer(c) {
    var layerDir = directory + c.layerName + '/';
    var hybridJsonFile = layerDir + 'hybrid.json';
    var dataXmlFile = layerDir + 'data.xml';
    var mbtilesFile = layerDir + 'store.mbtiles';
    var returnData = {};

    return when().then(function() {
        // Reproject to EPSG:3857 and add an FID
        if (!steps.reproject) return;
        console.log('Converting ' + c.layerName + ' to Web Mercator projection');
        var fidCommand = c.addFID ? "-sql 'select FID,* from " + c.layerName + "'" : '';
        return execPromise(gdal_env_setup + 'ogr2ogr -t_srs EPSG:3857 -clipsrc -180 -85.0511 180 85.0511 -overwrite -f "ESRI Shapefile" '
                           + layerDir.slice(0,-1) + ' ' + shapefile_dir + c.layerName + '.shp' + fidCommand);
    }).then(function() {
        // Get info from new shapefile
        if (!steps.config) return;

        var columns = {};

        Object.keys(c.regionMappingEntries).forEach(function (key) {
            if (c.regionMappingEntries[key].regionProp) {
                columns[c.regionMappingEntries[key].regionProp] = true;
            }
            if (c.regionMappingEntries[key].disambigProp) {
                columns[c.regionMappingEntries[key].disambigProp] = true;
            }
        })

        region_mapJSONs = Object.keys(columns).map(function(column) {
            return {
                "layer": c.layerName,
                "property": column,
                "values": []
            };
        });

        var reader = shapefile.reader(layerDir + c.layerName + '.shp');
        return nodefn.call(reader.readHeader.bind(reader)).then(function(header) {
            // Iterate over records until shapefile.end
            return when.iterate(nodefn.lift(reader.readRecord.bind(reader)), function(record) { record === shapefile.end; }, function(record) {
                // For each record in the shapefile:
                // - Add the value of the specific property to the array
                region_mapJSONs.forEach(function(json) {
                    json.values.push(record.properties[json.property]);
                });
            }).then(function() {
                // Save region_map json files
                return when.all(region_mapJSONs.map(function(json) {
                    return fs.writeFilePromise('region_map-' + json.layer + '_' + json.property + '.json');
                }));
            });
            return header.bbox;
        });
    }).then(function(/*shapeinfo*/bbox) {
        // Create config.json and regionMapping.json entry
        if (!steps.config) return;
        /*var header = shapeinfo[0];
        var record = shapeinfo[1];*/

        /* Not needed in nameProp is provided

        // Adapted from Cesium ImageryLayerFeatureInfo.js (https://github.com/AnalyticalGraphicsInc/cesium/blob/1.19/Source/Scene/ImageryLayerFeatureInfo.js#L57)
        // ================================================================================
        var namePropertyPrecedence = 10;
        var nameProperty;

        for (var key in record.properties) {
            if (record.properties.hasOwnProperty(key) && record.properties[key]) { // Is this logic bad? record.properties[key] may be null
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
        // ================================================================================
        */

        var bbox = merc.convert(/*header.*/bbox, "WGS84");
        returnData = {
            layerName: layerName,
            regionMapping: {
                layerName: layerName,
                server: "http://127.0.0.1:8000/" + layerName + "/{z}/{x}/{y}.pbf",
                serverType: "MVT",
                serverSubdomains: undefined,
                bbox: bbox,
                nameProp: nameProperty
            }
        };
        return fs.writeFilePromise(dataXmlFile, generateDataXml(layerName, bbox));
    }).then(function() {
        if (c.generateTilesTo == null) return;
        // Generate mbtiles
        console.log('Running tile generation for ' + layerName);
        //return execPromise('echo node save_tiles.js ' + [dataXmlFile, mbtilesFile, const_minZ, const_maxGenZ].concat(returnData.regionMapping.bbox).join(' ') + ' > ' + mbtilesFile + '.txt');
        return execPromise('node save_tiles.js ' + [dataXmlFile, mbtilesFile, const_minZ, c.generateTilesTo].concat(returnData.regionMapping.bbox).join(' '));
    }).then(function() {
        if (!steps.config) return;
        // Write out hybrid.json
        console.log('Tile generation finished for ' + layerName);
        return fs.writeFilePromise(hybridJsonFile, JSON.stringify({sources: [
            {source: "mbtiles://" + path.resolve(mbtilesFile), minZ: const_minZ, maxZ: c.generateTilesTo},
            {source: "bridge://" + path.resolve(dataXmlFile), minZ: const_minZ, maxZ: const_maxZ}
        ]})).yield(returnData);
    }).then(function() {
        // Append layer to config.json
        var configJson = JSON.parse(fs.readFileSync('config.json', 'utf8'));
        configJson[c.layerName] = {source: "hybrid://" + path.resolve(hybridJsonFile), minZ: const_minZ, maxZ: const_maxZ};
        return fs.writeFilePromise('config.json', JSON.stringify(configJson, null, 4));
    }).catch(function(err) {
        console.log('Layer ' + layerName + ' failed with error: ' + err);
        throw err;
    });
}


}).then(function() {
    // Once all layers have finished processing
    for (var i = 0; i < regionMaps.length; i++) {
        var layerName = regionMappingJson.regionWmsMap[regionMaps[i]].layerName.replace('region_map:', '');
        if (layers[layerName]) {
            Object.assign(regionMappingJson.regionWmsMap[regionMaps[i]], layers[layerName]); // Update properties
        }
        else {
            // Use WMS for this layer
            Object.assign(regionMappingJson.regionWmsMap[regionMaps[i]], {
                server: regionMappingJson.regionWmsMap[regionMaps[i]].server,
                serverType: "WMS"
            });
        }
    }

    return when.join(
        fs.writeFilePromise('config.json', JSON.stringify(configJson, null, 4)),
        fs.writeFilePromise('regionMapping_out.json', JSON.stringify(regionMappingJson, null, 2))
    );
}).then(function() { process.exit(exitCode); });
