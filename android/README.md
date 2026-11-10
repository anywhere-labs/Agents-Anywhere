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

## 内置登录页视口回归

内置浏览器直接加载 `app/src/main/assets/web-login-viewport.js`，对顶层页面及跳转后的
身份提供方修正视口高度；API 请求重写仍仅注册到登录站点的 origin。
整屏登录层继续补高度，内部登录卡片仅在高度为零且有可见内容时补高度；普通容器还需确实
裁剪内容才修复，保留正常页头、页脚、卡片、悬浮层锚点和空挂载点的布局。
登录 URL 和第三方 console 不转发到应用日志。

在仓库根目录运行隔离检查：

```bash
docker build -t aa-web-login-test -f android/scripts/Dockerfile.web-login-test .
docker run --rm --network none \
  --mount type=bind,src="$PWD",dst=/workspace,readonly \
  aa-web-login-test
```

入口先检查 Chromium、脚本读取和 JavaScript 语法；工具缺失或语法错误时输出
`{"doctor":"failed",...}`，以状态码 1 退出。各用例与汇总输出 JSON，任一失败即返回 1。
可用 `CHROMIUM_PATH` 指定浏览器，用 `AA_WEBVIEW_SCRIPT` 指向待验证的脚本版本。
JVM 单测 `WebLoginModelsTest` 验证生产注册函数：视口脚本允许所有源，API 桥接仅允许
当前登录源（包括自建站点的端口），非法来源在任何脚本注册前被拒绝。

浏览器夹具覆盖正常布局、塌陷恢复、Shadow DOM、延迟布局、异步表单、iframe 和日志。
这些验证不依赖真实账号，不代表真机 WebView、OAuth 跳转、软键盘或旋转已验收。
APK 构建和 JVM 单测也必须在容器或虚机内执行。

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
倒序列表里正在生成的消息保持底边不动，新内容会把上方正在阅读的内容往上推；阅读位置在内容增长的同一帧、
绘制之前恢复（锚点被推出视口时按下方相邻条目的位移补偿），不会先跳走再弹回。
展开状态按会话和消息身份保存，单条转分组、滚出视口再返回不会自动收起；代码输出增长保留内部滚动位置。
点击回到底部、发送消息或手动滚回最新位置后恢复跟随。切换会话隔离展开和阅读状态。

相关 Compose 真机回归位于 `app/src/androidTest/.../MessageListScrollFollowTest.kt`，验证可见文字行的像素坐标、
流式增长时每一帧的阅读行位置、分组状态及代码输出滚动；构建和 JVM 单测通过仍不等同于真实
DSH/Connector/Server 的流式链路验收。

## 会话图片

会话中的 Markdown 图片（`![描述](https://example.com/image.png)`）和 HTML 图片
（`<img src="https://example.com/image.png" alt="描述">`）会直接显示，支持 HTTP、HTTPS
和内嵌的 `data:image/` 地址。点击图片可全屏查看并双指缩放，加载失败可重试。
图片地址需要手机可访问；工作设备上的本地路径不会作为手机文件读取。

## 会话文件预览与下载

会话里指向工作设备文件的链接可以直接打开预览页。识别的写法包括 Markdown 链接
（相对路径、绝对路径、`~/`、`<带空格的路径>`、`%E6%8A%A5` 这样的百分号编码和 `file://` 地址）、
行内代码里的路径，以及末尾的 `:12`、`#L12` 行号；中文文件名和带空格的路径保持原样。
Agent 回复提到的 PDF、Word、PowerPoint、Excel、CSV、HTML 等文件还会在消息下方显示为文件卡片。

| 格式 | 预览方式 |
| --- | --- |
| PDF | 系统 `PdfRenderer` 逐页渲染，点页面可放大 |
| `.docx` / `.pptx` / `.xlsx` | 转换为简化 HTML：标题、列表、表格（含合并单元格）、超链接和图片；幻灯片按页显示文字与图片 |
| `.doc` / `.ppt`（97-2003） | 从 OLE 复合文件中只提取文字，表格按行显示 |
| Markdown / HTML / SVG / CSV | 渲染后显示，可切换「源码」；Markdown 引用的工作设备图片会一并下载显示 |
| 图片、文本 | 缩放查看 / 等宽文本 |
| 其他格式 | 显示文件信息，仍可下载 |

Excel 预览保留文件中存储的数值精度。PowerPoint 最多预览前 300 页，超出时显示已预览页数和总页数，
可以下载或用其他应用查看全部内容。文档损坏、过大或受密码保护时，按当前界面语言显示提示。

预览页底部始终提供「下载」「分享」「其他应用打开」。文件经 Server 的 `fs/read` 传输下载并校验
sha256，缓存在 `cacheDir/file-previews/` 下（以原文件名保存，3 天或超出 40 个 / 768 MB 后清理），
分享和用其他应用打开通过 FileProvider 交给系统，接收方看到的仍是原文件名。「下载」保存到
`Download/Agents Anywhere/`：Android 10 及以上使用 MediaStore，Android 8–9 需要存储权限；重名时由
系统追加 ` (1)`。超过 32 MB 的文件需要点击后才下载预览，单个文件上限 512 MB。

源码和配置文件（`.kt`、`.ts`、`.py`、`.json`、`.yaml` 等）仍在会话的「文件」页用代码浏览器打开，
该页标题栏的下载按钮同样进入预览页。HTML 预览允许运行页面脚本和加载网络资源，但不能读取手机或
工作设备上的其他文件；其余预览都关闭脚本。
