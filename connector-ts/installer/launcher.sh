#!/bin/sh
# ported from effi-crew cloud/installer/launcher.sh @30f8334.
# Runs the current Connector and keeps it running (a macOS LaunchAgent or systemd --user unit starts this):
#   exit 75       → an update is staged (<app>/pending): switch `current` to it and start it;
#   exit 0        → stopped on purpose: stop too;
#   anything else → start again, a little later each time; a new version that fails 3 times within two minutes
#                   goes back to the previous one.
APP="$(cd "$(dirname "$0")" && pwd -P)"
export AA_CONNECTOR_APP_ROOT="$APP"
fails=0
switch() { ln -sfn "$1" "$APP/current"; }
while :; do
  if [ -f "$APP/pending" ]; then
    v="$(cat "$APP/pending")"; rm -f "$APP/pending"
    if [ -f "$APP/versions/$v/VERSION" ]; then
      readlink "$APP/current" > "$APP/previous" 2>/dev/null || true
      switch "versions/$v"; fails=0
      echo "launcher: switched to $v"
    fi
  fi
  started=$(date +%s)
  "$APP/current/bin/anywhere-cli" "$@"; code=$?
  [ "$code" -eq 75 ] && continue
  [ "$code" -eq 0 ] && exit 0
  if [ $(( $(date +%s) - started )) -lt 120 ]; then fails=$((fails + 1)); else fails=0; fi
  if [ "$fails" -ge 3 ] && [ -s "$APP/previous" ]; then
    prev="$(cat "$APP/previous")"; rm -f "$APP/previous"
    switch "$prev"; fails=0
    echo "launcher: the new version keeps failing (exit $code): back to $prev"
  fi
  sleep $((fails * 5 + 1))
done
