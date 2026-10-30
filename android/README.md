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

QR sign-in stores a mobile refresh token valid for 30 days. Authenticated JSON
and file-upload requests that return 401 refresh the access token through
`POST /api/v2/auth/mobile-login/refresh` and retry once. Concurrent 401s share
one refresh. A missing or rejected refresh token, or a retry that still returns
401, sends the user back to sign-in; network and server errors preserve the
saved session. Refreshing does not extend the original refresh-token expiry.
Project loading tracks the saved login independently of the access token, so a
successful refresh keeps the request's results and clears its loading state.
Terminal connections and reconnects validate the session before opening their
WebSocket and use the current access token while preserving the replay cursor.

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
`AppConfig.UPDATE_DOWNLOAD_URL` is the fixed APK address,
`https://www.agents-anywhere.com/api/download/android/latest`, which the official
site redirects to the latest release APK.

**Ignore this version** saves the target version per server in the private
`app-updates` SharedPreferences file. The same version stays quiet on later
launches; a newer version prompts again. Settings keeps a download icon with a
red dot beside **Check for updates** whenever a newer version exists. Tapping it
reopens the dialog even for an ignored version. Outside taps and Back do not
close the prompt. Downloads show progress and continue through the existing APK
installer flow.

## 会话流式生成期间的阅读位置

Android 会话列表在最新位置自动跟随生成；上翻或展开思维链、工具详情后，切换为阅读状态。
新增消息、工具组追加、审批导致的重新分组和历史快照更新会按已有内容锚点保持阅读位置。
展开状态按会话和消息身份保存，单条转分组、滚出视口再返回不会自动收起；代码输出增长保留内部滚动位置。
点击回到底部、发送消息或手动滚回最新位置后恢复跟随。切换会话隔离展开和阅读状态。

相关 Compose 真机回归位于 `app/src/androidTest/.../MessageListScrollFollowTest.kt`，验证可见文字行的像素坐标、
分组状态及代码输出滚动；构建和 JVM 单测通过仍不等同于真实 DSH/Connector/Server 的流式链路验收。
