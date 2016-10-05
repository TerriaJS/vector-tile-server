## Commands to spawn servers:

For spawning a new server use the following (filling in %variables% with the correct values):

```
aws cloudformation create-stack --stack-name vector-tiles-%DATE% --template-body file:///Users/dav661/Data61/vector-tile-server/aws-template.json --capabilities CAPABILITY_IAM --parameters ParameterKey=ServerVersion,ParameterValue=%SERVER_VERSION%
```

To set up an alias:
```
aws cloudformation create-stack --stack-name vector-tiles-test-alias --template-body file:///Users/dav661/Data61/vector-tile-server/aws-alias.json --parameters ParameterKey=StackName,ParameterValue=vector-tiles-%DATE% ParameterKey=Alias,ParameterValue=test.vector-tiles
```


## Commands to run on vector tile server to make tarballs:

For making a server tarball and saving to S3:
```
tar -czvf /tmp/server-0.1.1.tar.gz -C /etc/vector-tiles/ server package.json forever.json
aws s3 --region ap-southeast-2 cp /tmp/server-0.1.1.tar.gz s3://vector-tile-server/
```

For making a server data tarball and saving to S3:
```
tar -czvf /tmp/server-data-0.0.1.tar.gz -C /etc/vector-tiles/ data config
aws s3 --region ap-southeast-2 cp /tmp/server-data-0.0.1.tar.gz s3://vector-tile-server/
```