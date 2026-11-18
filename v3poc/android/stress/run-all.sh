#!/bin/sh
# All Android stress tiers, one after another (they must not overlap: each one loads the emulator fully).
#   ANDROID_SERIAL=emulator-5556 v3poc/android/stress/run-all.sh [prefix]     (default prefix a1)
set -u
: "${ANDROID_SERIAL:?set ANDROID_SERIAL, e.g. emulator-5556}"
R=$(cd "$(dirname "$0")" && pwd)/run.sh
P=${1:-a1}
"$R" "$P-protocol" 360 items:3000,chars:3000,hz:3,parallel:1 --interact || exit 1
"$R" "$P-burst" 360 items:3000,chars:3000,hz:30,parallel:3 --interact --no-build
"$R" "$P-open3000" 120 snapshot:3000,items:0 --switch s-release@60,s-stress@75 --cache-items 3000 --no-build
"$R" "$P-open-cap300" 60 snapshot:3000,items:0 --no-build
"$R" "$P-kill" 180 items:3000,chars:3000,hz:30,parallel:3 --kill-web 90 --no-build
"$R" "$P-memwarn" 150 snapshot:3000,items:3000,chars:3000,hz:30,parallel:3 --trim-memory 60,65 --cache-items 3000 --no-build
