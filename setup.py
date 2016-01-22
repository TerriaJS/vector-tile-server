# Python script to automate conversion of region mapping from geoserver to Tessera server
# Pass regionMapping.json as follows:
#
#    python setup.py path/to/regionMapping.json
#

import json
import sys
import urllib.request
import zipfile
import subprocess
import os
import concurrent.futures
from functools import partial

# Constants
const_maxZ = "20"
const_minZ = "0"
const_maxGenZ = "6"

const_processes = 5

directory = 'data2/'
regionMapping = json.load(open(sys.argv[1]))
processedLayers = set()

generate_data_xml = lambda layerName: """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE Map[]>
<Map srs="+proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 +y_0=0.0 +k=1.0 +units=m +nadgrids=@null +wktext +no_defs +over">

<Parameters>
  <Parameter name="format">pbf</Parameter>
  <Parameter name="bounds">96.816941408,-43.740509603,159.109219008,-9.142175977</Parameter>
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

tileGenerators = []

problemRegionMaps = []
with concurrent.futures.ProcessPoolExecutor() as processes:
    with concurrent.futures.ThreadPoolExecutor() as threads:
        for v in regionMapping.values():
            submit(download, v).add_done_callback
        executor.map(download_and_process, regionMapping.values())

for k,v in regionMapping['regionWmsMap'].items():
    try:
        layerName = v['layerName'].replace('region_map:', '')
        if layerName not in processedLayers:

            url = generate_url(v['layerName'])
            #print('Downloading {}'.format(url))
            urllib.request.urlretrieve(url, directory + layerName + '.zip')

            #print('Unzipping {}'.format(layerName + '.zip'))
            with zipfile.ZipFile(directory + layerName + '.zip', 'r') as z:
                z.extractall(path=directory + layerName + '/')

            path = os.path.abspath(directory + layerName)
            hybridJsonPath = path + '/hybrid.json'
            dataXmlPath = path + '/data.xml'
            mbtilesPath = path + '/store.mbtiles'

            if (len(tileGenerators) >= const_processes):
                print('Too many processes')
                print((('Finished' if tileGenerators[0][1].wait() == 0 else 'Error') + ' generating tiles for {}').format(tileGenerators[0][0]))
                del tileGenerators[0]

            tileGenerators.append((layerName, subprocess.Popen(["node", "save_tiles.js", dataXmlPath, mbtilesPath, const_minZ, const_maxGenZ])))
            print('Spawned tile generation process for {}'.format(layerName))
            #print('Creating data.xml')
            with open(dataXmlPath, 'w') as f:
                f.write(generate_data_xml(layerName))


            hybridJSON = {"sources": [
                {"source": "mbtiles://" + mbtilesPath, "minZ": const_minZ, "maxZ": const_maxGenZ},
                {"source": "bridge://" + dataXmlPath, "minZ": const_minZ, "maxZ": const_maxZ}
            ]}
            with open(hybridJsonPath, 'w') as f:
                json.dump(hybridJSON, f)

            configJSON['/' + layerName] = {"source": "hybrid://" + hybridJsonPath}

            processedLayers.add(layerName)
    except Exception as e:
        problemRegionMaps.append((layerName, e))
        print(e)
        continue

json.dump(configJSON, open('config_test.json', 'w'))

# Wait for all processes to finish
for t in tileGenerators:
    print((('Finished' if t[1].wait() == 0 else 'Error') + ' generating tiles for {}').format(t[0]))

print('Errors:\n- ' + '\n- '.join(problemRegionMaps))
