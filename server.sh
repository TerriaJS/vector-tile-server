#!/bin/sh
node --debug node_modules/tessera/bin/tessera.js -c config.json -p 8000 --require tilelive-hybrid
