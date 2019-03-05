#!/usr/bin/env python3
# Written for Python 3.6
from __future__ import print_function

from datetime import date
import re, json, base64

import boto3

from common import request_input, yes_no_to_bool

# Walk user through choosing layers (and versions of layers)
# Allow them to choose to create a deployment from another deployment or to choose all latest or choose individual versions

deployment_name = request_input('What is the name of this deployment?', date.today().strftime('vector-tiles-%Y-%m-%d'))
method = request_input('Create new deployment from previous deployment (p), arbitrary layers (l) or with all latest layers (a)?', 'p')

print('Connecting to and analysing S3 bucket')

terria_aws = boto3.session.Session(profile_name='terria')

# Get all layers currently on the server
s3 = terria_aws.resource('s3')
s3c = terria_aws.client('s3')
bucket = s3.Bucket('vector-tile-server')
keys = [re.search(r'config/(.*)-v(\d*).json$', obj.key).groups() for obj in bucket.objects.filter(Prefix='config/')]

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
    old_deployments = sorted([re.search(r'deployments/(.*).json$', key.key).group(1) for key in bucket.objects.filter(Prefix='deployments/')], reverse=True)
    old_deployment = request_input('Out of {}, which old deployment do you want to use?'.format(', '.join(old_deployments)), old_deployments[0])
    obj = s3c.get_object(Bucket=bucket.name, Key='deployments/{}.json'.format(old_deployment))
    old_data = json.loads(obj['Body'].read().decode('utf-8'))["data"]
    all_layers = set(latest_layers.keys()) | set(old_data.keys())
    changed_layers = [(layer, old_data.get(layer, 0), latest_layers.get(layer, 0)) for layer in all_layers if old_data.get(layer, 0) != latest_layers.get(layer, 0)]
    if changed_layers:
        print('The following layers are different in the old deployment from the "most current" layers in S3:')
        print('Note: a version of 0 signifies a missing layer either in the old deployment or currently in the S3 bucket')
        print('\n'.join('{:40}  {:5}  {:5}'.format(*t) for t in [('Layer name', 'Old v', 'New v')] + changed_layers))
    remove = [layer.strip() for layer in request_input('Which layers do you want to remove? Separate layers with a comma:', '').split(',') if layer.strip() != '']
    for layer in remove:
        del old_data[layer]
    add = [layer_str.strip().split(':') for layer_str in request_input('Which layers do you want to add/change versions? Format layers like layer_name:version and separate layers with a comma:', '').split(',') if layer_str.strip() != '']
    for layer, version in add:
        old_data[layer] = int(version)
    deployment_data = old_data
elif method == 'l':
    print('The following layers are available:')
    print('\n'.join('{:40}  {:7}'.format(*t) for t in [('Layer name', 'Version')] + list(latest_layers.items())))
    deployment_data = dict([(layer_str.split(':')[0], int(layer_str.split(':')[1])) for layer_str in filter(None, request_input('Which layers do you want to add/change versions? Format layers like layer_name:version and separate layers with a comma and space:', '').split(', '))])

key = 'deployments/{}.json'.format(deployment_name)
obj = s3c.put_object(
    Bucket=bucket.name,
    Key=key,
    Body=json.dumps({"data": deployment_data}).encode('utf-8')
)
if yes_no_to_bool(request_input('Deployment file {} uploaded to S3. Start an EC2 with this deployment configuration?'.format(key), 'y'), False):
    # Retrive user-data and template from S3
    server_versions = sorted([re.search(r'server-(.*).tar.gz$', key.key).group(1) for key in bucket.objects.filter(Prefix='server-')], key=lambda s: [int(n) for n in s.split('.')], reverse=True)
    server_version = request_input('Out of {}, which server version do you want to use?'.format(', '.join(server_versions)), server_versions[0])

    userdata = open('user-data').read().replace('{~STACK NAME~}', deployment_name).replace('{~SERVER VERSION~}', server_version)
    template = open('aws-template.json').read().replace('{~BASE64 USER DATA~}', base64.b64encode(userdata.encode('utf-8')).decode('utf-8'))

    cfn = terria_aws.client('cloudformation', region_name='ap-southeast-2')
    cfn.create_stack(StackName=deployment_name, TemplateBody=template, Capabilities=['CAPABILITY_IAM'])
    print('Stack {} created'.format(deployment_name))

