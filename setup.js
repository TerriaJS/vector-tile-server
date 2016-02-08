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
//var const_maxGenZ = 6;

var const_parallel_limit = 5;


var directory = 'data2/';
var shapefile_dir = 'geoserver_shapefiles/';

// From mapnik/bin/mapnik-shapeindex.js
var shapeindex = path.join(path.dirname( binary.find(require.resolve('mapnik/package.json')) ), 'shapeindex');


var data_xml_template = fs.readFileSync('data.xml.template', 'utf8');
function generateDataXml(layerName, bbox) {
    return data_xml_template.replace(/\{layerName\}/g, layerName).replace(/\{bbox\}/g, bbox.join(',')); // Have to use regex for global (g) option (like sed)
}

function processLayer(layerName) {
    var layerDir = directory + layerName + '/';
    var dataXmlFile = layerDir + 'data.xml';

    return nodefn.call(exec, '"C:\\Program Files\\GDAL\\GDALShell.bat" && ogr2ogr -t_srs EPSG:3857 -clipsrc -180 -85.0511 180 85.0511 -overwrite -f "ESRI Shapefile" ' + layerDir.slice(0,-1) + ' ' + shapefile_dir + layerName + '.shp').then(function() {
        //console.log('Running shapeindex for ' + layerName);
        //return nodefn.call(exec, shapeindex + ' ' + layerDir + layerName + '.shp');
    }).then(function() {
        var reader = shapefile.reader(layerDir + layerName + '.shp');
        return nodefn.call(reader.readHeader.bind(reader));
    }).then(function(header) {
        return nodefn.call(fs.writeFile, dataXmlFile, generateDataXml(layerName, header.bbox)).yield({
            layerName: layerName,
            config: {"source": "bridge://" + path.resolve(dataXmlFile)},
            regionMapping: {
                layerName: layerName,
                server: {
                    url: "http://127.0.0.1:8000/" + layerName + "/{z}/{x}/{y}.pbf",
                    subdomains: undefined
                },
                bbox: merc.convert(header.bbox, "WGS84")
            }
        });
    }).catch(function(err) {
        console.log('Layer ' + layerName + ' failed with error: ' + err);
        return null;
    });


    /*.then(function() {
        console.log('Running tile generation for ' + layerName);
        return nodefn.call(exec, 'node save_tiles.js ' + [dataXmlFile, mbtilesFile, const_minZ, const_maxGenZ].join(' '));
    }).then(function() {
        console.log('Tile generation finished for ' + layerName);
        fs.writeFileSync(hybridJsonFile, JSON.stringify({"sources": [
            {"source": "mbtiles://" + path.resolve(mbtilesFile), "minZ": const_minZ, "maxZ": const_maxGenZ},
            {"source": "bridge://" + path.resolve(dataXmlFile), "minZ": const_minZ, "maxZ": const_maxZ}
        ]}));
        configJson['/' + layerName] = {"source": "hybrid://" + path.resolve(hybridJsonFile)};
    });*/
}


// Read JSON file and extract layer names
var regionMappingJson = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
// Construct a set of layers (layers are sometimes duplicated. Set is used to remove duplicates)
var layers = new Set();
var regionMaps = Object.keys(regionMappingJson.regionWmsMap);
for (var i = 0; i < regionMaps.length; i++) {
    layers.add(regionMappingJson.regionWmsMap[regionMaps[i]].layerName.replace('region_map:', ''));
}

// For each layer, download the associated shapefile zip, unzip, run shapeindex and generate tiles

var configJson = {};

// Only allow const_parallel_limit number of concurrent processLayer requests
var guardedProcessLayer = guard(guard.n(const_parallel_limit), processLayer);

var layer_array = [];
layers.forEach(function(entry) {
    layer_array.push(entry);
})

var layer_data = {};
when.map(layer_array.map(guardedProcessLayer), function(data) {
    // Add layer data to layers as each layer finishes processing
    if (data) {
        configJson['/' + data.layerName] = data.config;
        layer_data[data.layerName] = data.regionMapping;
    }
}).then(function() {
    // Once all layers have finished processing
    for (var i = 0; i < regionMaps.length; i++) {
        var layerName = regionMappingJson.regionWmsMap[regionMaps[i]].layerName.replace('region_map:', '');
        if (layer_data[layerName]) {
            Object.assign(regionMappingJson.regionWmsMap[regionMaps[i]], layer_data[layerName]); // Update properties
        }
    }

    return when.join(
        nodefn.call(fs.writeFile, 'config.json', JSON.stringify(configJson, null, 4)),
        nodefn.call(fs.writeFile, 'regionMapping_out.json', JSON.stringify(regionMappingJson, null, 2))
    );
});
