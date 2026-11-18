#!/bin/sh
# Screenshot of $ANDROID_SERIAL into the given PNG path.
set -eu
: "${ANDROID_SERIAL:?set ANDROID_SERIAL}"
mkdir -p "$(dirname "$1")"
"${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb" -s "$ANDROID_SERIAL" exec-out screencap -p > "$1"
