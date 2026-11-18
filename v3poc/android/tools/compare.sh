#!/bin/sh
# Takes the seven iOS comparison screens on $ANDROID_SERIAL and puts them next to the iOS screenshots.
#   ANDROID_SERIAL=emulator-5556 tools/compare.sh [only-number]
# Output: .local-dev/v3poc/android/compare/NN-name.png (side by side) and android-NN-name.png (raw).
# Needs Pillow (PYTHON=/path/to/python with Pillow; default python3).
set -eu
: "${ANDROID_SERIAL:?set ANDROID_SERIAL, e.g. emulator-5556}"
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
ios="$repo/.local-dev/v3poc/ios"
out="$repo/.local-dev/v3poc/android/compare"
adb="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
py="${PYTHON:-python3}"
only="${1:-}"
mkdir -p "$out"

shot() { # number name night seconds extras...
  n=$1 name=$2 night=$3 wait=$4; shift 4
  [ -n "$only" ] && [ "$only" != "$n" ] && return 0
  "$adb" shell cmd uimode night "$night" >/dev/null
  "$adb" shell settings put system font_scale 1.0
  "$adb" shell am start -S -W -n dev.agentsanywhere.v3poc/.MainActivity "$@" >/dev/null
  sleep "$wait"
  raw="$out/android-$n-$name.png"
  "$adb" exec-out screencap -p > "$raw"
  "$py" "$here/compare.py" "$ios/$n-$name.png" "$raw" "$out/$n-$name.png"
}

shot 01 midstream-light no 3
shot 02 approval-waiting no 10
shot 03 approved-final no 30 --ei auto_approve_seconds 2
shot 04 drawer no 4 --ez drawer true
shot 05 options-sheet no 5 --es sheet options
shot 06 dark-approval yes 10
shot 07 keyboard no 6 --ez focus true
"$adb" shell cmd uimode night no >/dev/null
