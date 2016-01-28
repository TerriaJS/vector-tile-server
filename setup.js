// JS script to automate conversion of region mapping from geoserver to Tessera server
// Pass regionMapping.json as follows:
//
//    node setup.js path/to/regionMapping.json
//

var exec = require('child_process').exec;
//var execFile = require('child_process').execFile;
var spawn = require('child_process').spawn;
var when = require('when');
var nodefn = require('when/node');
var guard = require('when/guard');
var fs = require('fs');
var path = require('path');
var download = require('download-file');
//var AdmZip = require('adm-zip');
var extract = require('extract-zip');
var binary = require('node-pre-gyp');
var shapefile = require('shapefile');


var const_maxZ = 20;
var const_minZ = 0;
//var const_maxGenZ = 6;

var const_parallel_limit = 5;


var directory = 'data3/';
var tmp = 'tmp/';

// From mapnik/bin/mapnik-shapeindex.js
var shapeindex = path.join(path.dirname( binary.find(require.resolve('mapnik/package.json')) ), 'shapeindex');


var data_xml_template = fs.readFileSync('data.xml.template', 'utf8');
function generate_data_xml(layerName, bbox) {
    return data_xml_template.replace(/\{layerName\}/g, layerName).replace(/\{bbox\}/g, bbox.join(',')); // Have to use regex for global (g) option (like sed)
}

function generate_shp_url(layerName) {
    return "http://geoserver.nationalmap.nicta.com.au:80/region_map/region_map/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=region_map:{layerName}&outputFormat=SHAPE-ZIP".replace('{layerName}', layerName);
}

function processLayer(layerName) {
    var zipFile = tmp + layerName + '.zip';
    var layerDir = directory + layerName + '/';
    var dataXmlFile = layerDir + 'data.xml';
    //var hybridJsonFile = layerDir + 'hybrid.json';
    //var mbtilesFile = layerDir + 'store.mbtiles';

    //console.log('Downloading ' + layerName);
    return nodefn.call(download, generate_shp_url(layerName), {directory: tmp, filename: layerName + '.zip'}).then(function() {
        //console.log('Unzipping ' + zipFile);
        return nodefn.call(extract, zipFile, {dir: layerDir});
        /*var zip = new AdmZip(zipFile);
        zip.extractAllTo(layerDir);*/
    }).then(function() {
        //console.log('Running shapeindex for ' + layerName);
        return nodefn.call(exec, shapeindex + ' ' + layerDir + layerName + '.shp');
    }).then(function() {
        var reader = shapefile.reader(layerDir + layerName + '.shp');
        return nodefn.call(reader.readHeader.bind(reader));
    }).then(function(header) {
        return nodefn.call(fs.writeFile, dataXmlFile, generate_data_xml(layerName, header.bbox));
    }).yield({
        layerName: layerName,
        config: {"source": "bridge://" + path.resolve(dataXmlFile)},
        regionMapping: {
            layerName: layerName,
            server: {
                url: "http://127.0.0.1:8000/" + layerName + "/{z}/{x}/{y}.pbf",
                subdomains: undefined
            }
        }
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

var layer_data = {};
when.map(Array.from(layers).map(guardedProcessLayer), function(data) {
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
        nodefn.call(fs.writeFile, 'config_test.json', JSON.stringify(configJson, null, 4)),
        nodefn.call(fs.writeFile, 'regionMapping_out.json', JSON.stringify(regionMappingJson, null, 2))
    );
});
