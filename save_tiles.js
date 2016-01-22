// Generates mapnik/mapbox vector tiles at certain zoom levels within a rectangle from a mapnik XML file and saves the generated tiles to
// a mbtiles data store

// Call save_tiles as follows:
//    node save_tiles.js /absolute/path/to/mapnikXml /absolute/path/to/mbtiles minZ maxZ

var tilelive = require('tilelive');
require('tilelive-bridge').registerProtocols(tilelive);
var MBTiles = require('mbtiles');//.registerProtocols(tilelive);
var VectorTile = require('vector-tile').VectorTile;
var SphericalMercator = require('sphericalmercator');
var when = require('when');
var nodefn = require('when/node');
var path = require('path');

var fileIn = path.resolve(process.argv[2]);
var fileOut = path.resolve(process.argv[3]);

var minZ = process.argv[4];
var maxZ = process.argv[5];

var rectangle = [96.816941408,-43.740509603000035,159.109219008,-9.142175977]; // Bounding box of Australia and islands

function copyTile(z,x,y,source,dest) {
    return nodefn.call(source.getTile.bind(source), z,x,y).then(function (args) {
        return nodefn.call(dest.putTile.bind(dest), z, x, y, args[0]).yield(1); // 1 tile drawn
    }, function (err) {
        console.log([z,x,y].join('/'));
        return 0;
    }); // 0 tiles drawn
}

function copyTiles(source, dest) {
    var merc = new SphericalMercator();
    var tiles_drawn = 0;
    var tiles_attempted = 0;

    var x = undefined;
    var y = undefined;
    var z = minZ;

    var bounds;

    /*
    // Continuing on from where generating stopped
    // ========================
    var z = 14;
    var x = 13437;
    var y = 7186;
    bounds = merc.xyz([96.816941408,-43.740509603000035,159.109219008,-9.142175977], z);
    // ========================
    */
    return (function generateNextTiles() {
        var promises = [];
        var break_nested = false;
        for (; z <= maxZ; z++) {
            if (typeof x === "undefined" || typeof y === "undefined") {
                bounds = merc.xyz(rectangle, z);
            }

            if (typeof x === "undefined") x = bounds.minX;
            for (; x <= bounds.maxX; x++) {

                if (typeof y === "undefined") y = bounds.minY;
                for (; y <= bounds.maxY; y++) {
                    if (promises.length < 100) {
                        //console.log('Saving ' + [z,x,y].join('/') + '.pbf');
                        promises.push(copyTile(z,x,y,source,dest));
                    }
                    else {
                        break_nested = true;
                        break;
                    }
                }
                if (break_nested) {
                    break;
                }
                else {
                    y = undefined
                }
            }
            if (break_nested) {
                break;
            }
            else {
                x = undefined;
            }
        }

        return when.all(promises).then(function(result) {
            if (promises.length !== 0) {
                tiles_attempted += promises.length
                tiles_drawn += result.reduce(function(a,b) { return a+b; }, 0);
                //console.log(tiles_drawn + ' tiles drawn out of ' + tiles_attempted + ' tiles attempted.');
                return generateNextTiles();
            }
        });
    })();
}

function copyInfo(source, dest) {
    return nodefn.call(source.getInfo.bind(source)).then(function (info) {
        return nodefn.call(dest.putInfo.bind(dest), info);
    });
}

when.all([ // Initialise source and mbtiles
    nodefn.call(tilelive.load, 'bridge://' + fileIn),
    nodefn.call(function(callback) { new MBTiles(fileOut, callback); })
]).then(function (l) {
    var source = l[0];
    var mbtiles = l[1];

    return nodefn.call(mbtiles.startWriting.bind(mbtiles)).then(function() {
        return when.join(copyTiles(source, mbtiles), copyInfo(source, mbtiles));
    }).then(function () {
        return nodefn.call(mbtiles.stopWriting.bind(mbtiles));
    }).then(function () {
        //console.log('Writing stopped');
        return when.join(nodefn.call(mbtiles.close.bind(mbtiles)), nodefn.call(source.close.bind(source)));
    }).then(function () {
        //console.log('Closed');
    });
});//.otherwise(console.log).then(function() { process.exit(); });
