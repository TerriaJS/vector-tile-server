#!/bin/sh

OLD_DIR=$1
NEW_DIR=$2

find $NEW_DIR -name hybrid.json -exec sed -i.bak "s:$OLD_DIR:$NEW_DIR:g" {} \;
find $NEW_DIR -name config.json -exec sed -i.bak "s:$OLD_DIR:$NEW_DIR:g" {} \;