#!/usr/bin/env python
# Written for Python 2.7
from __future__ import print_function

import sys, os, json, re, subprocess, errno
from collections import OrderedDict
import boto
from boto.s3.key import Key
from osgeo import ogr

from common import request_input, yes_no_to_bool

def list_props(shapefile, layername):
    driver = ogr.GetDriverByName("ESRI Shapefile")
    dataSource = driver.Open(shapefile, 0)
    layer = dataSource.GetLayerByName(layername)
    # Get fields in layer
    lfd = layer.GetLayerDefn()
    return [lfd.GetFieldDefn(n).name for n in range(lfd.GetFieldCount())]

def unique_with_prop(shapefile, layername, prop):
    driver = ogr.GetDriverByName("ESRI Shapefile")
    dataSource = driver.Open(shapefile, 0)
    layer = dataSource.ExecuteSQL('SELECT COUNT(DISTINCT {1}) / COUNT(*) AS allunique FROM {0}'.format(layername, prop), dialect='SQLITE') # If one enjoys SQL attacking one's own files, then go ahead
    print(layer)
    return bool(layer.GetFeature(0).GetField('allunique'))


temp_dir = 'python_temp/'

def process_shapefile(shapefile):
    layername = os.path.basename(shapefile)[:-4] # Chop off .shp
    attribute_list = list_props(shapefile, layername)
    print('Attributes in shapefile: {}'.format(', '.join(attribute_list)))
    generate_tiles_to = int(request_input('What zoom level should tiles be generated to?', 12))
    has_fid = yes_no_to_bool(request_input('Is there an FID attribute?', 'n'), False)
    if has_fid:
        fid_attribute = request_input('Which attribute should be used as an FID?', 'FID')
    server_url = request_input('Where is the vector tile server hosted?', 'http://staging.vector-tiles.terria.io/{}/{{z}}/{{x}}/{{y}}.pbf'.format(layername))
    description = request_input('What is the description of this region map?','')
    regionMapping_entries = OrderedDict()
    regionMapping_entry_name = request_input('Name another regionMapping.json entry (leave blank to finish)', '')
    while regionMapping_entry_name != '':
        o = OrderedDict()
        o['layerName'] = '' # Set in addRegionMap.js
        o['server'] = ''
        o['regionProp'] = request_input('Which attribute should be used as the region property?', '')
        # Test this property
        if not unique_with_prop(shapefile, layername, o['regionProp']):
            o['disambigProp'] = request_input('The given region property does not uniquely define every region. Which attribute should be used to disambiguate region matching?','')
            o['disambigRegionId'] = request_input('Which regionMapping definition does this disambiguation property come from?', '')
        else:
            print('The given region property uniquely defines each region.')
        o['aliases'] = request_input('What aliases should this be available under? Separate aliases with a comma and space', '').split(', ')
        o['description'] = description
        
        regionMapping_entries[regionMapping_entry_name] = o
        regionMapping_entry_name = request_input('Name another regionMapping.json entry (leave blank to finish)', '')
    cf = os.path.join(temp_dir, '{}.json'.format(layername))
    with open(cf, 'w') as f:
        json.dump({
            'layerName': layername,
            'shapefile': os.path.join('..', shapefile),
            'generateTilesTo': generate_tiles_to,
            'addFID': not has_fid,
            'uniqueIDProp': fid_attribute if has_fid else 'FID',
            'server': server_url,
            'serverSubdomains': [],
            'regionMappingEntries': regionMapping_entries
        }, f)
    print('Generating tiles and config for {}'.format(layername))
    return layername, subprocess.Popen(['node', 'addRegionMap.js', cf])


if __name__ == '__main__':
    # Create folders if they don't exist
    try:
        for directory in ['temp', temp_dir[:-1], 'data', 'config', 'epsg4326_shapefiles', 'output_files']:
            os.makedir(directory_name)
    except OSError as exc: 
        if exc.errno == errno.EEXIST and os.path.isdir(path):
            pass
        else:
            raise
    print('Ensure you have the following directories locally: temp, python_temp, data, config, output_files')
    shapefiles = sys.argv[1:] or request_input('Which shapefiles do you want to add? Seperate shapefiles with a comma and space', '').split(', ')
    procs = [process_shapefile(shp) for shp in shapefiles]
    for layer, proc in procs:
        proc.wait()
        print('Tile and config generation finished for {}'.format(layer))
    if any(proc.returncode != 0 for _, proc in procs):
        print('Processing of at least 1 shapefile failed')
    else:
        # Local processing done
        # Now send to s3
        conn = boto.connect_s3()
        bucket = conn.get_bucket('vector-tile-server')
        for layer, _ in procs:
            # Get the highest version of this layer and add 1
            maxversion = max([int(re.search(r'v(\d*).json$', key.key).group(1)) for key in bucket.list(prefix='config/{}'.format(layer))] + [0]) # Default to 0
            print('Uploading {}-v{} to S3'.format(layer, maxversion+1))

            k1 = Key(bucket)
            k1.key = 'config/{}-v{}.json'.format(layer,maxversion+1)
            k1.set_contents_from_filename('config/{}.json'.format(layer))

            k2 = Key(bucket)
            k2.key = 'mbtiles/{}-v{}.mbtiles'.format(layer,maxversion+1)
            k2.set_contents_from_filename('data/{}.mbtiles'.format(layer))

        
