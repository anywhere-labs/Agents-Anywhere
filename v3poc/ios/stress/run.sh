#!/bin/sh
# Stress run of the iOS PoC on its own simulator. Usage (from the repository root):
#
#   v3poc/ios/stress/run.sh <name> <seconds> <AA_POC_STRESS spec> [options]
#     --interact          drive scrolling / 到底部 / drawer with the StressInteractionTests UI test
#     --kill-web <s>      kill -9 the WebContent process after s seconds (recovery check)
#     --switch <spec>     AA_POC_SWITCH, e.g. s-release@60,s-stress@70
#     --env K=V           another AA_POC_* variable for the app (repeatable), e.g. --env AA_POC_CACHE_ITEMS=3000
#     --memory-warning <s,s>  AA_POC_MEMORY_WARNING: system memory warnings at these seconds (two within 30 s = critical)
#     --approve <s>       AA_POC_AUTO_APPROVE_SECONDS (default 1)
#     --no-build          reuse the last build
#
# Writes .local-dev/v3poc/ios/stress/<name>/: app.log ([stress] lines), mem.csv (2 s samples of the app and WebContent
# processes), shots/*.png every 30 s, crashes.txt, summary.md (stress/summarize.py). Never touches other simulators: the
# device "AAv3PoC Stress" is created (iPhone 18 Pro) when missing; delete it afterwards with --delete-device as $1.
set -u
export DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
DEVICE_NAME="AAv3PoC Stress"
DD=/tmp/aav3poc-dd-stress

udid() { xcrun simctl list devices | grep "$DEVICE_NAME (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/'; }

if [ "${1:-}" = "--delete-device" ]; then
  U=$(udid); [ -n "$U" ] && xcrun simctl shutdown "$U" 2>/dev/null; [ -n "$U" ] && xcrun simctl delete "$U" && echo "deleted $U"
  exit 0
fi

NAME=$1; SECONDS_TOTAL=$2; SPEC=$3; shift 3
INTERACT=0; KILL_WEB=""; SWITCH=""; APPROVE=1; BUILD=1; MEMWARN=; EXTRA=
while [ $# -gt 0 ]; do
  case $1 in
    --interact) INTERACT=1 ;;
    --kill-web) KILL_WEB=$2; shift ;;
    --switch) SWITCH=$2; shift ;;
    --memory-warning) MEMWARN=$2; shift ;;
    --env) EXTRA="$EXTRA $2"; shift ;;
    --approve) APPROVE=$2; shift ;;
    --no-build) BUILD=0 ;;
  esac
  shift
done

U=$(udid)
if [ -z "$U" ]; then
  RT=$(xcrun simctl list runtimes | grep -o "com.apple.CoreSimulator.SimRuntime.iOS-[0-9-]*" | tail -1)
  U=$(xcrun simctl create "$DEVICE_NAME" com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro "$RT")
fi
xcrun simctl boot "$U" 2>/dev/null
xcrun simctl bootstatus "$U" -b >/dev/null
xcrun simctl spawn "$U" defaults write com.apple.keyboard.preferences DidShowContinuousPathIntroduction -bool true
xcrun simctl status_bar "$U" override --time 9:41 --batteryState charged --batteryLevel 100 >/dev/null 2>&1

if [ $BUILD = 1 ]; then
  xcodebuild -project "$ROOT/v3poc/ios/AAv3PoC.xcodeproj" -scheme AAv3PoC -destination "id=$U" -derivedDataPath $DD \
    CODE_SIGNING_ALLOWED=NO build-for-testing > /tmp/aav3poc-stress-bft.log 2>&1 || { echo "build failed: /tmp/aav3poc-stress-bft.log"; exit 1; }
fi
APP=$DD/Build/Products/Debug-iphonesimulator/AAv3PoC.app

OUT=$ROOT/.local-dev/v3poc/ios/stress/$NAME
rm -rf "$OUT"; mkdir -p "$OUT/shots"
LOG=$OUT/app.log
ls ~/Library/Logs/DiagnosticReports/ | grep AAv3PoC | sort > "$OUT/.crashes-before"
echo "renderer: $(ls -la "$APP/renderer.html" | awk '{print $5, $6, $7, $8}')" > "$OUT/run.txt"
echo "spec: $SPEC interact=$INTERACT kill-web=$KILL_WEB switch=$SWITCH memory-warning=$MEMWARN seconds=$SECONDS_TOTAL device=$U" >> "$OUT/run.txt"

xcrun simctl terminate "$U" dev.agentsanywhere.v3poc 2>/dev/null
xcrun simctl install "$U" "$APP"

for kv in $EXTRA; do export "SIMCTL_CHILD_$kv" "TEST_RUNNER_$kv"; done
echo "env:$EXTRA" >> "$OUT/run.txt"
if [ $INTERACT = 1 ]; then
  TEST_RUNNER_AA_POC_STRESS=$SPEC TEST_RUNNER_AA_POC_LOG_PATH=$LOG TEST_RUNNER_AA_POC_STRESS_SECONDS=$SECONDS_TOTAL \
  TEST_RUNNER_AA_POC_AUTO_APPROVE_SECONDS=$APPROVE TEST_RUNNER_AA_POC_SWITCH=$SWITCH TEST_RUNNER_AA_POC_SCHEME=light TEST_RUNNER_AA_POC_MEMORY_WARNING=$MEMWARN \
    xcodebuild -project "$ROOT/v3poc/ios/AAv3PoC.xcodeproj" -scheme AAv3PoC -destination "id=$U" -derivedDataPath $DD \
    CODE_SIGNING_ALLOWED=NO test-without-building -only-testing:AAv3PoCUITests/StressInteractionTests > "$OUT/xctest.log" 2>&1 &
  DRIVER=$!
else
  SIMCTL_CHILD_AA_POC_STRESS=$SPEC SIMCTL_CHILD_AA_POC_LOG_PATH=$LOG SIMCTL_CHILD_AA_POC_AUTO_APPROVE_SECONDS=$APPROVE \
  SIMCTL_CHILD_AA_POC_SWITCH=$SWITCH SIMCTL_CHILD_AA_POC_SCHEME=light SIMCTL_CHILD_AA_POC_MEMORY_WARNING=$MEMWARN \
    xcrun simctl launch "$U" dev.agentsanywhere.v3poc > /dev/null
  DRIVER=""
fi

echo "t,app_pid,app_rss_mb,app_cpu,wcp_pid,wcp_rss_mb,wcp_cpu" > "$OUT/mem.csv"
START=$(date +%s)
KILLED=0
while :; do
  NOW=$(( $(date +%s) - START ))
  [ $NOW -ge "$SECONDS_TOTAL" ] && break
  APID=$(pgrep -f "$U/data/Containers/Bundle/Application/.*/AAv3PoC.app/AAv3PoC" | head -1)
  WPID=$(grep '"k":"wcp"' "$LOG" 2>/dev/null | tail -1 | grep -o '"pid":[0-9]*' | cut -d: -f2)
  A=$( [ -n "$APID" ] && ps -o rss=,%cpu= -p "$APID" | awk '{printf "%.1f,%s", $1/1024, $2}' )
  W=$( [ -n "$WPID" ] && ps -o rss=,%cpu= -p "$WPID" 2>/dev/null | awk '{printf "%.1f,%s", $1/1024, $2}' )
  echo "$NOW,${APID:-},${A:-,},${WPID:-},${W:-,}" >> "$OUT/mem.csv"
  if [ $(( NOW % 30 )) -lt 2 ]; then xcrun simctl io "$U" screenshot "$OUT/shots/$(printf %04d $NOW).png" >/dev/null 2>&1; fi
  if [ -n "$KILL_WEB" ] && [ $KILLED = 0 ] && [ $NOW -ge "$KILL_WEB" ] && [ -n "$WPID" ]; then
    kill -9 "$WPID" && echo "{\"wall\":$(date +%s),\"action\":\"kill -9 WebContent $WPID\"}" >> "$LOG.test.log"; KILLED=1
  fi
  sleep 2
done

xcrun simctl io "$U" screenshot "$OUT/shots/end.png" >/dev/null 2>&1
[ -n "$DRIVER" ] && wait $DRIVER
xcrun simctl terminate "$U" dev.agentsanywhere.v3poc 2>/dev/null
sleep 2
ls ~/Library/Logs/DiagnosticReports/ | grep AAv3PoC | sort | comm -13 "$OUT/.crashes-before" - > "$OUT/crashes.txt"
rm -f "$OUT/.crashes-before"
python3 -I "$ROOT/v3poc/ios/stress/summarize.py" "$OUT" > "$OUT/summary.md"
echo "$OUT"; head -60 "$OUT/summary.md"
