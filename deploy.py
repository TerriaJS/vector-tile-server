#!/usr/bin/env python

# Written for Python 2.7
from __future__ import print_function

from datetime import date
import re, json, base64

import boto
import boto.cloudformation
from boto.s3.key import Key
from common import request_input, yes_no_to_bool

# Walk user through choosing layers (and versions of layers)
# Allow them to choose to create a deployment from another deployment or to choose all latest or choose individual versions

name = request_input('What is the name of this deployment?', date.today().strftime('vector-tiles-%Y-%m-%d'))
method = request_input('Create new deployment from previous deployment (p), arbitrary layers (l) or with all latest layers (a)?', 'p')

print('Connecting to and analysing S3 bucket')

# Get all layers currently on the server
conn = boto.connect_s3()
bucket = conn.get_bucket('vector-tile-server')
keys = [re.search(r'config/(.*)-v(\d*).json$', key.key).groups() for key in bucket.list(prefix='config/')]

# Dictionary of all versions of each layer
all_versions = {}
for key, version in keys:
    all_versions[key] = all_versions.get(key, []) + [int(version)]

# Layers to use this deployment
deployment_data = {}

# Latest available layers
latest_layers = {}
for layer, versions in all_versions.items():
    latest_layers[layer] = max(versions)

if method == 'a':
    deployment_data = latest_layers
elif method == 'p':
    old_deployments = sorted([re.search(r'deployments/(.*).json$', key.key).group(1) for key in bucket.list(prefix='deployments/')], reverse=True)
    old_deployment = request_input('Out of {}, which old deployment do you want to use?'.format(', '.join(old_deployments)), old_deployments[0])
    k = Key(bucket)
    k.key = 'deployments/{}.json'.format(old_deployment)
    old_data = json.loads(k.get_contents_as_string())["data"]
    changed_layers = [(layer, old_data.get(layer, 0), latest_layers.get(layer, 0)) for layer in set(latest_layers.keys() + old_data.keys()) if old_data.get(layer, 0) != latest_layers.get(layer, 0)]
    if changed_layers:
        print('The following layers are different in the old deployment from the "most current" layers in S3:')
        print('Note: a version of 0 signifies a missing layer either in the old deployment or currently in the S3 bucket')
        print('\n'.join('{:40}  {:5}  {:5}'.format(*t) for t in [('Layer name', 'Old v', 'New v')] + changed_layers))
    remove = filter(None, request_input('Which layers do you want to remove? Separate layers with a comma and space:', '').split(', '))
    for layer in remove:
        del old_data[layer]
    add = [layer_str.split(':') for layer_str in filter(None, request_input('Which layers do you want to add/change versions? Format layers like layer_name:version and separate layers with a comma and space:', '').split(', '))]
    for layer, version in add:
        old_data[layer] = int(version)
    deployment_data = old_data
elif method == 'l':
    print('The following layers are available:')
    print('\n'.join('{:40}  {:7}'.format(*t) for t in [('Layer name', 'Version')] + list(latest_layers.items())))
    deployment_data = dict([(layer_str.split(':')[0], int(layer_str.split(':')[1])) for layer_str in filter(None, request_input('Which layers do you want to add/change versions? Format layers like layer_name:version and separate layers with a comma and space:', '').split(', '))])

k = Key(bucket)
k.key = 'deployments/{}.json'.format(name)
k.set_contents_from_string(json.dumps({"data": deployment_data}))
if yes_no_to_bool(request_input('Deployment file {} uploaded to S3. Start an EC2 with this deployment configuration?'.format(k.key), 'y'), False):
    # Retrive user-data and template from S3
    server_versions = sorted([re.search(r'server-(.*).tar.gz$', key.key).group(1) for key in bucket.list(prefix='server-')], key=lambda s: [int(n) for n in s.split('.')], reverse=True)
    server_version = request_input('Out of {}, which server version do you want to use?'.format(', '.join(server_versions)), server_versions[0])

    userdata = open('user-data').read().replace('{~STACK NAME~}', name).replace('{~SERVER VERSION~}', server_version)
    template = open('aws-template.json').read().replace('{~BASE64 USER DATA~}', base64.b64encode(userdata))

    cfn = boto.cloudformation.connect_to_region('ap-southeast-2') # Sydney
    cfn.create_stack(name, template_body=template, capabilities=['CAPABILITY_IAM'])
    print('Stack {} created'.format(name))

