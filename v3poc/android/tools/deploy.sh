#!/bin/sh
# Build, install and launch the PoC on the running emulator/device. Extra arguments go to `am start`, e.g.
#   v3poc/android/tools/deploy.sh --ez drawer true --es session s-meshcall
set -eu
cd "$(dirname "$0")/.."
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Library/Android/sdk}
# Always name the device: ANDROID_SERIAL=emulator-5556 (the headless dev emulator). Never default to whatever is first.
: "${ANDROID_SERIAL:?set ANDROID_SERIAL, e.g. emulator-5556}"
export ANDROID_SERIAL
ADB=$ANDROID_HOME/platform-tools/adb
[ "${NO_BUILD:-0}" = 1 ] || ./gradlew -q :app:assembleDebug
$ADB install -r app/build/outputs/apk/debug/app-debug.apk >/dev/null
$ADB logcat -c
$ADB shell am start -S -W -n dev.agentsanywhere.v3poc/.MainActivity "$@" >/dev/null
