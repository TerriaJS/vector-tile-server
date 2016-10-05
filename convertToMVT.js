// This script needs to:
// 1. Read a regionMapping.json file
// 2. For each entry in wmsRegionMaps:
//   a. Generate a json file for addRegionMap
//   b. Call addRegionMap
//   c. Deal with the output
// 3. Merge outputs of regionMapping.jsons created by regionMapping.json

var exec = require('child_process').exec;

var when = require('when');
var nodefn = require('when/node');
var guard = require('when/guard');
var fs = require('fs');

// Promise versions of node-style functions
fs.writeFilePromise = nodefn.lift(fs.writeFile);
var execPromise = nodefn.lift(exec);

var const_parallel_limit = 3;
var const_maxGenZ = 12;

var configDir = 'addRegionMapConfig/';
var scriptOutputDir = 'output_files/';
var serverLocation = "http://vector-tiles.terria.io/";


function processLayer(c) {
    return fs.writeFilePromise(configDir + c.layerName + '.json', JSON.stringify(c, null, 4)).then(function() {
        return execPromise('node addRegionMap.js ' + configDir + c.layerName + '.json');
        //console.log('node addRegionMap.js ' + configDir + c.layerName + '.json')
    });
}



// Read JSON file and extract layer names
var regionMappingJson = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
var regionMaps = Object.keys(regionMappingJson.regionWmsMap);

var layers = {FID_TR_2013_AUST: {}, FID_CED_2013_AUST: {}, FID_CED_2016_AUST: {}, FID_LGA_2013_AUST: {}, fid_asgc06_cd: {}, fid_asgc06_sla: {}};


for (var i = 0; i < regionMaps.length; i++) {
    var layerName = regionMappingJson.regionWmsMap[regionMaps[i]].layerName.replace('region_map:', '');
    if (layers[layerName] === undefined) {
        continue; // Only for predefined layers = {layer1: {}, layer2: {}}
        //layers[layerName] = {};
    }
    layers[layerName][regionMaps[i]] = regionMappingJson.regionWmsMap[regionMaps[i]];
}


// Only allow const_parallel_limit number of concurrent processLayer requests
var guardedProcessLayer = guard(guard.n(const_parallel_limit), processLayer);

var exitCode = 0;
/*
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
*/


when.map(Object.keys(layers), function(layerName) {
    // Generate addRegionMap.js config and send it to processLayer
    // Config will be saved in tempDir/, so shapefile path should be ../geoserver_shapefiles/...
    var config = {
        layerName: layerName,
        shapefile: "../geoserver_shapefiles/" + layerName + ".shp",
        generateTilesTo: layerName === "FID_TM_WORLD_BORDERS" ? 10 : const_maxGenZ,
        addFID: false,
        uniqueIDProp: "FID",
        server: serverLocation + layerName + "/{z}/{x}/{y}.pbf",
        serverSubdomains: [],
        regionMappingEntries: layers[layerName]
    };

    return guardedProcessLayer(config).then(function() {
        // Register that the layer has been processed (so that if one layer fails, other successful layers don't need to be processed again)
        layers[layerName].completed = true;
        console.log(layerName + ' finished processing');
    }).catch(function(err) {
        console.log(layerName + ' failed during processing due to the following error:\n' + err);
    });

}).catch(function(err) {
    // Output the layers that aren't done if there is an error so that it is possible to only process these in another run
    // Replacing layers = {}; with layers = JSON.parse(fs.readFileSync('unfinished_layers.json'));
    // and commenting out the loop below that line will run the setup script for only the layers that were not finished in the last run
    console.log('Ending processing early due to errors:\n' + err);
    var unfinishedLayers = {};
    Object.keys(layers).forEach(function(layerName) { // Filter out finished layers
        if (layers[layerName].completed !== true) {
            unfinishedLayers[layerName] = false;
        }
    });
    exitCode = 1;
    return fs.writeFilePromise('unfinished_layers.json', JSON.stringify(unfinishedLayers, null, 4));
}).then(function() {
    var layerOutputJSONs = {};
    Object.keys(layers).forEach(function(layerName) { // Filter out finished layers
        if (layers[layerName].completed === true) {
            layerOutputJSONs[layerName] = JSON.parse(fs.readFileSync(scriptOutputDir + 'regionMapping-' + layerName + '.json', 'utf8'));
        }
    });
    // Once all layers have finished processing
    for (var i = 0; i < regionMaps.length; i++) {
        var layerName = regionMappingJson.regionWmsMap[regionMaps[i]].layerName.replace('region_map:', '');
        if (layers[layerName] && layers[layerName].completed) {
            Object.assign(regionMappingJson.regionWmsMap[regionMaps[i]], layerOutputJSONs[layerName].regionWmsMap[regionMaps[i]]); // Update properties
        } else {
            // Use WMS for this layer
            Object.assign(regionMappingJson.regionWmsMap[regionMaps[i]], {
                server: regionMappingJson.regionWmsMap[regionMaps[i]].server,
                serverType: "WMS"
            });
        }
    }

    return fs.writeFilePromise('regionMapping_out.json', JSON.stringify(regionMappingJson, null, 4));
}).then(function() { process.exit(exitCode); });
