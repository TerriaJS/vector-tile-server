var tilelive = require('tilelive');
require('tilelive-bridge').registerProtocols(tilelive);
var MBTiles = require('mbtiles');//.registerProtocols(tilelive);
var VectorTile = require('vector-tile').VectorTile;
var Protobuf = require('pbf');
var zlib = require('zlib');
var SphericalMercator = require('sphericalmercator');
var when = require('when');

var maxZ = 14;

var f = function(z,x,y,source,mbtiles) {
    var deferred = when.defer();
    source.getTile(z, x, y, function(err, tile, headers) {
        if (err) {
            //console.log(err + ' ' + [z,x,y].join('/'));
            deferred.resolve(0);
            return;
        }
        else {
            //console.log('Saving ' + [z,x,y].join('/') + '.pbf');
        }
        mbtiles.putTile(z, x, y, tile, function(err) {
            if (err) {
                deferred.reject(err);
            }
            else {
                deferred.resolve(1);
                //console.log('Successfully saved ' + [z,x,y].join('/') + '.pbf');
            }
        })
    });
    return deferred.promise;
};

tilelive.load('bridge:///home/sdavies/Desktop/tilelive-test/data/FID_SA4_2011_AUST/data.xml', function(err, source) {
    if (err) throw err;

    new MBTiles(__dirname + '/data/FID_SA4_2011_AUST/store.mbtiles', function(err, mbtiles) {
        if (err) throw err;
        mbtiles.startWriting(function(err) {
            console.log('Open for writing');
            if (err) throw err;
            var merc = new SphericalMercator();
            var tiles_drawn = 0;
            var tiles_attempted = 0;

            var x = undefined;
            var y = undefined;
            var z = 0;
            var bounds;


            (function generateNextTiles() {
                var promises = [];
                var break_nested = false;
                for (; z <= maxZ; z++) {
                    if (typeof x === "undefined" || typeof y === "undefined") {
                        bounds = merc.xyz([96.816941408,-43.740509603000035,159.109219008,-9.142175977], z);
                    }

                    if (typeof x === "undefined") x = bounds.minX;
                    for (; x <= bounds.maxX; x++) {

                        if (typeof y === "undefined") y = bounds.minY;
                        for (; y <= bounds.maxY; y++) {
                            if (promises.length < 100) {
                                //console.log('Saving ' + [z,x,y].join('/') + '.pbf');
                                promises.push(f(z,x,y,source,mbtiles));
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
                        console.log('End of level ' + z + '. ' + (tiles_attempted + promises.length) + ' tiles attempted.');
                    }

                }

                return when.all(promises).then(function(result) {
                    if (promises.length !== 0) {
                        tiles_attempted += promises.length
                        tiles_drawn += result.reduce(function(a,b) { return a+b; }, 0);
                        console.log(tiles_drawn + ' tiles drawn out of ' + tiles_attempted + ' tiles attempted.');
                        return generateNextTiles();
                    }
                });
            })().then(function () {
                mbtiles.stopWriting(function (err) {
                    if (err) throw err;
                    console.log('Writing stopped');
                });
            }).otherwise(console.log);

        })
    });



    // The `.getGrid` is implemented accordingly.
});
