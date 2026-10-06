# Agents Anywhere Android

Agents Anywhere 的原生 Android 客户端。

## 技术栈

- Kotlin
- Jetpack Compose
- Material 3
- Android Gradle Plugin

## 在 Android Studio 中打开

1. 安装 Android Studio。
2. 打开本 `android/` 目录。
3. 让 Android Studio 安装所需的 Android SDK 并完成 Gradle 同步。
4. 用 USB 调试连接 Android 手机。
5. 运行 `app` 配置。

## 安装 2.0.0

从[发布下载表](../README.md#下载与入口)下载 Android APK。客户端支持 Android 8.0+
（API 26），通过 v2 API 提供会话、设备、运行时配置、审批、文件与终端功能。默认使用
云端服务，也可以在登录流程中选择自托管地址。

## 命令行构建

使用 JDK 17，以及与 `app/build.gradle.kts` 中 `compileSdk` 匹配的 Android SDK
（当前为 36）。设置 `ANDROID_HOME`，或在已被忽略的 `local.properties` 里写本地
SDK 路径，然后从本目录运行：

```bash
./gradlew testDebugUnitTest assembleDebug
./gradlew assembleRelease
```

Windows 下使用 `gradlew.bat`。输出位于 `app/build/outputs/apk/`。仓库内置的
release 构建类型没有签名配置，仅运行 `assembleRelease` 不会产出可分发的签名更新；
请用现有 keystore 执行发布签名流程，并保持签名身份一致。不要提交密码或 keystore。
更换签名后，已安装的应用将无法原地升级到新签名版本。

`local.properties` 保持机器相关且被忽略。Manifest 允许本地/自托管地址使用 HTTP；
公开服务端点请使用 HTTPS。

## 通知

登录后，应用会请求一次 Android 13+ 的 `POST_NOTIFICATIONS` 权限。授权后，
`session_activity` 渠道在应用退到后台时仍然工作：Agent 待回答的提问、待审批请求、
回合完成与回合失败各会发出一条系统通知，点击即可打开对应会话。应用在前台时不发任何
通知。拒绝权限会关闭这些提醒；可到系统设置里重新开启。

## 应用内更新

进入登录后的应用后，Android 会读取已保存服务器的 `/api/v2/health`，并将其
`version` 与 `BuildConfig.VERSION_NAME` 做数值比较。已有登录时启动、以及保存的
服务器变更时也会执行这一检查。登录页与未保存服务器的会话从不检查更新；也不会代填
默认服务器。退出登录会取消进行中的检查与下载，并清空当前可见的更新状态。
`AppConfig.UPDATE_DOWNLOAD_URL` 是固定的 APK 地址，目前是一个显式的 `.invalid`
占位符，分发前必须替换。

**忽略此版本**会把目标版本按服务器保存在私有的 `app-updates` SharedPreferences
文件中。同一版本在之后的启动里保持静默；更新的版本会再次提示。存在新版本时，
设置页的**检查更新**旁边会显示带红点的下载图标；点击它即使该版本已被忽略也会重新
弹出对话框。点击外部或返回键不会关闭提示。下载会显示进度，并沿用现有的 APK
安装流程。
