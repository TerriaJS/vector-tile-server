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
var AdmZip = require('adm-zip');
var binary = require('node-pre-gyp');



var const_maxZ = 20;
var const_minZ = 0;
var const_maxGenZ = 6;

var const_parallel_limit = 5; // Test whether this works
// If parallel_limit isn't working, try guarding a nodefn.lift version of exec and use that guarded exec
// for creating processes

var directory = 'data2/';
var tmp = 'tmp/';

// From mapnik/bin/mapnik-shapeindex.js
var shapeindex = path.join(path.dirname(binary.find(require.resolve('mapnik/package.json'))), 'shapeindex');


var data_xml_template = fs.readFileSync('data.xml.template', 'utf8');

function generate_data_xml(layerName) {
    return data_xml_template.replace('{layerName}', layerName);
}

function generate_shp_url(layerName) {
    return "http://geoserver.nationalmap.nicta.com.au:80/region_map/region_map/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=region_map:{layerName}&outputFormat=SHAPE-ZIP".replace('{layerName}', layerName);
}


function processLayer(configJson, layerName) {
    var zipFile = tmp + layerName + '.zip';
    console.log('Downloading ' + layerName);
    return nodefn.call(download, generate_shp_url(layerName), {directory: tmp, filename: layerName + '.zip'}).then(function() {
    //return nodefn.call(execFile, 'get_shapefile.sh', [generate_shp_url(layerName), zipFile]).then(function() {
        var layerDir = directory + layerName + '/';
        console.log('Unzipping ' + zipFile);
        var zip = new AdmZip(zipFile);
        zip.extractAllTo(layerDir);
        zip = undefined;

        var hybridJsonFile = layerDir + 'hybrid.json';
        var dataXmlFile = layerDir + 'data.xml';
        var mbtilesFile = layerDir + 'store.mbtiles';

        // Run shapeindex
        console.log('Running shapeindex for ' + layerName);
        return nodefn.call(exec, shapeindex + ' ' + layerDir + layerName + '.shp').then(function () {
            console.log('Running tile generation for ' + layerName);
            return nodefn.call(exec, 'node save_tiles.js ' + [dataXmlFile, mbtilesFile, const_minZ, const_maxGenZ].join(' '));
        }).then(function() {
            console.log('Tile generation finished for ' + layerName);
            fs.writeFileSync(hybridJsonFile, JSON.stringify({"sources": [
                {"source": "mbtiles://" + path.resolve(mbtilesFile), "minZ": const_minZ, "maxZ": const_maxGenZ},
                {"source": "bridge://" + path.resolve(dataXmlFile), "minZ": const_minZ, "maxZ": const_maxZ}
            ]}));
            configJson['/' + layerName] = {"source": "hybrid://" + path.resolve(hybridJsonFile)};
        });
    });
}


// Read JSON file and extract layer names
var regionMapping = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
// Construct a set of layers (layers are sometimes duplicated. Set is used to remove duplicates)
var layers = new Set();
var regionMaps = Object.keys(regionMapping.regionWmsMap);
for (var i = 0; i < regionMaps.length; i++) {
    layers.add(regionMapping.regionWmsMap[regionMaps[i]].layerName.replace('region_map:', ''));
}

// For each layer, download the associated shapefile zip, unzip, run shapeindex and generate tiles

var promises = [];

var configJson = {};

var guardedProcessLayer = guard(guard.n(const_parallel_limit), processLayer.bind(undefined, configJson));

when.map(Array.from(layers), guardedProcessLayer).then(function() {
    fs.writeFileSync('config_test.json', JSON.stringify(configJson));
});//.otherwise(console.log);
