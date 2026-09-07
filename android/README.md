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

The first pass is a Compose shell based on the current mobile design canvas:
login methods, sessions, devices/profile tabs, session detail, file push,
terminal push, and code preview surfaces.

## Local Notes

- This directory is intentionally independent from `web/`, `server/`, and
  `connector/`.
- `local.properties` is ignored because Android Studio writes the local SDK
  path there.
- The app allows cleartext traffic for local self-hosted development URLs such
  as `http://192.168.x.x:8000`. Tighten this before a production release.

## Application updates

On launch and when the selected server changes, Android reads `/api/v2/health`
and compares its `version` with `BuildConfig.VERSION_NAME` numerically. The saved
server is used when available; `AppConfig.UPDATE_SERVICE_URL` is the fallback.
`AppConfig.UPDATE_DOWNLOAD_URL` is the fixed APK address and currently contains
an explicit `.invalid` placeholder that must be replaced before distribution.

**Ignore this version** saves the target version per server in the private
`app-updates` SharedPreferences file. The same version stays quiet on later
launches; a newer version prompts again. Settings keeps a download icon with a
red dot beside **Check for updates** whenever a newer version exists. Tapping it
reopens the dialog even for an ignored version. Outside taps and Back do not
close the prompt. Downloads show progress and continue through the existing APK
installer flow.
