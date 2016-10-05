#!/usr/bin/env python

# Written for Python 2.7
from __future__ import print_function
import os, sys, json
import boto # Boto is included on Amazon Linux, Boto3 isn't
from boto.s3.key import Key

conn = boto.connect_s3()
bucket = conn.get_bucket('vector-tile-server')

deployment = sys.argv[1]

# Download deployment json
k = Key(bucket)
k.key = 'deployments/{}.json'.format(deployment)
k.get_contents_to_filename('/etc/vector-tiles/data.json')


with open('/etc/vector-tiles/data.json') as data_config:
    data = json.load(data_config)['data']

os.mkdir('/etc/vector-tiles/config')
os.mkdir('/etc/vector-tiles/data')

for layer, version in data.iteritems():
    print('Downloading {}'.format(layer))
    # Download config
    k1 = Key(bucket)
    k1.key = 'config/{}-v{}.json'.format(layer,version)
    k1.get_contents_to_filename('/etc/vector-tiles/config/{}.json'.format(layer))

    # Download mbtiles
    k2 = Key(bucket)
    k2.key = 'mbtiles/{}-v{}.mbtiles'.format(layer,version)
    k2.get_contents_to_filename('/etc/vector-tiles/data/{}.mbtiles'.format(layer))
