# Python script to automate conversion of region mapping from WMS to Tessera server
# Pass regionMapping.json as an argument as follows:
#
#    python setup.py path/to/regionMapping.json
#

import json
import sys
import urllib.request
import zipfile
import subprocess
import os

directory = 'data2/'

regionMapping = json.load(open(sys.argv[1]))

print(list(regionMapping.keys()))

processedLayers = set()

generate_data_xml = lambda layerName: """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE Map[]>
<Map srs="+proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 +y_0=0.0 +k=1.0 +units=m +nadgrids=@null +wktext +no_defs +over">

<Parameters>
  <Parameter name="format">pbf</Parameter>
</Parameters>

<Layer name="{layerName}" buffer-size="8" srs="+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs">

    <Datasource>
       <Parameter name="file">{layerName}.shp</Parameter>
       <Parameter name="type">shape</Parameter>
    </Datasource>
  </Layer>

</Map>
""".format(layerName=layerName)

generate_url = lambda layerName: "http://geoserver.nationalmap.nicta.com.au:80/region_map/region_map/ows?service=WFS&version=1.0.0&request=GetFeature&typeName={layerName}&outputFormat=SHAPE-ZIP".format(layerName=layerName)

configJSON = {}

for k,v in regionMapping['regionWmsMap'].items():
    try:
        layerName = v['layerName'].replace('region_map:', '')
        if layerName not in processedLayers:
            url = generate_url(v['layerName'])
            print('Downloading {}'.format(url))
            urllib.request.urlretrieve(url, directory + layerName + '.zip')

            print('Unzipping {}'.format(layerName + '.zip'))
            with zipfile.ZipFile(directory + layerName + '.zip', 'r') as z:
                z.extractall(path=directory + layerName + '/')

            print('Creating data.xml')
            with open(directory + layerName + '/data_test.xml', 'w') as f:
                f.write(generate_data_xml(layerName))

            dataXmlPath = os.path.abspath(directory + layerName + '/data_test.xml')
            mbtilesPath = os.path.abspath(directory + layerName + '/store_test.mbtiles')

            print('Generating tiles')
            subprocess.check_call(["node", "save_tiles.js", dataXmlPath, mbtilesPath, "0", "3"])
            configJSON['/' + layerName] = {"source": "mbtiles://" + mbtilesPath}

            processedLayers.add(layerName)
    except Exception as e:
        print(e)
        continue

json.dump(configJSON, open('config_test.json', 'w'))
