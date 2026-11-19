#!/bin/sh
# Copy the shared PoC fixtures into the app's synchronized source folder so they are bundled.
# Run after regenerating v3poc/fixtures (python3 -I v3poc/fixtures/build.py).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$HERE/AAv3PoC/Fixtures"
cp "$HERE/../fixtures/"*.json "$HERE/AAv3PoC/Fixtures/"
echo "Copied: $(ls "$HERE/AAv3PoC/Fixtures")"
