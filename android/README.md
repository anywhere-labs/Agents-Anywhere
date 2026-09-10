# Agents Anywhere Android

Native Android client for Agents Anywhere.

## Stack

- Kotlin
- Jetpack Compose
- Material 3
- Android Gradle Plugin

## Open In Android Studio

1. Install Android Studio.
2. Open this `android/` directory.
3. Let Android Studio install the requested Android SDK and sync Gradle.
4. Connect an Android phone with USB debugging enabled.
5. Run the `app` configuration.

## Install 2.0.0

Download the Android APK from the [release download table](../README.md#下载与入口).
The client supports Android 8.0+ (API 26), sessions, devices, runtime configuration,
approvals, files and terminals through the v2 API. Cloud is the default service;
a self-hosted address can be selected in the login flow.

## Build from the command line

Use JDK 17 and the Android SDK matching `compileSdk` in `app/build.gradle.kts`
(currently 36). Set `ANDROID_HOME` or the local SDK path in ignored
`local.properties`, then run from this directory:

```bash
./gradlew testDebugUnitTest assembleDebug
./gradlew assembleRelease
```

On Windows use `gradlew.bat`. Outputs are under `app/build/outputs/apk/`.
The checked-in release build type does not define a signing configuration;
`assembleRelease` alone does not produce a distributable signed update. Apply the
release signing process with the existing keystore and keep that identity for
future updates. Do not commit passwords or keystores. Changing the signature
prevents an in-place update of an installed app signed with another key.

`local.properties` remains machine-specific and ignored. The manifest allows
HTTP for local/self-hosted addresses; use HTTPS for public service endpoints.

## Application updates

After entering the signed-in app, Android reads the saved server's
`/api/v2/health` and compares its `version` with `BuildConfig.VERSION_NAME`
numerically. This also runs on launch with an existing login and when the saved
server changes. Login screens and sessions without a saved server never check
for updates; no default server is substituted. Signing out cancels pending
checks and downloads and clears the visible update state.
`AppConfig.UPDATE_DOWNLOAD_URL` is the fixed APK address and currently contains
an explicit `.invalid` placeholder that must be replaced before distribution.

**Ignore this version** saves the target version per server in the private
`app-updates` SharedPreferences file. The same version stays quiet on later
launches; a newer version prompts again. Settings keeps a download icon with a
red dot beside **Check for updates** whenever a newer version exists. Tapping it
reopens the dialog even for an ignored version. Outside taps and Back do not
close the prompt. Downloads show progress and continue through the existing APK
installer flow.
