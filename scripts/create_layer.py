#!/usr/bin/env python3
# Written for Python 3.6

# Ideas:
# - Main function that converts 1 GeoJSON/shapefile to a vector tile layer with TerriaMap config and test files
# - Use asycnio

from contextlib import contextmanager
import os
import sys


from osgeo import ogr, osr

@contextmanager
def stdout_redirected(to):
    '''
    import os

    with stdout_redirected(to=filename):
        print("from Python")
        os.system("echo non-Python applications are also supported")
    '''
    fd = sys.stdout.fileno()

    ##### assert that Python and C stdio write using the same file descriptor
    ####assert libc.fileno(ctypes.c_void_p.in_dll(libc, "stdout")) == fd == 1

    def _redirect_stdout(to):
        sys.stdout.close() # + implicit flush()
        os.dup2(to.fileno(), fd) # fd writes to 'to' file
        sys.stdout = os.fdopen(fd, 'w') # Python writes to fd

    with os.fdopen(os.dup(fd), 'w') as old_stdout:
        _redirect_stdout(to=to)
        try:
            yield # allow code to be run with the redirected stdout
        finally:
            _redirect_stdout(to=old_stdout) # restore stdout.
                                            # buffering and flags such as
                                            # CLOEXEC may be different

def request_input(caption, default):
    'Request input from the user, returning default if no input is given'
    response = input('\x1b[94m' + '{} '.format(caption) + ('({}): '.format(default) if default else '') + '\x1b[0m')
    return response if response != '' else default


def unique_with_prop(data_source, layername, prop):
    'Determine if the property prop uniquely identifies every feature in the given layer of the DataSource'
    layer = data_source.ExecuteSQL('SELECT COUNT(DISTINCT {1}) / COUNT(*) AS allunique FROM {0}'.format(layername, prop), dialect='SQLITE') # If one enjoys SQL attacking one's own files, then go ahead
    return bool(layer.GetFeature(0).GetField('allunique'))


def create_layer(geometry_file):
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
    layer_name = request_input('Which layer should be used?', layers[0] if len(layers) == 1 else '')

    if layer_name not in layers:
        print('Layer {} is not in file {}'.format(layer_name, geometry_file))
        return

    layer = data_source.GetLayerByName(layer_name)
    generate_tiles_to = int(request_input('What zoom level should tiles be generated to?', 12))
    layer_defn = layer.GetLayerDefn()
    attributes = [layer_defn.GetFieldDefn(i).name for i in range(layer_defn.GetFieldCount())]
    print('Attributes in file: {}'.format(', '.join(attributes)))
    has_fid = yes_no_to_bool(request_input('Is there an FID attribute?', 'n'), False)
    # Ask for the current FID attribute if there is one, otherwise add an FID and use that
    fid_attribute = request_input('Which attribute should be used as an FID?', 'FID') if has_fid else 'FID'
    server_url = request_input('Where is the vector tile server hosted?', 'http://localhost:8000/{}/{{z}}/{{x}}/{{y}}.pbf'.format(layername))
    regionMapping_entries = OrderedDict()
    regionMapping_entry_name = request_input('Name another regionMapping.json entry (leave blank to finish)', '')
    while regionMapping_entry_name != '':
        o = OrderedDict()
        o['layerName'] = layer_name # Set in addRegionMap.js
        o['server'] = server_url
        o['regionProp'] = request_input('Which attribute should be used as the region property?', '')
        # Test this property
        if not unique_with_prop(shapefile, layername, o['regionProp']):
            o['disambigProp'] = request_input('The given region property does not uniquely define every region. Which attribute should be used to disambiguate region matching?', '')
            o['disambigRegionId'] = request_input('Which regionMapping definition does this disambiguation property come from?', '')
        else:
            print('The given region property uniquely defines each region.')
        o['aliases'] = request_input('What aliases should this be available under? Separate aliases with a comma and space', '').split(', ')
        o['description'] = description

        regionMapping_entries[regionMapping_entry_name] = o
        regionMapping_entry_name = request_input('Name another regionMapping.json entry (leave blank to finish)', '')

    # Generate config files and tiles

    # Start tippecanoe
    p = subprocess.Popen(['tippecanoe', '-q', '-f', '-P', '-pp', '-pS', '-l', 'test', '-z', '12', '-d', '20', '-o', 'test.mbtiles'], stdin=subprocess.PIPE)

    # Redirect C library stdout output to tippecanoe
    with stdout_redirected(to=p.stdin):
        # Create a GeoJSON file that gets output to stdout (and redirected to tippecanoe)
        driver = ogr.GetDriverByName('GeoJSON')
        dest_srs = osr.SpatialReference()
        dest_srs.ImportFromEPSG(4326)
        out_ds = driver.CreateDataSource('/vsistdout/')
        # New polygon layer
        out_layer = out_ds.CreateLayer(layer_name, dest_srs, geom_type=ogr.wkbMultiPolygon)
        # Add an fid attribute if needed
        if not has_fid:
            fid_field = ogr.FieldDefn(fid_attribute, ogr.OFTInteger)
            out_layer.CreateField(fid_field)
        # Mirror inpput fields in output
        for i in range(layer_defn.GetFieldCount()):
            field_defn = layer_defn.GetFieldDefn(i)
            out_layer.CreateField(field_defn)

        # Get the output layer's feature definition
        out_layer_defn = out_layer.GetLayerDefn()
        # Iterate over features and add them to the output layer
        for fid, feature in enumerate(layer):
            out_feature = ogr.Feature(out_layer_defn)
            # Set fields
            for i in range(out_layer_defn.GetFieldCount()):
                field_defn = out_layer_defn.GetFieldDefn(i)
                field_name = field_defn.GetName()
                if not has_fid and field_name == fid_attribute:
                    # Set FID
                    out_feature.SetField(out_layer.GetFieldDefn(i).GetNameRef(), fid)
                else:
                    # Copy field value
                    out_feature.SetField(out_layer.GetFieldDefn(i).GetNameRef(), feature.GetField(layer_defn.GetFieldIndex(out_layer.GetFieldDefn(i).name)))
            # Set geometry
            geom = inFeature.GetGeometryRef()
            out_feature.SetGeometry(geom.Clone())
            # Add new feature to output layer
            out_layer.CreateFeature(out_feature)
            out_feature = None

        data_source = None
        out_ds = None
    p.stdin.close()
    p.wait()



