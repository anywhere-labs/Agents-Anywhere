# Agents Anywhere v3 PoC · Android

v3 架构验证的 Android 部分，行为和外观照着 iOS PoC（[`../ios/`](../ios/README.md)）做：对话线程画在**一个常驻的 Android System WebView** 里（渲染包和 iOS、Web 是同一份 `renderer.html`），线程周围的控件是原生 Jetpack Compose：侧栏抽屉、顶栏、输入框、审批区、「到底部」按钮、Sheet、菜单。数据契约见 [`../protocol/`](../protocol/README.md)，设计数值和两端的组件对照见 [`../design/`](../design/README.md)。

这个 PoC 不联网，用 `MockSessionsClient` 回放 [`../fixtures/`](../fixtures/)，代替电脑上的 Connector。

会话页右上角的文件夹按钮沿用 iOS 正式端的位置和图标，与「…」会话菜单共用一个玻璃胶囊，两个图标独立点击、按压时整组等比放大；文件夹打开「文件与终端」统一面板；两项在面板内切换。目前仅展示当前会话目录及演示提示，未接入文件读取或终端服务。

## 目录

| 路径 | 内容 |
| --- | --- |
| `app/src/main/java/dev/agentsanywhere/v3poc/App.kt`、`MainActivity.kt` | 入口：创建客户端、控制器和唯一的 WebView；`onTrimMemory` → `memoryPressure` |
| `DebugLaunch.kt` | 调试启动参数（intent extras）和启动计时 `LaunchClock`（logcat 标签 `AAv3PoC`） |
| `model/` | `SessionsClient` 接口与 `SessionCache`、`MockSessionsClient`（回放器）、`SessionState`（按 id 整条替换，分配 `seq`）、`SessionController`（选中会话、转发事件、处理渲染包消息、内存压力）、`Workspace`、`StressContent`（压测内容，与 iOS 同一个算法和种子） |
| `bridge/` | `RendererBridge`（唯一的 WebView 和 `aa.render/1` 管道）、`RendererAssets`（`WebViewAssetLoader` 和附件占位图）、`StressMetrics`（压测测量） |
| `design/` | AA 设计系统：`AATokens.kt`（由 `tokens.json` 生成）、`AAIcons.kt`（由 iOS 的 SVG 生成）、`AATheme`（文字、图标、按下效果）、`Glass`（毛玻璃）、`GlassSettings`（开关）、`Sheet`、`Menu` |
| `ui/` | `Root`、`SidebarDrawer`、`Sidebar`、`ConversationPage`（WebView + 顶栏 + 底部控件）、`Composer`、`ApprovalDock`、`Sheets`、`WindowGlassSpike`（窗口级模糊的评估代码，只在 `--es web_glass window` 时出现） |
| `tools/` | `deploy.sh`（构建、安装、启动）、`shot.sh`（截图）、`compare.sh` / `compare.py`（和 iOS 截图并排对照）、`ab-glass.sh`（玻璃方案 A/B）、`tokens2kotlin.py`、`svg2compose.py` |
| `stress/` | 压测：`run.sh`、`summarize.py`、`compare.py`（输出格式和 `v3poc/ios/stress` 相同，可以混在一张表里比较） |

`renderer.html` 不在这个目录里：构建时 Gradle 任务 `copyPocAssets` 把 `../ios/AAv3PoC/Renderer/renderer.html` 和 `../fixtures/*.json` 复制到 `app/build/generated/pocAssets/`，作为 assets 打进 APK（不压缩）。渲染包更新后重新构建即可，**不要手改**。

## 工具链

- JDK 17：`export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`
- Android SDK：`platforms;android-37.0`（Compose 1.12 要求 compileSdk 37）、`build-tools`、`platform-tools`、`emulator`；模拟器镜像 `system-images;android-36;google_apis;arm64-v8a`
- Gradle 9.9.1（wrapper）、AGP 9.5.1（内置 Kotlin）、Kotlin 2.4.21、Compose BOM 2026.09.00、`androidx.webkit` 1.18.0、`androidx.metrics:metrics-performance`（JankStats）
- minSdk 26，targetSdk 36
- 本机连 Maven Central 时 TLS 握手会失败，所以 `settings.gradle.kts` 加了 Google 的 Maven Central 镜像，`gradle.properties` 固定 TLS 1.2
- lockfile 不提交；`local.properties` 写 `sdk.dir`（已忽略）

## 构建与运行

```sh
cd v3poc/android
./gradlew assembleDebug                      # 调试包
./gradlew assembleRelease                    # 压测用（不可调试，用 debug 签名）

# 构建、安装、清空 logcat、带参数冷启动；必须指定设备，脚本不会碰别的模拟器
ANDROID_SERIAL=emulator-5556 tools/deploy.sh --ei auto_approve_seconds 8
NO_BUILD=1 ANDROID_SERIAL=emulator-5556 tools/deploy.sh --ez drawer true

adb -s emulator-5556 logcat -s AAv3PoC:I     # 启动计时、渲染包 console.error/warn、[stress] 测量
ANDROID_SERIAL=emulator-5556 tools/shot.sh /tmp/shot.png
ANDROID_SERIAL=emulator-5556 PYTHON=/path/to/python-with-pillow tools/compare.sh   # 7 张和 iOS 的并排对照
```

检查玻璃效果时使用可见模拟器：`emulator -avd <名字> -gpu host -no-audio -no-snapshot-save`，不要使用 `-no-window` 或 CPU 软件渲染来判断外观。脚本里用 `am start -S`，会先杀掉进程，**不要对别人正在用的设备运行**。

## 调试启动参数

用 `adb shell am start -S -n dev.agentsanywhere.v3poc/.MainActivity <参数>`（`-S` 让参数在冷启动时生效）。

| 参数 | 作用 |
| --- | --- |
| `--ez drawer true` | 启动时打开侧栏抽屉 |
| `--es sheet options\|account` | 渲染包就绪后打开「对话选项」或「账号」Sheet |
| `--ez focus true` | 聚焦输入框，弹出键盘 |
| `--es session s-unread` | 先打开哪个会话（默认是第一个运行中的会话） |
| `--ei auto_approve_seconds 8` | 出现审批 n 秒后自动选第一个允许选项 |
| `--es switch s-meshcall@5,s-unread@8` | 在第 n 秒切换到这些会话 |
| `--ei scroll_up 600` | 就绪约 3 秒后把线程往上滚 n dp（看「到底部」按钮） |
| `--es stress items:3000,chars:3000,hz:30,parallel:3` | 压力模式（规格和 iOS 的 `AA_POC_STRESS` 相同），侧栏多一个置顶的 `s-stress` 会话并默认打开 |
| `--ez metrics true` | 不开压力模式也输出 `[stress]` 测量 |
| `--ei cache_items 3000` | 会话缓存每个会话保留的条数（默认 300），同 iOS 的 `AA_POC_CACHE_ITEMS` |
| `--ei crash_renderer_at 20` | 就绪 n 秒后让渲染进程崩溃（`chrome://crash`），检查恢复 |
| `--es glass blur\|tint` | 临时覆盖毛玻璃开关 |
| `--es sheet_glass on\|off` | 仅本次启动覆盖「面板和菜单的玻璃」 |
| `--ef frost 0.5` | 仅本次启动覆盖「模糊程度」（0…1）；手动拖动滑块后保存实际值并清除覆盖 |
| `--ez open_sheet true` | 打开「打开文件」Sheet |
| `--es web_glass window\|behind\|bgafter\|bgaftert` | 窗口级模糊的评估代码（只用于评估，方向已停止） |
| `--es web_layer both\|hw\|preraster\|none` | WebView 的绘制方式（默认 both），用于玻璃录制的对比 |

内存压力可以用 `adb shell am send-trim-memory dev.agentsanywhere.v3poc RUNNING_LOW`（之后只能发更高的级别，如 `RUNNING_CRITICAL`）模拟。

## 原生与 WebView 的分工

和 iOS 相同（见 [iOS README](../ios/README.md#原生与-webview-的分工)）。Android 上桥的实现：

- 只有一个 WebView，`Application` 启动时创建并开始加载（用 `MutableContextWrapper`，Activity 重建时换 context，不重建 WebView）。页面地址 `https://appassets.androidplatform.net/renderer/renderer.html`，由 `WebViewAssetLoader` 从 assets 读。渲染包里的附件地址 `aa-app://file?path=…` 在 `shouldInterceptRequest` 里返回生成的占位图（文件名完整画在图里）。页面内导航一律拦下，改成发 `open` 给原生处理。
- 原生 → 渲染包：`evaluateJavascript("(function(r){r.receive(…);…})(window.aaRenderer)")`。`Choreographer` 每帧最多发一次；同一时间只有一次在途，等待期间事件按 key 合并（每个 item id 一个位置，`control`、`session` 各一个，后到的覆盖先到的）；JSON 编码在后台线程。和上一次一模一样的快照不再发。`ready` 之前的消息不发，`ready` 后补发 `chrome {approvals: 'host'}`、`appearance`、`viewport`、`memoryPressure`（如果发过）和当前会话快照。
- 渲染包 → 原生：`WebViewCompat.addWebMessageListener`，对象名 `aaHost`，只允许 `https://appassets.androidplatform.net` 这个 origin，只收主 frame 的消息。渲染包检测到 `window.aaHost` 就走 Android 通道，渲染包本身不用改。
- `viewport` 用 CSS px（= dp）：顶部是状态栏 + 44 dp 顶栏，底部是屏幕底到输入框（或审批区）上沿的距离，随键盘变化。
- `appearance`：深浅色、`textScale`（系统字体缩放）、`reduceMotion`（动画缩放为 0）、`locale`、账号名。WebView 自己的 `textZoom` 固定 100，避免重复放大。
- `memoryPressure`：`onTrimMemory` 收到 `TRIM_MEMORY_RUNNING_LOW` 发 `warning`，`RUNNING_CRITICAL` 及以上发 `critical`；30 秒内第二次也升为 `critical`。同时 `SessionCache` 只保留当前会话（`warning` 120 条 / 之后最多 4 个会话，`critical` 60 条 / 最多 2 个）。渲染进程被系统回收（不是崩溃）后，重新加载的页面一开始就收到 `warning`。注意 Android 14 起系统不再向前台 App 发送 `RUNNING_*` 级别，实际只会在退到后台时收到 `BACKGROUND` 以上的级别；前台的内存信号主要靠渲染进程被回收这一条。
- WebView 用硬件层（`LAYER_TYPE_HARDWARE`）加 `offscreenPreRaster` 绘制，供玻璃录制；`--es web_layer none|hw|preraster|both` 可以切换做对比（`tools/ab-weblayer.sh`）。
- 渲染进程死掉：`onRenderProcessGone` 返回 `true`（否则整个 App 被杀），销毁旧 WebView，新建一个重新加载，`ready` 后补发快照。
- WebView 设置：透明，不能缩放，不访问文件和 content，链接长按不弹预览；横向滚动的表格、代码块在 WebView 内部滚，抽屉手势只从左边缘 44 dp 内开始。
- 冷启动和热启动的耗时、各阶段（WebView 初始化、读 16 MB 的 HTML、JS 解析执行）在 logcat 里分段打印，见下文「启动时间」。

## 触摸归属

和 iOS 同一条规则：**WebView 区域里的触摸只归 WebView**；原生只处理自己控件范围内的触摸，以及屏幕边缘的系统级手势。

- WebView 的祖先（`AndroidView` 往上到 Activity 的 content）上没有任何指针修饰符：没有 `pointerInput`、`draggable`、`nestedScroll`、`clickable`，也没有 `onInterceptTouchEvent` 和 `requestDisallowInterceptTouchEvent`。`layerBackdrop` 只是绘制修饰符。
- 抽屉：关闭时只能从左边缘 44 × 200 dp 的排除带（兄弟视图）拉开；打开时左拉关闭和点按关闭只在侧栏和露出的那条卡片上（兄弟视图，盖住卡片）。
- 原生控件叠在 WebView 上方作为兄弟视图，靠命中测试分配：输入框卡片、审批区卡片、顶栏标题区用 `claimTouches` 接住落在自己背景上的触摸；其余位置（包括控件的外边距和阴影）都给 WebView。
- 拖动线程时收起键盘：在 WebView 自己身上挂一个只观察、返回 `false` 的 `OnTouchListener`，不在祖先上。
- 2026-11-18 之前违反过两处：抽屉的拖动手势挂在包含 WebView 的整页容器上（Initial pass），以及 WebView 外面一层观察拖动的 `pointerInput`；都已移除。

## 将来换成 MeshCall 客户端

`SessionController` 只依赖 `model/SessionsClient.kt` 里的接口：

```kotlin
interface SessionsClient {
    fun watch(id: String): Flow<JsonObject>
    suspend fun listMessages(id: String, beforeSeq: Int?, limit: Int): Pair<List<JsonElement>, Boolean>
    suspend fun send(id: String, clientMsgId: String, content: String): String
    suspend fun answer(id: String, requestId: String, optionId: String)
    suspend fun stop(id: String)
    suspend fun setConfig(id: String, configId: String, value: String): JsonObject
}
```

它和 `protocol/services.ts` 的 `aa.v3.Sessions` 一一对应。MeshCall 有 JVM / Kotlin 客户端后，写一个适配器实现这个接口（`watch` 流断开时结束 Flow，控制器会重新 `watch`），在 `App.start()` 里替换 `MockSessionsClient` 即可。事件保持 JSON，原样转给渲染包。`MockSessionsClient` 的回放语义和 iOS 相同，答复审批时 `device` 写 `Android`。

## 与 iOS 保持一致

外观和交互以 iOS PoC 为准，数值在 [`../design/tokens.json`](../design/tokens.json)，组件对照和做不到的地方在 [`../design/README.md`](../design/README.md)。要点：

- 主体控件使用自己的设计系统、没有水波纹；普通项按下变暗，玻璃控件等比放大并阻尼回弹。当前「模糊程度」仍使用 Material 3 Slider。
- 图标是 iOS 资源里的同一份 Lucide SVG（`tools/svg2compose.py` 转换）；字体用系统字体和 iOS 的字号，Agents Anywhere 字标用同一个 Caveat 字体文件。
- 抽屉、Sheet、菜单、输入框、审批区、「到底部」、Toast 都是照着 iOS 手写的，弹簧参数从 SwiftUI 的 `response` / `dampingFraction` 换算。
- 唯一保留的 Android 习惯：返回手势（预测性返回）依次关闭 Sheet、抽屉、键盘。
- 毛玻璃：WebView 先画进自己的硬件层（并开 `offscreenPreRaster`），Kyant backdrop 录制它，顶栏、输入框、审批区、「到底部」在上面模糊 + 折射（Android 13+）；顶部还有和 iOS 一样的模糊渐变带，底部不模糊。原生内容上方（侧栏底部栏）用 RenderEffect 模糊。只有真正模糊的地方才半透明，其余情况（开关关、省电、Android 12 以下、系统提高对比度或关闭动画）一律不透明实色。试过的方案和取舍见 design README。
- 圆角：非胶囊的圆角矩形都是连续曲率（Kyant shapes，等同 SwiftUI `.continuous`）；抽屉卡片的圆角取屏幕自己的圆角。
- 对比度：玻璃上的文字按最坏下层算（`tools/contrast.py`），只调颜色。
- 截图对照：`tools/compare.sh` 生成 `.local-dev/v3poc/android/compare/NN-*.png`（左 iOS、右 Android，同一逻辑宽度）。剩下的差异：字体（Roboto / Noto CJK 与 SF / 苹方的字宽）、Android 12 没有透镜折射、系统状态栏和导航条高度不同、Pixel 9 比 iPhone 高 49 dp（Sheet 中档按比例所以位置略低）、iOS 截图用的是旧渲染包（线程内容的折叠方式不同）。

## 压力测试

```sh
ANDROID_SERIAL=emulator-5556 v3poc/android/stress/run.sh <名字> <秒数> <规格> [--interact] [--kill-web 90] \
  [--switch s-release@60,s-stress@75] [--cache-items 3000] [--trim-memory 60,65] [--no-build]
python3 -I v3poc/android/stress/compare.py .local-dev/v3poc/android/stress/a1-protocol .local-dev/v3poc/ios/stress/r3-protocol
```

用 release 包（debug 包在 ART 里跑得慢，会让编码和帧时间失真）。输出在 `.local-dev/v3poc/android/stress/<名字>/`：`app.log`（logcat）、`mem.csv`（每 ~3 秒 `top`：App 和渲染进程 RSS / CPU）、`pss.csv`（每 30 秒 `dumpsys meminfo`）、`shots/`、`crashes.txt`（FATAL / ANR / tile memory 报错）、`summary.md`。`--interact` 每分钟做一轮：往上滚、停 10 秒、点「到底部」、快速上下滑、开关抽屉。`--kill-web` 需要 `adb root`（模拟器 google_apis 镜像可以）。

结果和 iOS 的对比见 [`stress/RESULTS.md`](stress/RESULTS.md)。

## Android 特有的风险

- **WebView 版本不受我们控制**。Android System WebView 跟着 Play 商店更新，但没有 Google Play 的设备（国内大部分手机）由厂商自己更新，版本可能落后很多；`WebMessageListener` 需要较新的 WebView（不支持时 App 显示提示），渲染包的 JS / CSS 也要按最低的 WebView 版本测。
- **鸿蒙 NEXT 不是 Android**，这份代码不能在上面运行，需要另做。
- **渲染进程会被系统回收**，尤其是后台和低内存设备上。PoC 会重建 WebView 并重新加载（16 MB 的渲染包，冷加载约 1 秒以上），用户会看到短暂的加载。
- **左边缘是系统返回手势**。抽屉只能在屏幕中段 200 dp 的排除区里从边缘拖出，其他位置从左边缘拖是系统返回；顶栏的菜单按钮始终可用。
- **`onTrimMemory` 在 Android 14 起不再给前台 App 发 `RUNNING_*` 级别**，前台内存紧张时 App 可能来不及收到信号；渲染进程被回收后的 `warning` 是兜底。
- **启动时间受 16 MB HTML 影响**：第一次启动（没有 V8 代码缓存）JS 解析执行约 1.1 秒，之后约 0.25 秒；低端机会更慢。
- 模拟器须使用 host GPU 验证玻璃；模拟器帧时间不能代替真机数据，更不能用来推算耗电。

## 已验证

在模拟器（Pixel 9 配置，Android 16 / API 36，WebView 133，arm64；前期 CPU 软件渲染，后期 host GPU）上：

- 渲染包加载、`ready`、快照、流式输出、审批（自动批准）、切换会话后从缓存立即显示。
- 截图：流式输出、等待审批、自动批准后的最终回答、抽屉、对话选项 Sheet、深色、键盘，与 iOS 的 7 张并排对照（`tools/compare.sh`）；玻璃开 / 关、深浅色；顶部模糊渐变和 iOS 的对照。
- 触摸：冷启动后马上「快速滑动 + 立即点击 + 再滑」30 轮；代码块横向拖动（页面纵向位置不变）；长按选中文字出现 Chromium 的选择菜单；从左边缘拉开抽屉、点卡片关闭。没有 FATAL / ANR。
- Kyant 录制 WebView：none / hw / preraster / both 四种绘制方式的录屏、tile 报错、帧时间（见 design README）。
- `am send-trim-memory` 触发 `memoryPressure` 和缓存裁剪；渲染进程被杀后重建（压测 kill 档还没跑）。
- 启动时间（见下）。

## 启动时间

时间从进程启动算起（`Process.getStartUptimeMillis()`），在 Pixel 9 模拟器上：

| 场景 | WebView 创建 | 读完 renderer.html | JS 解析到 domInteractive（页面内） | ready（距开始加载） | 首帧 |
| --- | --- | --- | --- | --- | --- |
| 安装后第一次 | +631 ms | +1316 ms | 1102 ms | +1504 ms（873 ms） | 1300 ms |
| `pm clear` 后 | +725 ms | +1478 ms | 1125 ms | +1678 ms（953 ms） | 1385 ms |
| 杀进程后再开（有 V8 代码缓存） | +732 ms | +870 ms | 244 ms | +1498 ms（766 ms） | 1492 ms |
| 模拟器重启后第一次 | +1643 ms | +2278 ms | 1074 ms | +3021 ms（1378 ms） | 2715 ms |

主线程画完首帧之前不会处理渲染包发来的消息，所以 `ready` 的时间基本等于首帧时间。宿主机满载时（多台模拟器、Gradle 和压测同时运行，load average 20–60）同一个包测到过 +17 s，主要是整个模拟器变慢，不是 App 本身。

## 没有验证

- 真机：帧时间、耗电、Kyant 录制 WebView 在不同 GPU / WebView 版本上是否同样不闪烁，低端机和国产 ROM 上的 WebView 版本。模拟器的帧时间受宿主负载影响很大（同一个包在宿主空闲时 p50 24 ms，满载时 150–950 ms）。
- TalkBack、外接键盘、平板 / 折叠屏布局（只按手机做）。
- 照片 / 文件选择器只调起了系统选择器，附件不会上传（演示提示）。
- 回退、分叉仍只弹演示提示；打开文件只展示路径并提供复制，不是完整文件浏览。
- 1.3 倍系统字体下的截图、TalkBack 朗读顺序。
- 压测只跑完 protocol 档，burst 中途停止，open3000 / kill / memwarn 没跑（见 `stress/RESULTS.md`）。

## 交接收尾

见 [`../HANDOFF.md`](../HANDOFF.md) 的完成状态和 [`validation/HANDOFF-2026-11-19.md`](validation/HANDOFF-2026-11-19.md) 的本轮验证记录。检查设计源文件与生成文件是否一致：`python3 -I v3poc/android/tools/tokens2kotlin.py --check`。UI 验证不运行 `stress/` 的 WebView 压测脚本。
