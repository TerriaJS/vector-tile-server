## Vector tile server commands:

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