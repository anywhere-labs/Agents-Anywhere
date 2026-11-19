#!/bin/sh
# A/B of glass strategies over the WebView: for each web_glass mode, launch the demo (streaming + approval), scroll for
# ~35 s, then count Chromium tile-memory errors and read gfxinfo. Usage: ANDROID_SERIAL=emulator-5556 ab-glass.sh off full strip
set -eu
: "${ANDROID_SERIAL:?}"
ADB="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb -s $ANDROID_SERIAL"
OUT=${OUT:-$(cd "$(dirname "$0")/../../.." && pwd)/.local-dev/v3poc/android/glass-ab}
mkdir -p "$OUT"
for mode in "$@"; do
  $ADB logcat -c
  $ADB shell am start -S -W -n dev.agentsanywhere.v3poc/.MainActivity --ei auto_approve_seconds 3 --es web_glass "$mode" >/dev/null
  sleep 4
  $ADB shell dumpsys gfxinfo dev.agentsanywhere.v3poc reset >/dev/null
  i=0
  while [ $i -lt 8 ]; do
    $ADB shell input swipe 540 900 540 1500 300; sleep 1.2
    $ADB shell input swipe 540 1500 540 700 300; sleep 1.2
    i=$((i+1))
  done
  sleep 8
  $ADB exec-out screencap -p > "$OUT/$mode.png"
  $ADB shell input swipe 540 900 540 1600 250; sleep 0.4
  $ADB exec-out screencap -p > "$OUT/$mode-scrolling.png"
  tiles=$($ADB logcat -d | grep -c "tile memory limits" || true)
  $ADB shell dumpsys gfxinfo dev.agentsanywhere.v3poc > "$OUT/$mode-gfxinfo.txt"
  jank=$(grep -E "Janky frames:|50th percentile|90th percentile|99th percentile|Total frames" "$OUT/$mode-gfxinfo.txt" | head -5 | tr -s ' ' | tr '\n' ';')
  echo "$mode: tile_errors=$tiles $jank" | tee -a "$OUT/summary.txt"
done
