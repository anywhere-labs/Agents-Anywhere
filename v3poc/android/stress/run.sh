#!/bin/sh
# Stress run of the Android PoC on ONE emulator, named by $ANDROID_SERIAL (never any other device). From anywhere:
#
#   ANDROID_SERIAL=emulator-5556 v3poc/android/stress/run.sh <name> <seconds> <stress spec> [options]
#     --interact            scroll up / hold / 到底部 / fling / drawer open-close with `adb shell input`, every 60 s
#     --kill-web <s>        kill -9 the WebView renderer process (sandboxed_process) after s seconds (needs `adb root`)
#     --switch <spec>       select sessions at these seconds, e.g. s-release@60,s-stress@75
#     --cache-items <n>     items the session cache keeps (default 300), like iOS AA_POC_CACHE_ITEMS
#     --trim-memory <s,s>   `am send-trim-memory` at these seconds: RUNNING_LOW, then RUNNING_CRITICAL
#     --approve <s>         auto-approve after s seconds (default 1)
#     --no-build            reuse the last APK
#
# Writes .local-dev/v3poc/android/stress/<name>/: app.log (logcat, tag AAv3PoC, [stress] lines), app.log.test.log
# (driver actions), mem.csv (top every ~3 s: app and renderer RSS / CPU), pss.csv (dumpsys meminfo every 30 s),
# shots/*.png every 30 s, crashes.txt, summary.md. Same layout as v3poc/ios/stress, so compare.py takes both.
set -u
: "${ANDROID_SERIAL:?set ANDROID_SERIAL, e.g. emulator-5556}"
export ANDROID_SERIAL
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
AND=$ROOT/v3poc/android
SDK=${ANDROID_HOME:-$HOME/Library/Android/sdk}
ADB="$SDK/platform-tools/adb"
PKG=dev.agentsanywhere.v3poc
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}

NAME=$1; SECONDS_TOTAL=$2; SPEC=$3; shift 3
INTERACT=0; KILL_WEB=""; SWITCH=""; APPROVE=1; BUILD=1; CACHE=""; TRIM=""
while [ $# -gt 0 ]; do
  case $1 in
    --interact) INTERACT=1 ;;
    --kill-web) KILL_WEB=$2; shift ;;
    --switch) SWITCH=$2; shift ;;
    --cache-items) CACHE=$2; shift ;;
    --trim-memory) TRIM=$2; shift ;;
    --approve) APPROVE=$2; shift ;;
    --no-build) BUILD=0 ;;
  esac
  shift
done

if [ $BUILD = 1 ]; then
  (cd "$AND" && ./gradlew -q assembleRelease) > /tmp/aav3poc-android-stress-build.log 2>&1 || { echo "build failed: /tmp/aav3poc-android-stress-build.log"; exit 1; }
fi
# Release (not debuggable): a debuggable app runs its Kotlin in a slower ART mode and would skew encode / frame times.
APK=$AND/app/build/outputs/apk/release/app-release.apk
OUT=$ROOT/.local-dev/v3poc/android/stress/$NAME
rm -rf "$OUT"; mkdir -p "$OUT/shots"
LOG=$OUT/app.log; ACT=$LOG.test.log
: > "$ACT"
act() { echo "{\"wall\":$(date +%s),\"action\":\"$1\"}" >> "$ACT"; }

"$ADB" install -r "$APK" > /dev/null || exit 1
"$ADB" shell cmd uimode night no > /dev/null
"$ADB" shell settings put system font_scale 1.0
if [ -n "$KILL_WEB" ]; then "$ADB" root > /dev/null 2>&1; sleep 2; "$ADB" wait-for-device; fi
echo "renderer: $(unzip -l "$APK" assets/renderer/renderer.html | awk 'NR==4 {print $1, $2, $3}')" > "$OUT/run.txt"
echo "spec: $SPEC interact=$INTERACT kill-web=$KILL_WEB switch=$SWITCH cache-items=$CACHE trim-memory=$TRIM seconds=$SECONDS_TOTAL device=$ANDROID_SERIAL ($("$ADB" emu avd name 2>/dev/null | head -1 | tr -d '\r'))" >> "$OUT/run.txt"
echo "webview: $("$ADB" shell dumpsys webviewupdate | grep -m1 'Current WebView package' | tr -d '\r')" >> "$OUT/run.txt"

"$ADB" shell am force-stop $PKG
"$ADB" logcat -c
"$ADB" logcat -v raw -s AAv3PoC:I > "$LOG" 2>/dev/null &
LOGCAT=$!
set -- --es stress "$SPEC" --ei auto_approve_seconds "$APPROVE"
[ -n "$SWITCH" ] && set -- "$@" --es switch "$SWITCH"
[ -n "$CACHE" ] && set -- "$@" --ei cache_items "$CACHE"
act launch
"$ADB" shell am start -W -n $PKG/.MainActivity --ez demo true "$@" > /dev/null
act launched

rpid() { "$ADB" shell ps -A -o PID,NAME | awk '/sandboxed_process/ {print $1}' | tail -1 | tr -d '\r'; }
interact() { # one cycle, ~35 s, at second $1 of every minute (like the iOS StressInteractionTests)
  act "read: scroll up"
  for _ in 1 2 3; do "$ADB" shell input swipe 540 800 540 1800 250; sleep 0.5; done
  act "read: hold 10 s"; sleep 10; act "read: hold end"
  P=$(grep '"name":"pill"' "$LOG" | tail -1)
  X=$(echo "$P" | grep -o '"x":[0-9]*' | cut -d: -f2); Y=$(echo "$P" | grep -o '"y":[0-9]*' | cut -d: -f2)
  act "pill: tap"; "$ADB" shell input tap "${X:-540}" "${Y:-1900}"; act "pill: tapped"
  sleep 3; act "fling"
  for _ in 1 2 3; do "$ADB" shell input swipe 540 900 540 1700 60; sleep 1; "$ADB" shell input swipe 540 1700 540 900 60; sleep 1; done
  act "fling end"
  act "drawer: open"; "$ADB" shell input swipe 5 1200 750 1200 300; sleep 2
  act "drawer: close"; "$ADB" shell input swipe 1000 1200 150 1200 300; sleep 1; act "drawer: closed"
}

echo "t,app_pid,app_rss_mb,app_cpu,wcp_pid,wcp_rss_mb,wcp_cpu" > "$OUT/mem.csv"
echo "t,app_pss_mb,renderer_pss_mb" > "$OUT/pss.csv"
START=$(date +%s); KILLED=0; NEXT_SHOT=0; NEXT_CYCLE=15; TRIM_STEP=1
while :; do
  NOW=$(( $(date +%s) - START ))
  [ "$NOW" -ge "$SECONDS_TOTAL" ] && break
  APID=$("$ADB" shell pidof $PKG | tr -d '\r'); WPID=$(rpid)
  if [ -n "$APID" ]; then
    TOP=$("$ADB" shell top -b -n 2 -d 1 -p "$APID${WPID:+,$WPID}" -o PID,RES,%CPU | tr -d '\r' | awk '$1 ~ /^[0-9]+$/' | tail -n "$([ -n "$WPID" ] && echo 2 || echo 1)")
    mb() { echo "$TOP" | awk -v p="$1" '$1 == p { v = $2; if (v ~ /G$/) v = v * 1024; else if (v ~ /M$/) v = v + 0; else v = v / 1024; printf "%.1f,%s", v, $3 }'; }
    echo "$NOW,$APID,$(mb "$APID" || echo ,),${WPID:-},$( [ -n "$WPID" ] && mb "$WPID" || echo ,)" >> "$OUT/mem.csv"
  fi
  if [ "$NOW" -ge "$NEXT_SHOT" ]; then
    "$ADB" exec-out screencap -p > "$OUT/shots/$(printf %04d "$NOW").png"
    AP=$("$ADB" shell dumpsys meminfo "$PKG" | awk '/TOTAL PSS:/ {print $3; exit}' | tr -d '\r')
    RP=$([ -n "$WPID" ] && "$ADB" shell dumpsys meminfo "$WPID" | awk '/TOTAL PSS:/ {print $3; exit}' | tr -d '\r')
    echo "$NOW,$(awk -v k="${AP:-0}" 'BEGIN {printf "%.1f", k / 1024}'),$(awk -v k="${RP:-0}" 'BEGIN {printf "%.1f", k / 1024}')" >> "$OUT/pss.csv"
    NEXT_SHOT=$(( NEXT_SHOT + 30 ))
  fi
  if [ -n "$KILL_WEB" ] && [ $KILLED = 0 ] && [ "$NOW" -ge "$KILL_WEB" ] && [ -n "$WPID" ]; then
    "$ADB" shell kill -9 "$WPID" && act "kill -9 renderer $WPID"; KILLED=1
  fi
  if [ -n "$TRIM" ]; then
    T=$(echo "$TRIM" | cut -d, -f$TRIM_STEP)
    if [ -n "$T" ] && [ "$NOW" -ge "$T" ]; then
      L=$([ $TRIM_STEP = 1 ] && echo RUNNING_LOW || echo RUNNING_CRITICAL)
      "$ADB" shell am send-trim-memory $PKG $L > /dev/null 2>&1; act "send-trim-memory $L"; TRIM_STEP=$(( TRIM_STEP + 1 ))
    fi
  fi
  if [ $INTERACT = 1 ] && [ "$NOW" -ge "$NEXT_CYCLE" ] && [ $(( SECONDS_TOTAL - NOW )) -gt 40 ]; then
    interact; NEXT_CYCLE=$(( NEXT_CYCLE + 60 ))
  fi
  sleep 1
done

"$ADB" exec-out screencap -p > "$OUT/shots/end.png"
"$ADB" logcat -d -b crash > "$OUT/crash-buffer.txt" 2>/dev/null
{
  grep -h -E "FATAL EXCEPTION|ANR in|Fatal signal" "$OUT/crash-buffer.txt" 2>/dev/null
  "$ADB" logcat -d | grep -E "ANR in $PKG|tile memory limits exceeded" | sort | uniq -c | head -5
} > "$OUT/crashes.txt"
"$ADB" shell am force-stop $PKG
kill $LOGCAT 2>/dev/null
[ -n "$KILL_WEB" ] && "$ADB" unroot > /dev/null 2>&1
python3 -I "$AND/stress/summarize.py" "$OUT" > "$OUT/summary.md"
echo "$OUT"; head -30 "$OUT/summary.md"
