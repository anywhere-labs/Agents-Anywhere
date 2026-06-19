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
