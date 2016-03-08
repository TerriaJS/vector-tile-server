// JS script to automate conversion of region mapping from geoserver to Tessera server
// Pass regionMapping.json as follows:
//
//    node setup.js path/to/regionMapping.json
//

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


// From Mozilla MDN. Polyfill for old Node versions
if (typeof Object.assign != 'function') {
  (function () {
    Object.assign = function (target) {
      'use strict';
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


var const_maxZ = 20;
var const_minZ = 0;
var const_maxGenZ = 10;

var const_parallel_limit = 3;


var directory = 'data2/';
var shapefile_dir = 'geoserver_shapefiles/';
var pgsql_dir = ''; // 'C:\\PROGRA~1\\PostgreSQL\\9.5\\bin\\';
var gdal_env_setup = '';//'"C:\\Program Files\\GDAL\\GDALShell.bat" && ';
var pgsql_db = 'region_mapping';

// From mapnik/bin/mapnik-shapeindex.js
var shapeindex = path.join(path.dirname( binary.find(require.resolve('mapnik/package.json')) ), 'shapeindex');


var data_xml_template = fs.readFileSync('data.xml.template', 'utf8');
function generateDataXml(layerName, bbox, pgsql_db) {
    return data_xml_template.replace(/\{layerName\}/g, layerName)
        .replace(/\{bbox\}/g, bbox.join(','))
        .replace(/\{database\}/g, pgsql_db); // Have to use regex for global (g) option (like sed)
}

function processLayer(layerName) {
    var layerDir = directory + layerName + '/';
    var hybridJsonFile = layerDir + 'hybrid.json';
    var dataXmlFile = layerDir + 'data.xml';
    var mbtilesFile = layerDir + 'store.mbtiles';
    var returnData = {};

    return when().then(function() {
        console.log('Converting ' + layerName + ' to Web Mercator projection');
        return execPromise(gdal_env_setup + 'ogr2ogr -t_srs EPSG:3857 -clipsrc -180 -85.0511 180 85.0511 -overwrite -f "ESRI Shapefile" ' + layerDir.slice(0,-1) + ' ' + shapefile_dir + layerName + '.shp');
    }).then(function() {
        // Run shp2pgsql
        console.log('Converting ' + layerName + ' to PostGIS table');
        return execPromise(pgsql_dir + 'shp2pgsql -s 3857 -k -d -I ' + layerDir + layerName + ' public.' + layerName + ' | ' + pgsql_dir + 'psql -U postgres -d ' + pgsql_db + ' -w > nul'); // Change nul to /dev/null for POSIX
    }).then(function() {
        var reader = shapefile.reader(layerDir + layerName + '.shp');
        return nodefn.call(reader.readHeader.bind(reader));
    }).then(function(header) {
        var bbox = merc.convert(header.bbox, "WGS84");
        returnData = {
            layerName: layerName,
            config: {"source": "hybrid://" + path.resolve(hybridJsonFile)},
            regionMapping: {
                layerName: layerName,
                server: {
                    url: "http://127.0.0.1:8000/" + layerName + "/{z}/{x}/{y}.pbf",
                    subdomains: undefined
                },
                serverType: "vector",
                bbox: bbox
            }
        };
        return fs.writeFilePromise(dataXmlFile, generateDataXml(layerName, bbox, pgsql_db));
    }).then(function() {
        // Generate mbtiles
        console.log('Running tile generation for ' + layerName);
        //return execPromise('echo node save_tiles.js ' + [dataXmlFile, mbtilesFile, const_minZ, const_maxGenZ].concat(returnData.regionMapping.bbox).join(' ') + ' > ' + mbtilesFile + '.txt');
        return execPromise('node save_tiles.js ' + [dataXmlFile, mbtilesFile, const_minZ, const_maxGenZ].concat(returnData.regionMapping.bbox).join(' '));
    }).then(function() {
        // Write out hybrid.json
        console.log('Tile generation finished for ' + layerName);
        return fs.writeFilePromise(hybridJsonFile, JSON.stringify({"sources": [
            {"source": "mbtiles://" + path.resolve(mbtilesFile), "minZ": const_minZ, "maxZ": const_maxGenZ},
            {"source": "bridge://" + path.resolve(dataXmlFile), "minZ": const_minZ, "maxZ": const_maxZ}
        ]})).yield(returnData);
    }).catch(function(err) {
        console.log('Layer ' + layerName + ' failed with error: ' + err);
        throw err;
    });
}


// Read JSON file and extract layer names
var regionMappingJson = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
var regionMaps = Object.keys(regionMappingJson.regionWmsMap);

var layers = {};//{FID_SSC_2011_AUST: false};
for (var i = 0; i < regionMaps.length; i++) {
    layers[regionMappingJson.regionWmsMap[regionMaps[i]].layerName.replace('region_map:', '')] = false;
}


// Only allow const_parallel_limit number of concurrent processLayer requests
var guardedProcessLayer = guard(guard.n(const_parallel_limit), processLayer);
var configJson = {};

var exitCode = 0;

when.map(Object.keys(layers).map(guardedProcessLayer), function(data) {
    // Add layer data to layers as each layer finishes processing
    if (data) {
        configJson['/' + data.layerName] = data.config;
        layers[data.layerName] = data.regionMapping;
    }
}).catch(function(err) {
    // Output the layers that aren't done if there is an error so that it is possible to only process these in another run
    // Replacing layers = {}; with layers = JSON.parse(fs.readFileSync('unfinished_layers.json'));
    // and commenting out the loop below that line will run the setup script for only the layers that were not finished in the last run
    console.log('Ending processing early due to errors');
    var unfinishedLayers = {};
    Object.keys(layers).forEach(function(layerName) { // Filter out finished layers
        if (!layers[layerName]) {
            unfinishedLayers[layerName] = false;
        }
    });
    exitCode = 1;
    return fs.writeFilePromise('unfinished_layers.json', JSON.stringify(unfinishedLayers, null, 4));
}).then(function() {
    // Once all layers have finished processing
    for (var i = 0; i < regionMaps.length; i++) {
        var layerName = regionMappingJson.regionWmsMap[regionMaps[i]].layerName.replace('region_map:', '');
        if (layers[layerName]) {
            Object.assign(regionMappingJson.regionWmsMap[regionMaps[i]], layers[layerName]); // Update properties
        }
    }

    return when.join(
        fs.writeFilePromise('config.json', JSON.stringify(configJson, null, 4)),
        fs.writeFilePromise('regionMapping_out.json', JSON.stringify(regionMappingJson, null, 2))
    );
}).then(function() { process.exit(exitCode); });
