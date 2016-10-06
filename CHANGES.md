Change Log
==========

### 1.0.0

* Add interactive Python scripts to make adding shapefile layers and deploying easier
* Move user data out of aws-template.json
* Download individual layers on newly deployed servers according to a deployment configuration file in S3 (unique to each deployment)

### 0.3.0

* Change config.json into a directory so that configuration can be split over multiple files (for easily adding/removing layers)
* Add minimum and maximum zoom to regionMapping.json
* Add Cache-Control headers to encourage browsers to query the server less
* Add script to help with replacing paths when moving the data directory (e.g. to the server)

### 0.2.0

* Semi-stable release
