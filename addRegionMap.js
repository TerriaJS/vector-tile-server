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
var gdal_env_setup = '';// '"C:\\Program Files\\GDAL\\GDALShell.bat" && ';

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
    var layerRectangle;
    var returnData = {};

    return when().then(function() {
        // Reproject to EPSG:3857 and add an FID
        if (!steps.reprojection) return;
        console.log('Converting ' + c.layerName + ' to Web Mercator projection');

        // Add an FID if the input config
        var fidCommand = c.addFID ? " -sql 'select FID,* from " + c.layerName + "'" : '';
        return execPromise(gdal_env_setup + 'ogr2ogr -t_srs EPSG:3857 -clipsrc -180 -85.0511 180 85.0511 -overwrite -f "ESRI Shapefile" '
                           + layerDir.slice(0,-1) + ' ' + c.shapefile + fidCommand);
    }).then(function() {
        // Iterate over new shapefile and generate region_map json (FID -> property) files
        if (!steps.config) return;

        // Use object to make columns unique
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
            layerRectangle = merc.convert(header.bbox, "WGS84");
            // Iterate over records until shapefile.end
            return when.iterate(nodefn.lift(reader.readRecord.bind(reader)), function(record) { record === shapefile.end; }, function(record) {
                // With every record, get the value of each property required
                region_mapJSONs.forEach(function(json) {
                    json.values.push(record.properties[json.property]);
                });
            }).then(function() {
                // Save region_map json files
                return when.map(region_mapJSONs, function(json) {
                    return fs.writeFilePromise('region_map-' + json.layer + '_' + json.property + '.json');
                });
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
                bbox: layerRectangle,
                uniqueIdProp: c.uniqueIdProp !== "FID" ? c.uniqueIdProp : undefined, // Only set if not FID
                regionProp: configEntry.regionProp,
                aliases: configEntry.aliases,
                nameProp: configEntry.nameProp,
                description: configEntry.description,
                regionIdsFile: 'data/regionids/region_map-' + c.layerName + configEntry.regionProp,
            };

            if (configEntry.disambigProp) {
                regionMappingEntry.disambigProp = configEntry.disambigProp;
                regionMappingEntry.disambigIdsFile = 'data/regionids/region_map-' + c.layerName + configEntry.disambigProp;
            }

            regionWmsMap[key] = regionMappingEntry;
        });

        return fs.writeFilePromise('regionMapping-' + c.layerName + '.json', JSON.stringify({regionWmsMap: regionWmsMap}, null, 2));

    }).then(function() {
        // Create config.json and regionMapping.json entry
        if (!steps.config) return;
        return fs.writeFilePromise(dataXmlFile, generateDataXml(c.layerName, layerRectangle));
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
    /*}).catch(function(err) {
        console.log('Layer ' + c.layerName + ' failed with error: ' + err);
        throw err;
    */
    });
}



var config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

processLayer(config).then(function() { process.exit(exitCode); });
