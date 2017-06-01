#!/usr/bin/env python3
# Written for Python 3.6
'Create vector tile layers with correspondong vector-tile-server (or Tessera) and TerriaMap configuration files'

# Ideas:
# - Main function that converts 1 GeoJSON/shapefile to a vector tile layer with TerriaMap config and test files
# - Use asycnio

from contextlib import contextmanager, redirect_stdout
import sys
import os
import errno
import json
from collections import OrderedDict

from osgeo import ogr, osr

import asyncio.subprocess
from subprocess import Popen
from asyncio.subprocess import PIPE, DEVNULL


def yes_no_to_bool(string, default): # default should be a bool
    'Convert a yes or no answer to a boolean'
    string = string.lower()
    if string == 'y' or string == 'yes':
        return True
    elif string == 'n' or string == 'no':
        return False
    else:
        print('Invalid yes or no format. Defaulting to: {}'.format(default))
        return bool(default)

def request_input(caption, default):
    'Request input from the user, returning default if no input is given'
    response = input('\x1b[94m' + '{} '.format(caption) + ('({}): '.format(default) if default else '') + '\x1b[0m')
    return response if response != '' else default


def unique_with_prop(data_source, layername, prop):
    'Determine if the property prop uniquely identifies every feature in the given layer of the DataSource'
    layer = data_source.ExecuteSQL('SELECT COUNT(DISTINCT {1}) / COUNT(*) AS allunique FROM {0}'.format(layername, prop), dialect='SQLITE') # If one enjoys SQL attacking one's own files, then go ahead
    all_unique = bool(layer.GetFeature(0).GetField('allunique'))
    data_source.ReleaseResultSet(layer)
    return all_unique

def select_name_prop(properties):
    'Select a default name prop using Cesium FeatureInfo rules'
    # Adapted from Cesium ImageryLayerFeatureInfo.js (https://github.com/AnalyticalGraphicsInc/cesium/blob/1.19/Source/Scene/ImageryLayerFeatureInfo.js#L57)
    name_property_precedence = 10
    name_property = ''
    for key in properties:
        lower_key = key.lower()
        if name_property_precedence > 1 and lower_key == 'name':
            name_property_precedence = 1
            name_property = key
        elif name_property_precedence > 2 and lower_key == 'title':
            name_property_precedence = 2
            name_property = key
        elif name_property_precedence > 3 and lower_key.find('name') != -1:
            name_property_precedence = 3
            name_property = key
        elif name_property_precedence > 4 and lower_key.find('title') != -1:
            name_property_precedence = 4
            name_property = key
    return request_input('Which attribute should be used as the name property?', name_property)

def mbtiles_filename(layer_name):
    return os.path.join('testing', 'data', '{}.mbtiles'.format(layer_name))

async def generate_tiles(geometry_file, input_layer_name, layer_name, add_fid, generate_tiles_to):
    'Clean geometry, add FID & generate tiles. Returns a wait function that blocks until processing is finished'
    # asyncio create_subprocess_exec makes pipes that aren't useful
    # So use Popen for the first 2 processes, and join them to an asyncio subprocess
    o2o = Popen([
        'ogr2ogr',
        '-t_srs', 'EPSG:4326',
        # '-clipsrc', '-180', '-85.0511', '180', '85.0511', # Clip to EPSG:4326 (not working)
        '-f', 'GeoJSON',
        '-dialect', 'SQLITE',
        '-sql', 'SELECT ST_MakeValid(geometry) as geometry, * FROM {}'.format(input_layer_name),
        '/vsistdout/', geometry_file
    ], stdout=PIPE)
    if add_fid:
        o2o = Popen([
            'ogr2ogr',
            '-t_srs', 'EPSG:4326',
            '-f', 'GeoJSON',
            '-sql', 'select FID,* from OGRGeoJSON',
            '/vsistdout/', '/vsistdin/'
        ], stdin=o2o.stdout, stdout=PIPE)
    tippe = await asyncio.create_subprocess_exec(*[
        'tippecanoe',
        '-q',
        '-f',
        '-P',
        '-pp',
        '-pS',
        '-l', layer_name,
        '-z', str(generate_tiles_to), # Max zoom
        '-d', str(32-generate_tiles_to), # Detail
        '-o', './{0}'.format(mbtiles_filename(layer_name))
    ], stdin=o2o.stdout, stdout=DEVNULL)
    await tippe.wait()
    return

async def generate_test_csv(geometry_file, test_csv_file, input_layer_name, region_property, alias):
    'Generate test csv for each region attribute. Attributes that require a disambiguation property are not supported'
    o2o = await asyncio.create_subprocess_exec(*[
        'ogr2ogr',
        '-f', 'CSV',
        '-dialect', 'SQLITE',
        '-sql', 'SELECT {0} as {1}, random() % 20 as randomval FROM {2}'.format(region_property, alias, input_layer_name),
        '/vsistdout/', geometry_file
    ], stdout=open(test_csv_file, 'w'))
    await o2o.wait()
    return


async def create_layer(geometry_file):
    '''
    Create a vector tile layer with a given geometry file complete with mbtiles, server config,
    TerriaMap files and test csvs
    '''
    data_source = ogr.Open(geometry_file)

    if data_source is None:
        print('{} could not be opened by ogr'.format(geometry_file))
        return

    layers = [data_source.GetLayerByIndex(i).GetName() for i in range(data_source.GetLayerCount())]
    print('File has the following layers: {}'.format(', '.join(layers)))
    input_layer_name = request_input('Which layer should be used?', layers[0] if len(layers) == 1 else '')
    if input_layer_name not in layers:
        print('Layer {} is not in file {}'.format(layer_name, geometry_file))
        return
    layer_name = request_input('What should this layer be called?', input_layer_name)

    layer = data_source.GetLayerByName(input_layer_name)
    generate_tiles_to = int(request_input('What zoom level should tiles be generated to?', 12))
    layer_defn = layer.GetLayerDefn()
    attributes = [layer_defn.GetFieldDefn(i).name for i in range(layer_defn.GetFieldCount())]
    print('Attributes in file: {}'.format(', '.join(attributes)))
    has_fid = yes_no_to_bool(request_input('Is there an FID attribute?', 'n'), False)

    # Start tile generation. Must call wait before Python execution ends
    future = generate_tiles(geometry_file, input_layer_name, layer_name, not has_fid, generate_tiles_to)

    # Ask for the current FID attribute if there is one, otherwise add an FID and use that
    # Test FID attribute
    fid_attribute = request_input('Which attribute should be used as an FID?', 'FID') if has_fid else 'FID'
    num_features = layer.GetFeatureCount()
    if has_fid and set(layer.GetFeature(i).GetField(fid_attribute) for i in range(num_features)) != set(range(num_features)):
        print('Attribute not an appropriate FID (must number features from 0 to #features - 1 in any order)')
        return
    server_url = request_input('Where is the vector tile server hosted?', 'http://localhost:8000/{}/{{z}}/{{x}}/{{y}}.pbf'.format(layer_name))
    description = request_input('What is the description of this region map?', '')
    regionMapping_entries = OrderedDict()
    regionMapping_entry_name = request_input('Name another regionMapping.json entry (leave blank to finish)', '')
    regionId_columns = set() # All the columns that need regionId file generation
    test_csv_futures = []
    w, e, s, n = layer.GetExtent()
    while regionMapping_entry_name != '':
        o = OrderedDict([
            ('layerName', layer_name),
            ('server', server_url),
            ('serverType', 'MVT'),
            ('serverMaxNativeZoom', generate_tiles_to),
            ('serverMaxZoom', 28),
            ('bbox', [w, s, e, n]),
            ('uniqueIdProp', fid_attribute),
            ('regionProp', None),
            ('nameProp', select_name_prop(attributes)),
            ('aliases', None),
            ('description', description)
        ])

        # Get regionProp, aliases and disambigProp (if needed) for regionMapping.json file
        while True:
            o['regionProp'] = request_input('Which attribute should be used as the region property?', '')
            if o['regionProp'] in attributes:
                break
            print('Attribute {} not found'.format(o['regionProp']))
        regionId_columns.add(o['regionProp'])
        o['regionIdsFile'] = 'data/regionids/region_map-{0}_{1}.json'.format(layer_name, o['regionProp'])
        all_unique = unique_with_prop(data_source, input_layer_name, o['regionProp'])
        print('The given region property {} each region.'.format('uniquely defines' if all_unique else 'does not uniquely define'))
        o['aliases'] = request_input('What aliases should this be available under? Separate aliases with a comma and space', '').split(', ')
        if not all_unique:
            while True:
                o['disambigProp'] = request_input('Which attribute should be used to disambiguate region matching?', '')
                if o['disambigProp'] in attributes:
                    break
                print('Attribute {} not found'.format(o['disambigProp']))
            regionId_columns.add(o['disambigProp'])
            o['regionDisambigIdsFile'] = 'data/regionids/region_map-{0}_{1}.json'.format(layer_name, o['disambigProp'])
            o['disambigRegionId'] = request_input('Which regionMapping definition does this disambiguation property come from?', '')
            print('No test CSV generated for this regionMapping entry (test CSV generation does not currently support disambiguation properties)')
        else:
            # Make test CSVs
            test_csv_file = os.path.join('testing', 'output_files', 'test-{0}_{1}.csv'.format(layer_name, o['regionProp']))
            test_csv_futures.append(generate_test_csv(geometry_file, test_csv_file, input_layer_name, o['regionProp'], o['aliases'][0]))

        regionMapping_entries[regionMapping_entry_name] = o
        regionMapping_entry_name = request_input('Name another regionMapping.json entry (leave blank to finish)', '')

    # Make vector-tile-server config file
    config_json = {
        '/{0}'.format(layer_name): OrderedDict([
            ('headers', {'Cache-Control': 'public,max-age=86400'}),
            ('source', 'mbtiles:///etc/vector-tiles/{0}'.format(mbtiles_filename(layer_name)))
        ])
    }
    config_filename = os.path.join('testing', 'config', '{0}.json'.format(layer_name))
    json.dump(config_json, open(config_filename, 'w'))

    # Make regionMapping file
    regionMapping_filename = os.path.join('testing', 'output_files', 'regionMapping-{0}.json'.format(layer_name))
    json.dump({'regionWmsMap': regionMapping_entries}, open(regionMapping_filename, 'w'), indent=4)

    # Make regionid files
    # Extract all the variables needed for the regionid files
    get_field = lambda i, field: layer.GetFeature(i).GetField(field)
    if has_fid:
        # Doesn't assume that fids are sequential
        # Make a dict of the attributes from the features first, then put them in the right order
        regionID_values_dict = {get_field(i, fid_attribute): tuple(get_field(i, column) for column in regionId_columns) for i in range(num_features)}
        # The FID attribute has already been checked to allow this transformation
        regionID_values = [regionID_values_dict[i] for i in range(num_features)]
    else:
        # Assume sequentially assigned fids (ogr2ogr should apply fids sequentially)
        regionID_values = [tuple(get_field(i, column) for column in regionId_columns) for i in range(num_features)]
    for column, values in zip(regionId_columns, regionID_values):
        regionId_json = OrderedDict([ # Make string comparison of files possible
            ('layer', layer_name),
            ('property', column),
            ('values', list(values))
        ])
        regionId_filename = os.path.join('testing', 'output_files', 'region_map-{0}_{1}.json'.format(layer_name, column))
        json.dump(regionId_json, open(regionId_filename, 'w'))

    layer = None
    data_source = None
    await asyncio.gather(future, *test_csv_futures) # Wait for tile & csv generation to finish
    return

async def main():
    # geometries = ['geoserver_shapefiles/FID_SA4_2011_AUST.shp']
    geometries = sys.argv[1:] or request_input('Which geometries do you want to add? Seperate geometry files with a comma and space', '').split(', ')
    await asyncio.gather(*[create_layer(geometry_file) for geometry_file in geometries])

if __name__ == '__main__':
    # Create folders if they don't exist
    for directory in ['data', 'config', 'output_files']:
        try:
            os.mkdir(directory)
        except OSError as exc:
            if exc.errno == errno.EEXIST and os.path.isdir(directory):
                pass
            else:
                raise

    loop = asyncio.get_event_loop()
    loop.run_until_complete(main())
    loop.close()

    #create_layer('geoserver_shapefiles/CED_2016_AUST.shp')

