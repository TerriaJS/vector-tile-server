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
import uuid
import re

from osgeo import ogr, osr
import boto3

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
    return os.path.join('data', '{}.mbtiles'.format(layer_name))

async def to_geojson(geometry_file, input_layer_name, add_fid, start_future):
    'Convert geometry_file to a temporary GeoJSON (including cleaning geometry and adding an fid if requested) and return the temporary filename'
    filename = 'temp/{}.json'.format(uuid.uuid4().hex)
    print('Generated filename {}'.format(filename))
    o2o = await asyncio.create_subprocess_exec(*[
        'ogr2ogr',
        '-t_srs', 'EPSG:4326',
        # '-clipsrc', '-180', '-85.0511', '180', '85.0511', # Clip to EPSG:4326 (not working)
        '-f', 'GeoJSON',
        '-dialect', 'SQLITE',
        '-sql', 'SELECT ST_MakeValid(geometry) as geometry, * FROM {}'.format(input_layer_name),
        filename, geometry_file
    ])
    start_future.set_result(None) # Conversion started, let the prompts continue and wait on finished processing later
    print('Running geometry cleaning & reprojection')
    await o2o.wait()
    print('Finished geometry cleaning & reprojection')
    if add_fid:
        filename2 = 'temp/{}.json'.format(uuid.uuid4().hex)
        print('Generated filename {}'.format(filename2))
        o2o = await asyncio.create_subprocess_exec(*[
            'ogr2ogr',
            '-t_srs', 'EPSG:4326',
            '-f', 'GeoJSON',
            '-sql', 'select FID,* from OGRGeoJSON',
            filename2, filename
        ])
        print('Running FID generation')
        await o2o.wait()
        print('Finished FID generation')
        os.remove(filename)
        filename = filename2 # New geojson is now the geojson file to use
    return filename

class GeoJSONTemporaryFile:
    'Context manager for creating a temporary GeoJSON file from a given geometry file'
    def __init__(self, geometry_file, input_layer_name, add_fid):
        self.geometry_file = geometry_file
        self.input_layer_name = input_layer_name
        self.add_fid = add_fid
        self.finished_future = None
        self.filename = ''

    async def start(self):
        'Start loading of geojson files, and grab a future to the finished processing. Should resolve almost instantly (only waits on starting a subprocess)'
        filename = 'temp/{}.json'.format(uuid.uuid4().hex)
        print('Generated filename {}'.format(filename))
        o2o = await asyncio.create_subprocess_exec(*[
            'ogr2ogr',
            '-t_srs', 'EPSG:4326',
            # '-clipsrc', '-180', '-85.0511', '180', '85.0511', # Clip to EPSG:4326 (not working)
            '-f', 'GeoJSON',
            '-dialect', 'SQLITE',
            '-sql', 'SELECT ST_MakeValid(geometry) as geometry, * FROM {}'.format(self.input_layer_name),
            filename, self.geometry_file
        ])
        print('Running geometry cleaning & reprojection')
        async def finish_conversion(start_promise, filename, add_fid):
            'Wait for initial conversion to finish, then add fid if needed and return a promise to the filename'
            await start_promise
            if add_fid:
                filename2 = 'temp/{}.json'.format(uuid.uuid4().hex)
                print('Generated filename {}'.format(filename2))
                o2o = await asyncio.create_subprocess_exec(*[
                    'ogr2ogr',
                    '-t_srs', 'EPSG:4326',
                    '-f', 'GeoJSON',
                    '-sql', 'select FID,* from OGRGeoJSON',
                    filename2, filename
                ])
                print('Running FID generation')
                await o2o.wait()
                print('Finished FID generation')
                os.remove(filename)
                filename = filename2 # New geojson is now the geojson file to use
            return filename
        self.finished_future = finish_conversion(o2o.wait(), filename, self.add_fid)

    async def __aenter__(self):
        if self.finished_future is None:
            await self.start()
        self.filename = await self.finished_future
        return self.filename

    async def __aexit__(self, exc_type, exc, tb):
        os.remove(self.filename)



async def generate_tiles(geojson_file, layer_name, generate_tiles_to):
    'Generate tiles with Tippecanoe'
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
        '-o', './{0}'.format(mbtiles_filename(layer_name)),
        geojson_file
    ], stdout=DEVNULL, stderr=DEVNULL)
    return tippe.wait() # return finishing future (a future in a future)

async def generate_test_csv(geometry_file, test_csv_file, input_layer_name, region_property, alias):
    'Generate test csv for each region attribute. Attributes that require a disambiguation property are not supported'
    o2o = await asyncio.create_subprocess_exec(*[
        'ogr2ogr',
        '-f', 'CSV',
        '-dialect', 'SQLITE',
        '-sql', 'SELECT {0} as {1}, random() % 20 as randomval FROM {2}'.format(region_property, alias, input_layer_name),
        '/vsistdout/', geometry_file
    ], stdout=open(test_csv_file, 'w')) # CSV driver is problematic writing files, so deal with that in Python
    return o2o.wait() # return finishing future (a future in a future)


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
    print('File {} has the following layers: {}'.format(geometry_file, ', '.join(layers)))
    input_layer_name = request_input('Which layer should be used?', layers[0] if len(layers) == 1 else '')
    if input_layer_name not in layers:
        print('Layer {} is not in file {}'.format(input_layer_name, geometry_file))
        return
    layer_name = request_input('What should this layer be called?', input_layer_name)

    layer = data_source.GetLayerByName(input_layer_name)
    generate_tiles_to = int(request_input('What zoom level should tiles be generated to?', 12))
    layer_defn = layer.GetLayerDefn()
    attributes = [layer_defn.GetFieldDefn(i).name for i in range(layer_defn.GetFieldCount())]
    layer_defn = None
    print('Attributes in file: {}'.format(', '.join(attributes)))
    has_fid = yes_no_to_bool(request_input('Is there an FID attribute?', 'n'), False)

    geojson_tempfile = GeoJSONTemporaryFile(geometry_file, input_layer_name, not has_fid)
    # Start geojson conversion. Must wait on the processing finished future sometime before Python execution ends
    await geojson_tempfile.start()

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

    while regionMapping_entry_name != '':
        o = OrderedDict([
            ('layerName', layer_name),
            ('server', server_url),
            ('serverType', 'MVT'),
            ('serverMaxNativeZoom', generate_tiles_to),
            ('serverMaxZoom', 28),
            ('bbox', None), # bbox is calculated asynchronously
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
            # Make test CSVs (only when no disambiguation property needed)
            test_csv_file = os.path.join('output_files', 'test-{0}_{1}.csv'.format(layer_name, o['regionProp']))
            test_csv_futures.append(await generate_test_csv(geometry_file, test_csv_file, input_layer_name, o['regionProp'], o['aliases'][0]))

        regionMapping_entries[regionMapping_entry_name] = o
        regionMapping_entry_name = request_input('Name another regionMapping.json entry (leave blank to finish)', '')

    # Close data source
    layer = None
    data_source = None

    # Make vector-tile-server config file
    config_json = {
        '/{0}'.format(layer_name): OrderedDict([
            ('headers', {'Cache-Control': 'public,max-age=86400'}),
            ('source', 'mbtiles:///etc/vector-tiles/{0}'.format(mbtiles_filename(layer_name)))
        ])
    }
    config_filename = os.path.join('config', '{0}.json'.format(layer_name))
    json.dump(config_json, open(config_filename, 'w'))

    async def finish_processing():
        # Wait for geojson conversion here, then add bbox to regionMapping entries, generate regionids and generate vector tiles
        async with geojson_tempfile as geojson_filename:
            # Start tippecanoe
            tippecanoe_future = await generate_tiles(geojson_filename, layer_name, generate_tiles_to)

            # Calculate bounding box upadte regionMapping entries, then write to file
            geojson_ds = ogr.GetDriverByName('GeoJSON').Open(geojson_filename)
            geojson_layer = geojson_ds.GetLayer()
            w, e, s, n = geojson_layer.GetExtent()
            for entry in regionMapping_entries.values():
                entry['bbox'] = [w, s, e, n]
            # Make regionMapping file
            regionMapping_filename = os.path.join('output_files', 'regionMapping-{0}.json'.format(layer_name))
            json.dump({'regionWmsMap': regionMapping_entries}, open(regionMapping_filename, 'w'), indent=4)

            # Make regionid files
            # Extract all the variables needed for the regionid files
            get_field = lambda i, field: geojson_layer.GetFeature(i).GetField(field)
            # Doesn't assume that fids are sequential
            # Make a dict of the attributes from the features first, then put them in the right order
            regionID_values_dict = {get_field(i, fid_attribute): tuple(get_field(i, column) for column in regionId_columns) for i in range(num_features)}
            # The FID attribute has already been checked to allow this transformation
            regionID_values = [regionID_values_dict[i] for i in range(num_features)]
            for column, values in zip(regionId_columns, zip(*regionID_values)):
                regionId_json = OrderedDict([ # Make string comparison of files possible
                    ('layer', layer_name),
                    ('property', column),
                    ('values', list(values))
                ])
                regionId_filename = os.path.join('output_files', 'region_map-{0}_{1}.json'.format(layer_name, column))
                json.dump(regionId_json, open(regionId_filename, 'w'))
            geojson_layer = None
            geojson_ds = None
            await tippecanoe_future # Wait for tippecanoe to finish before destroying the geojson file
        await asyncio.gather(*test_csv_futures) # Wait for csv generation to finish (almost definitely finished by here anyway, but correctness yay)
        return layer_name

    return finish_processing() # Return a future to a future to the layer_name

async def main():
    # geometries = ['geoserver_shapefiles/FID_SA4_2011_AUST.shp']
    geometries = sys.argv[1:] or request_input('Which geometries do you want to add? Seperate geometry files with a comma and space', '').split(', ')
    finished_layers = await asyncio.gather(*[await create_layer(geometry_file) for geometry_file in geometries])

    s3 = boto3.resource('s3')
    bucket = s3.Bucket('vector-tile-server')
    for layer_name in finished_layers:
        # Get the highest version of this layer and add 1
        maxversion = max([int(re.search(r'v(\d*).json$', obj.key).group(1)) for obj in bucket.objects.filter(Prefix='config/{}'.format(layer_name))] + [0]) # Default to 0
        print('Uploading {}-v{} to S3'.format(layer_name, maxversion+1))

        bucket.upload_file('config/{}.json'.format(layer_name), 'config/{}-v{}.json'.format(layer_name, maxversion+1))
        bucket.upload_file('data/{}.mbtiles'.format(layer_name), 'mbtiles/{}-v{}.mbtiles'.format(layer_name, maxversion+1))


if __name__ == '__main__':
    # Create folders if they don't exist
    for directory in ['data', 'config', 'output_files', 'temp']:
        try:
            os.mkdir(directory)
        except OSError as err:
            if err.errno == errno.EEXIST and os.path.isdir(directory):
                pass
            else:
                raise

    loop = asyncio.get_event_loop()
    loop.run_until_complete(main())
    loop.close()

    #create_layer('geoserver_shapefiles/CED_2016_AUST.shp')

