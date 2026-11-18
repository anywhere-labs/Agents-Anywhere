#!/bin/sh
# Kyant backdrop over the WebView, per WebView layer mode (none | hw | preraster | both), with the RELEASE build
# installed (a debuggable build makes every frame slow). Per mode: streaming + scrolling + drawer open/close while a
# 10 s screen recording runs, then gfxinfo (reset right before), tile-memory errors, ANR/FATAL, renderer PSS.
#   ANDROID_SERIAL=emulator-5556 [GLASS=blur|tint] tools/ab-weblayer.sh [modes...]
set -u
: "${ANDROID_SERIAL:?set ANDROID_SERIAL}"
ADB="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
PKG=dev.agentsanywhere.v3poc
OUT=$(cd "$(dirname "$0")/../../.." && pwd)/.local-dev/v3poc/android/weblayer-ab
mkdir -p "$OUT"
G=${GLASS:-blur}
for m in ${*:-none hw both}; do
  tag="$m-$G"
  "$ADB" logcat -c
  "$ADB" shell am start -S -W -n $PKG/.MainActivity --es web_layer "$m" --ei auto_approve_seconds 3 --es glass "$G" > /dev/null
  sleep 2
  "$ADB" shell dumpsys gfxinfo $PKG reset > /dev/null
  "$ADB" shell screenrecord --time-limit 10 /sdcard/ab.mp4 &
  REC=$!
  for r in 1 2 3; do
    "$ADB" shell input swipe 540 900 540 1700 250
    "$ADB" shell input swipe 540 1700 540 800 250
  done
  "$ADB" shell input swipe 5 1400 750 1400 300; sleep 1.2
  "$ADB" exec-out screencap -p > "$OUT/$tag-drawer.png"
  "$ADB" shell input tap 1000 1200; sleep 1.2
  "$ADB" shell input swipe 540 1700 540 800 250
  wait $REC
  "$ADB" pull /sdcard/ab.mp4 "$OUT/$tag.mp4" > /dev/null 2>&1
  "$ADB" exec-out screencap -p > "$OUT/$tag-end.png"
  "$ADB" shell dumpsys gfxinfo $PKG > "$OUT/$tag-gfxinfo.txt"
  RP=$("$ADB" shell ps -A -o PID,NAME | awk '/sandboxed_process/ {print $1}' | tail -1 | tr -d '\r')
  REN=$([ -n "$RP" ] && "$ADB" shell dumpsys meminfo "$RP" | awk '/TOTAL PSS:/ {print $3; exit}')
  APP=$("$ADB" shell dumpsys meminfo $PKG | awk '/TOTAL PSS:/ {print $3; exit}')
  TILES=$("$ADB" logcat -d | grep -c "tile memory limits")
  BAD=$("$ADB" logcat -d | grep -cE "FATAL EXCEPTION|ANR in")
  J=$(grep -m1 -E "Janky frames:" "$OUT/$tag-gfxinfo.txt" | sed 's/^ *//')
  P=$(grep -E "^(50|90|99)th" "$OUT/$tag-gfxinfo.txt" | head -3 | tr '\n' ' ')
  echo "$tag: tiles=$TILES fatal/anr=$BAD appPSS=$((${APP:-0}/1024))MB rendererPSS=$((${REN:-0}/1024))MB $J $P" | tee -a "$OUT/summary-release.txt"
done
