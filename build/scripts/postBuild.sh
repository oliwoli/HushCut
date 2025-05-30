#!/bin/bash
set -e

echo "Copying PyInstaller output to build/bin..."
SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
cd "$SCRIPT_DIR/../../"

DIST_DIR="dist/main"
TARGET_DIR="build/bin"

mkdir -p "$TARGET_DIR"

rm -rf "$TARGET_DIR/_internal"
mv -f "$DIST_DIR/main" "$TARGET_DIR/python_backend"
mv -f "$DIST_DIR/_internal" "$TARGET_DIR/"
rm -rf build/main
rm -rf dist