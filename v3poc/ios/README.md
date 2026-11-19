# Agents Anywhere v3 PoC · iOS

v3 架构验证的 iOS 部分：对话线程画在**一个常驻的 WKWebView** 里（渲染包和 Web 是同一份代码），线程周围的控件仍然是**原生液态玻璃**：侧栏、顶栏、输入框、审批区、「到底部」按钮、Sheet。数据契约见 [`../protocol/`](../protocol/README.md)。

启动时可登录 Server、选择设备并配对。Debug 版可通过 `AA_POC_DEMO=1` 启动内置演示。构建、加密连接与调试入口见 [MeshCall 联调](../meshcall.md)。

## 目录

| 路径 | 内容 |
| --- | --- |
| `AAv3PoC/App/` | 入口（UIKit 生命周期：`AppDelegate` + `SceneDelegate`）、字体注册、调试启动变量（`DebugLaunch`）、启动计时（`LaunchClock`） |
| `AAv3PoC/Model/` | `SessionsClient` 协议与 `SessionCache`、`MockSessionsClient`（回放器）、`SessionState`（按 id 整条替换，分配 `seq`）、`SessionController`（选中会话、转发事件、处理渲染包消息）、`Workspace`（侧栏数据）、`JSON` |
| `AAv3PoC/Bridge/` | `RendererBridge`（唯一的 WKWebView 和 `aa.render/1` 消息管道）、`RendererSchemeHandler`（`aa-app://` scheme） |
| `AAv3PoC/Conversation/` | `ConversationViewController`（UIKit：WebView 铺满，SwiftUI 控件层和导航栏作为它的兄弟视图叠在上面）、`ConversationPage.swift`（SwiftUI 控件层 `ConversationChrome`）、`ChatPageToolbar`（标题）、`ApprovalDock`、`Composer/` |
| `AAv3PoC/Shell/` | `ShellViewController`（UIKit 根：手机抽屉 / iPad 分栏）、`SidebarView` |
| `AAv3PoC/Components/` | 从正式 App（`ios/Agents Anywhere`）复制的组件：玻璃按钮、主题、图标等 |
| `AAv3PoC/Renderer/renderer.html` | 渲染包，由 `v3poc/web` 构建（`npm run build:renderer`）生成，**不要手改**；不提交到 git，克隆后先构建一次（Android 也从这里取） |
| `AAv3PoC/Fixtures/` | `sync-fixtures.sh` 从 `v3poc/fixtures` 复制过来的数据 |
| `AAv3PoC/Model/StressContent.swift`、`AAv3PoC/Bridge/StressMetrics.swift` | 压测用的内容生成器和测量（只在设置了 `AA_POC_STRESS` 或 `AA_POC_METRICS=1` 时开启） |
| `AAv3PoCUITests/` | 惯性滚动中触摸（用户的崩溃复现方法）`MomentumTouchTests`、「到底部」按钮位置 `PillLayoutTests`、手势压力测试 `GestureStressTests`、在表格和代码块里滑动的 `ScrollerGestureTests`、压测时模拟阅读的 `StressInteractionTests`、鼠标滚轮 / 触控板滚动的 `WheelScrollTests`（只能在 iPad 模拟器上跑，见「滚轮与触控板」） |
| `stress/` | 压测脚本：`run.sh`（单独的模拟器、内存采样、截图）、`summarize.py`（汇总成表） |

工程使用文件夹同步（`PBXFileSystemSynchronizedRootGroup`），新加的文件不用改 `project.pbxproj`。

## 构建与运行

先在仓库根目录执行 `sh vendor/meshcall/prepare-mobile-sdk.sh`，获取锁定版本的 Swift 和 JVM SDK。

```sh
# 修改 fixtures 后
python3 -I v3poc/fixtures/build.py && sh v3poc/ios/sync-fixtures.sh
# 渲染包（在 v3poc/web 里），会把 renderer.html 复制到 AAv3PoC/Renderer/
npm run build:renderer

export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodebuild -project v3poc/ios/AAv3PoC.xcodeproj -scheme AAv3PoC \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  -derivedDataPath /tmp/aav3poc-dd CODE_SIGNING_ALLOWED=NO build

xcrun simctl boot 'iPhone 18 Pro'
xcrun simctl install booted /tmp/aav3poc-dd/Build/Products/Debug-iphonesimulator/AAv3PoC.app
SIMCTL_CHILD_AA_POC_DEMO=1 SIMCTL_CHILD_AA_POC_SCHEME=dark xcrun simctl launch --stderr=/tmp/aav3poc.log booted dev.agentsanywhere.v3poc
xcrun simctl io booted screenshot shot.png
```

如果报「CoreSimulator out of date」，先运行一次 `xcrun simctl list devices`。启动日志（stderr，前缀 `[AAv3PoC]`）包含从进程启动到渲染包 `ready` 的时间、渲染包里的 `console.error/warn`，以及键盘弹出时 WebView 的 inset。

手势压力测试（会操作模拟器几分钟，请用一台没人在用的模拟器）：

```sh
xcodebuild -project v3poc/ios/AAv3PoC.xcodeproj -scheme AAv3PoC \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro Max' \
  -derivedDataPath /tmp/aav3poc-dd-test CODE_SIGNING_ALLOWED=NO test \
  -only-testing:AAv3PoCUITests/GestureStressTests \
  -only-testing:AAv3PoCUITests/ScrollerGestureTests
```

`ScrollerGestureTests` 打开压测会话，一边推送新的表格和代码块，一边在不同高度横向拖动、长按后拖动、轻点，中途切到别的会话再切回来（约 2 分钟）。

`TEST_RUNNER_AA_POC_ONLY=<序号>` 只反复跑某一种操作，`TEST_RUNNER_AA_POC_STRESS_ROUNDS=n` 改轮数。

## 调试启动变量

`simctl launch` 时加 `SIMCTL_CHILD_` 前缀，XCUITest 里写在 `launchEnvironment`。

| 变量 | 作用 |
| --- | --- |
| `AA_POC_SCHEME=dark\|light` | 强制深色 / 浅色 |
| `AA_POC_DRAWER=1` | 启动时打开侧栏抽屉 |
| `AA_POC_DRAWER_HOLD=0.5` | 启动时把抽屉停在半开的位置（和拖到一半时一样），用来截拖动中的卡片圆角 |
| `AA_POC_CARD_CLIP=layer\|config\|mask` | 抽屉卡片的圆角裁剪方式，只用于对比（默认 `layer`，见「抽屉卡片的圆角裁剪」） |
| `AA_POC_SHEET=options` | 渲染包就绪后打开输入框的「对话选项」Sheet |
| `AA_POC_FOCUS=1` | 聚焦输入框（模拟器要关掉硬件键盘才会弹出软键盘） |
| `AA_POC_SESSION=<id>` | 先打开哪个会话（默认是正在运行的演示会话 `s-unread`） |
| `AA_POC_AUTO_APPROVE_SECONDS=n` | 出现审批 n 秒后，自动选第一个允许选项 |
| `AA_POC_LAYOUT_CHECK=1` | 控件层每次布局时记录「到底部」按钮和底栏的位置（`[layout]` 行，写进 `AA_POC_LOG_PATH`）；同时记录线程的滚动位置（`[scroll] y=`）、「到底部」按钮的出现和消失（`[pill]`）、`loadOlder`（`[older]`），并在页面里注入探针，记录 `wheel` 事件（`[wheel]`）和代码块、表格的横向滚动（`[hscroll]`） |
| `AA_POC_SWITCH=s-meshcall@5,s-unread@8` | 在第 n 秒切换到这些会话（不用点击就能检查切换和缓存） |
| `AA_POC_SCROLL_UP=n` | 渲染包就绪约 3 秒后，把线程往上滚 n 点（用来看「到底部」按钮） |
| `AA_POC_RENDERER_PATH=/abs/file.html` | 从本机文件加载渲染包，不用 App 包里的那份（调试用） |
| `AA_POC_STRESS=items:3000,chars:3000,hz:30,parallel:3` | 压力模式：侧栏多一个置顶的 `s-stress` 会话并默认打开它，见下文「压力测试」 |
| `AA_POC_METRICS=1` | 不开压力模式也输出 `[stress]` 测量日志 |
| `AA_POC_LOG_PATH=/abs/app.log` | 日志另外写一份到这个文件（UI 测试启动的 App 没有 stderr）。以追加方式写入，UI 测试可以往同一个文件里写 `[test]` 标记 |
| `AA_POC_REWATCH=8,14` | 第 n 秒重新 `watch` 当前会话，相当于连接断开后重连（检查快照只发差量、没变化就不发） |
| `AA_POC_BACKDROP=white\|black\|image\|stripes` | 用一层纯白、纯黑或图片背景盖住整个页面（在线程之上、原生控件之下），检查控件在最坏背景上是否看得清。只用于调试 |
| `AA_POC_MEMORY_WARNING=60,65` | 启动后第 n 秒触发一次系统内存警告（和模拟器菜单 Debug → Simulate Memory Warning 走同一个 UIKit 私有入口；`simctl` 没有对应命令） |

## 压力测试

用来找 WebView 方案在长会话、高频推送下的瓶颈。只做测量：不改渲染包，也不改协议。

**数据**：`AA_POC_STRESS` 打开后，`MockSessionsClient` 生成一个 `s-stress` 会话，一轮接一轮地推送，直到完成 `items` 条 item。每一轮依次是：用户消息（每三轮带一张图片和一个文件）、思考、计划（同一个 item 反复整条更新）、execute（几千行终端输出）、read（长文件）、长 Markdown（标题、列表、多种语言的长代码块、宽表格、行内代码、引用，少量公式和 mermaid）、search、edit（`diffs` 的旧文本和新文本各几百行）、失败的 execute、subagent（带四个子步骤）。每隔几步插入一个审批，由 `AA_POC_AUTO_APPROVE_SECONDS` 自动批准。正在增长的 item 每次都整条推送，和协议一致。

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `items` | 3000 | 推送多少条 item 后停止 |
| `chars` | 3000 | 每段 Markdown 的长度（字符） |
| `hz` | 30 | 每秒推送几次；`3` 约等于协议规定的 333 ms |
| `parallel` | 3 | 同时有几个 item 在增长 |
| `snapshot` | 0 | 打开会话时快照里已经有多少条 item（测打开长会话的速度） |
| `lines` / `difflines` | 2000 / 300 | 终端输出的行数 / diff 的行数 |
| `approve` | 40 | 每隔多少步出现一次审批（0 表示不出现） |
| `cps` / `lps` | 1500 / 150 | 每个 item 每秒增长的字符数（文字）/ 行数（终端和文件） |

**测量**（每 5 秒写一行 `[stress] {json}`）：

- 原生 `native`：桥每次 `evaluateJavaScript` 的事件数和字节数、JSON 编码耗时、往返耗时（从调用到回调）、还没返回的调用数（积压）、主线程掉帧（`CADisplayLink`），以及 App 的 `phys_footprint`。
- 页面 `web`：原生注入一段 `WKUserScript` 做测量，渲染包本身不改。内容包括：`requestAnimationFrame` 间隔（掉帧、最长卡顿、超过 50 / 100 ms 的次数）、`aaRenderer.receive` 的同步耗时、从 receive 到之后第二帧的时间（约等于画出来的时间）、DOM 节点数、页面高度。
- 快照：打开会话时依次记录 `snapshotSent`（字节数）、`snapshotEval`（往返耗时）、`snapshotRendered`（从 receive 到画出来的时间和 DOM 节点数）。
- 事件：`ready`、WebContent 进程的 PID（`wcp`）、`webContentTerminated`、`scroll`（`atEnd` 的变化），以及 UI 测试的每一步操作。
- 主机端：`run.sh` 每 2 秒用 `ps` 采样 App 和 WebContent 进程（在模拟器上，WebContent 是 macOS 上的普通进程）的 RSS 和 CPU，每 30 秒截一张图，结束后检查 `~/Library/Logs/DiagnosticReports` 有没有新的 `AAv3PoC-*.ips`。

**运行**（在仓库根目录；会自动创建并使用一台单独的「AAv3PoC Stress」iPhone 18 Pro 模拟器，不会碰别的模拟器）：

```sh
# 协议档：333 ms 整条推送，同时 1 个 item 在增长；--interact 让 UI 测试模拟阅读
v3poc/ios/stress/run.sh protocol 360 "hz:3,parallel:1" --interact
# 激进档：30 Hz，同时 3 个 item 在增长
v3poc/ios/stress/run.sh burst 360 "hz:30,parallel:3" --interact --no-build
# 打开长会话：快照里已经有 3000 条 item，不再推送；60 秒时切到别的会话，70 秒时切回来（走缓存）
v3poc/ios/stress/run.sh open3000 120 "snapshot:3000,items:0" --switch s-release@60,s-stress@70 --no-build
# WebContent 进程被杀后能不能恢复：第 90 秒 kill -9
v3poc/ios/stress/run.sh kill 180 "hz:30,parallel:3" --kill-web 90 --no-build
# 用完删掉这台模拟器
v3poc/ios/stress/run.sh --delete-device
```

结果在 `.local-dev/v3poc/ios/stress/<名字>/`：`summary.md`（每 30 秒一行的表、快照耗时、事件时间线、崩溃报告）、`app.log`、`mem.csv`、`shots/`。`--interact` 的 UI 测试每分钟做一轮：往上滑三次读内容，停 10 秒（看会不会被拉回底部），点「到底部」，快速上下滑，从左边缘拉开侧栏再关上。

### 第三轮结果（2026-11-18，新渲染包 + 桥合并发送）

在 UIKit 重构和「到底部」按钮修复**之前**跑的；之后用户暂停了压测，重构后的版本还没有重跑。和第二轮（同样的档位，桥不合并、可以有多次 `evaluateJavaScript` 在途）的对比，用 `stress/compare.py r2-<档> r3-<档>` 生成：

| 指标 | 协议档 r2 | 协议档 r3 | 激进档 r2 | 激进档 r3 |
| --- | --- | --- | --- | --- |
| 掉帧 全程 / 末分钟 | 7% / 6% | 3% / 4% | 52% / 80% | 6% / 6% |
| 超过 100 ms 的卡顿 | 78 | 11 | 298 | 17 |
| 最长卡顿 | 161 ms | 367 ms | 754 ms | 1914 ms |
| 到绘制 首分钟 → 末分钟 | 46 → 36 ms | 37 → 31 ms | 36 → 160 ms | 36 → 31 ms |
| eval 往返 末分钟均值 | 12 ms | 8 ms | 109 ms | 10 ms |
| 同时在途的 eval（最大） | 4 | 1 | 16 | 1 |
| 合并掉的事件 | 0 | 0 | 0 | 138 |
| WebContent RSS 起 → 止（峰值） | 400 → 970 MB | 486 → 575（634）MB | 485 → 1623 MB | 546 → 687（811）MB |
| DOM 节点（结束时） | 18498 | 1141 | 55539 | 5436 |
| 桥流量（相对内容的倍数） | 43 MB（×12） | 43 MB（×12） | 1092 MB（×109） | 1071 MB（×108） |

- 激进档不再越跑越慢：末分钟掉帧从 80% 降到 6%，到绘制的时间稳定在约 31 ms，在途调用不超过 1 个。剩下的是零星的长卡顿（最长 1.9 s），集中在 UI 测试滑动和拉抽屉的时候。
- 流量仍然是内容的 100 多倍，这是协议「整条替换」本身造成的，桥合并只能减少次数，不能减少每次的大小。
- 打开 3000 条的会话：eval 1931 → 676 ms，画出 6626 → 399 ms，DOM 399K → 2.7K，WebContent 峰值 5019 → 790 MB。快照编码 303 ms，已经移到后台线程。切走再切回只发一次整快照（以前两次）。
- 杀掉 WebContent 进程：89.4 s 被终止，90.0 s 重新 ready。
- 内存警告（60 s `warning`，65 s `critical`）：`SessionCache` 依次缩到 120 条、60 条。渲染包的 DOM 在 `critical` 后从约 1400 降到 624，之后随着新内容推送回到 1700 左右（渲染包本身在做虚拟化，DOM 数量一直在波动，所以这个下降不能完全归因于 `memoryPressure`）。
- `open3000` 限 300 条（`r3-open-cap300`）那一档在 11 s 时被手势崩溃打断，要重跑。

## 原生与 WebView 的分工

| 原生（SwiftUI / UIKit） | WebView 渲染包 |
| --- | --- |
| 连接、`watch` 流、缓存（`SessionsClient` + `SessionCache`） | 会话 store：按 id 整条替换，和 Web 一样 |
| 侧栏抽屉（只从左边缘 20 pt 拉开）：设备与在线状态、配对设备、已置顶、按项目分组 / 全部会话、账号 | 线程：消息、思考、工具调用、计划、diff、附件 |
| 玻璃顶栏：侧栏按钮、标题、Agent · 设备、运行 / 等待状态（来自 `control`）、菜单 | 「等待你确认」标记（`chrome.approvals = 'host'`） |
| 输入框：加号 → 照片 / 文件 + 按 `session.config` 通用渲染的设置项；发送；运行时变成停止 | 复制、回退、分叉、打开文件或链接按钮（发消息给宿主处理） |
| 审批区：`control.pending[0]`，标题用等宽字体，按钮按 `kind` 着色 | 上报 `scroll.atEnd` |
| 「到底部」玻璃按钮、toast、震动、剪贴板、打开文件 / 链接的 Sheet | |

### 触摸归属（不要改回去）

这是修手势崩溃时定下的结构（见「已验证」），以后改界面也要保持：

- **WebView 的祖先上不挂任何手势识别器。** 窗口根是纯 UIKit 的 `ShellViewController`，WebView 在纯 UIKit 的会话页里，不放进 SwiftUI 宿主视图，也不放进带手势的容器。
- **原生控件都是 WebView 的兄弟视图**，叠在它上面：导航栏、SwiftUI 控件层（审批区、输入框、到底部、toast）、侧栏、抽屉的边缘条和关闭区。控件层只在控件区域内接收触摸，其他位置 `hitTest` 返回 nil，触摸直接交给 WebView。
- **抽屉只从左边缘 20 pt 的条带拉开**；打开后只有露出来的那一条卡片可以点或拖来关闭。不要再加覆盖整个页面的拖动手势。
- **不在运行时修改延迟触摸的设置**：不改 `delaysContentTouches`、`delaysTouchesBegan` / `delaysTouchesEnded`，也不 swizzle UIKit 或 WebKit。WebKit 自己的延迟机制保持原样。
- **WKWebView 只在视图进入窗口后创建**（`viewIsAppearing`），之后一直保留，不从窗口里移除。
- 改了这些地方以后，要重跑 `MomentumTouchTests`（惯性滚动中再触摸）、`GestureStressTests` 和 `ScrollerGestureTests`。

### 滚轮与触控板

结论（2026-11-18）：**App 这边不用改**，WebView 能收到并处理指针滚动；iPhone 模拟器上用 Mac 鼠标滚不动，是模拟器根本不把滚轮事件交给 iPhone，任何 App 都一样。

- **事件能到 WKWebView 的 scroll view**：`scrollView.panGestureRecognizer.allowedScrollTypesMask` 是 3（`.all`），和一个普通 `UIScrollView` 相同。滚动事件和触摸一样按位置做 hitTest：`ChromeLayerView` 在控件区域外返回 nil，边缘条只有左边 20 pt，抽屉关上时 `cardView.isUserInteractionEnabled` 为 true，都不挡。
- **渲染包不拦**：`v3poc/web/src` 里唯一的 `wheel` 监听（`document-scroller.tsx`，用来判断「读者在动」）是 `passive: true`，不会 `preventDefault`。页面里注入的探针（`AA_POC_LAYOUT_CHECK=1`）能看到每个 `wheel` 事件。
- **iPad 模拟器（XCUITest 的指针滚动）**：`WheelScrollTests` 通过。滚轮往上滚约 7700 pt，「到底部」按钮出现，滚到顶触发 `loadOlder`，再往下滚回去；代码块（`pre`）能横向滚动；之后触摸拖动照常滚动。
- **iPhone 模拟器**：
  - XCUITest 直接拒绝：「Pointer events are not supported for this device」，所以 `WheelScrollTests` 在 iPhone 上跳过。
  - 模拟器把 Mac 的滚轮 / 触控板滚动交给 `SimDeviceLegacyHIDClient.simDigitizerInputView(_:scrollEvent:)`（Xcode 27.2 的 SimulatorKit），这个方法只在设备有数码表冠或旋钮（Apple Watch 等）时发出 `IndigoHIDMessageForDigitalCrownEvent` / `DigitalDialEvent`，其他设备直接丢掉。原始的滚动 HID 事件只在「把指针交给设备」（指针捕获，iPad）时才转发。
  - 用一个小工具直接往「AAv3PoC Stress」发原始的指针 / 鼠标服务滚动 HID 事件（`IndigoHIDMessageForScrollEventFromHIDEventRef`），本 App 和系统「设置」都不动。iPhone 的 iOS 没有指针支持，这个结果和上一条一致（但这个工具本身没有在 iPad 上对照验证过）。
- 真机 iPad 接触控板、iPhone 接鼠标（辅助触控）都没有测。

### 抽屉卡片的圆角裁剪

抽屉打开时卡片左上、左下是直角（用户截图），原因是**卡片的阴影视图**：`cardShadow` 是卡片裁剪视图的兄弟视图、不在裁剪范围里，却有 `systemBackground` 背景，阴影路径也是直角矩形，所以在圆角外面露出一块直角的白（深色下是黑）底。系统玻璃、导航栏的滚动边缘模糊和 WKWebView 的内容都被正常裁掉了：

- 逐层排除：阴影视图背景改成透明、阴影路径改成同样的圆角之后，三种裁剪方式（iOS 26 的 `cornerConfiguration`；`layer.cornerRadius` + `cornerCurve = .continuous` + `masksToBounds`；`CAShapeLayer` 遮罩）截图都是连续圆角。再用 `AA_POC_BACKDROP=stripes` 在页面里铺满黑白条纹、抽屉停在半开（`AA_POC_DRAWER_HOLD=0.5`）：三种方式下条纹、顶栏的模糊和输入框的玻璃在左上、左下都被裁成圆角，没有溢出。
- 现在用 `layer.cornerRadius` + 连续曲线 + `masksToBounds`（最简单，能跟着动画），描边和阴影路径用同一个半径。半径仍然是屏幕圆角（`window.effectiveRadius`，取不到时 44），卡片盖满屏幕时为 0。`AA_POC_CARD_CLIP=config|mask` 可以切回另外两种做对比。
- 截图在 `.local-dev/v3poc/ios/corner/`（`before-*` 是修复前，`*-stripes-hold-*` 是三种方式的条纹对比，`final-*` 是深浅色 × 半开 / 打开）和 `.local-dev/v3poc/ios/drawer-corners-final.png`（拼图）。

桥（`aa.render/1`）的实现要点：

- 只有一个 WKWebView，在会话页的视图进入窗口后创建（`viewIsAppearing`，不早于窗口）并开始加载，之后一直保留；切换会话只是把那个会话的快照发过去。`ready` 之前的消息不发，`ready` 后依次补发 `chrome`、`appearance`、`viewport` 和当前会话快照。
- `watch` 事件原样转发（内容不改），每帧最多发一次 `evaluateJavaScript`（`CADisplayLink`）：
  - **同一时间只有一次在途**：上一次 `evaluateJavaScript` 返回之前不发下一批。等待期间事件按 key 合并：每个 item id 一个位置，`control` 和 `session` 各一个，后到的值覆盖先到的。渲染包忙时收到的是更少、更新的数据，而不是越积越多的旧版本。其他消息按顺序发出，`viewport` 和 `appearance` 只保留最新的。
  - **快照在后台线程准备**：如果渲染包正在显示同一个会话（比如切走又切回，先显示了缓存），就和渲染包已有的状态（发快照前的缓存）比较，只发变了的 item、`session` 和 `control`，完全相同时什么都不发。比较不了时（有 item 消失了，也就是回退）才发整个快照。比较和 JSON 编码都在后台线程做；准备期间新到的事件排在它后面。
- `memoryPressure`：收到 `UIApplication.didReceiveMemoryWarningNotification` 时发 `warning`。30 秒内第二次警告，或者 App 自己离上限不到 150 MB（`os_proc_available_memory()`，0 表示不知道，模拟器上就是 0）时发 `critical`。WebContent 进程的上限原生读不到，所以主要靠「第一次警告后还不够」这个信号。WebContent 进程被系统终止后（真机上几乎总是因为内存），重新加载的页面一开始就收到 `warning`。级别会在页面重新加载后补发。同时 `SessionCache` 只保留当前会话：`warning` 时保留最后 120 条、之后最多 4 个会话，`critical` 时保留 60 条、最多 2 个会话。
- `viewport {top, bottom}` 是原生控件实际遮住的高度：顶栏加状态栏，输入框和审批区加 Home 指示条或键盘。顶部取会话页的 safe area（状态栏 + 导航栏），底部取 SwiftUI 控件层报告的输入框列的位置（控件层下沿跟着 `keyboardLayoutGuide`），变化时重发。
- `appearance` 包含 `scheme`、`textScale`、`reduceMotion`、`locale`，以及 `account: {name}`（让渲染包把 `control.answered[].by` 显示成「你」）。`textScale` 是当前动态字体下的正文字号除以默认（Large）下的正文字号，默认为 1.0。
- 页面固定为 `aa-app://renderer/renderer.html`；`aa-app://file?path=…` 返回生成的占位图（真实 App 会在这里用自己的凭据去取附件）。页面内的导航一律拦下，改成发 `open` 给原生处理。
- WebView 的设置：透明，背景和原生一致；`contentInsetAdjustmentBehavior = .never`；不能缩放；顶边用 iOS 26 的柔和滚动边缘效果（通过导航栏的 `setContentScrollView(_:for: .top)` 注册）；**底边不做任何模糊或渐隐**（`bottomEdgeEffect.isHidden = true`），只保留输入框和审批区自己的玻璃。点状态栏回到顶部只作用于这个 scroll view（输入框的 `scrollsToTop = false`）。

## 将来换成 MeshCall 客户端

`SessionController` 和 `RendererBridge` 只依赖 `Model/SessionsClient.swift` 里的协议：

```swift
protocol SessionsClient: AnyObject {
    func watch(id: String) -> AsyncStream<JSON>
    func listMessages(id: String, beforeSeq: Int?, limit: Int) async throws -> (messages: [JSON], hasMore: Bool)
    func send(id: String, clientMsgId: String, content: String) async throws -> String
    func answer(id: String, requestId: String, optionId: String) async throws
    func stop(id: String) async throws
    func setConfig(id: String, configId: String, value: String) async throws -> JSON
}
```

`MeshSessionsClient` 实现这个协议并转换 Connector 的事件与快照。断线时 `AsyncStream` 结束，控制器重新订阅。`SessionCache` 保存在内存，默认保留最近用过的 8 个会话及每个会话最后 300 条消息。渲染包通过 `loadOlder` 获取更早的条目。

`MockSessionsClient` 按 `fixtures/build.py` 开头写的脚本语义回放：新 id 第一次出现时分配下一个 `seq`；`stream` 每 `interval` 毫秒推一次整条 item，文字按 `cps` 增长，最后一次推完整内容；`until: answer` 等审批，答复后推一条把请求从 `pending` 挪到 `answered` 的 control（`by` 是账号名，`device` 是 `iPhone`）；发送消息时先推用户消息，再播 `reply`（替换 `$TURN` 和 `$X`）。其他会话按侧栏摘要合成一个小快照：一条用户消息、一条助手回复；`waiting` 状态的会话另外带一条待审批的命令。

## 已验证

在 iPhone 18 Pro 模拟器（iOS 27.0，Xcode 27.2）上，使用真正的渲染包（18:46 版，16 MB）：

- 构建通过，没有警告。
- 截图（在 `.local-dev/v3poc/ios/`，不提交）：流式输出中（浅色）、审批区出现、自动批准后的最终回答、侧栏抽屉、对话选项 Sheet、深色 + 审批区、键盘弹起、切换会话后再切回。确认了这些：内容在顶栏下滚动，顶边有柔和模糊；底部没有模糊；输入框随键盘上移；深浅色背景都没有接缝；附件占位图能显示。
- 键盘弹出时，WebView 自己的 `contentInset` 和 `adjustedContentInset` 都是 0，只有发给渲染包的 `viewport.bottom` 变成 448（输入框 + 键盘），说明 WebView 没有自己做键盘避让。
- 启动到 `ready`：渲染包 1.4 MB 时约 2.0–2.2 s（load → ready 约 0.5–0.7 s）；16 MB 时第一次冷启动 3.3 s（load → ready 1.5 s），之后约 2.0–2.2 s（load → ready 约 0.65–0.73 s）。（以上是 WKWebView 还在 `App.init` 里创建时测的。）UIKit 版本里 WKWebView 等窗口出现后才创建：实测 `App.init` 约 +1.4–1.5 s，WKWebView 创建约 +1.65–1.84 s，ready 约 +2.16–2.50 s（load → ready 0.5–0.68 s）。推迟创建只多出约 0.2 s，前面的 1.4 s 是模拟器上的进程启动。
- **手势崩溃**（`-[UIGestureRecognizer _delayTouchesForEvent:inPhase:]` 里插入 nil，SIGABRT）：
  - **复现**：按用户的方法，在 WebView 上快速滑一下，惯性滚动还没停时（0.1–0.5 s 内）再点一下或再滑一下。XCUITest 默认在每个事件前等 App 空闲（包括动画），所以以前的合成触摸永远落不到惯性滚动期间，一直复现不出来。`MomentumTouchTests` 在测试进程里把这个等待换成空操作（XCUIAutomation 的私有方法，只影响测试进程）。旧版本（`App.init` 里创建 WKWebView + `WebTouchGuard`）两次运行分别在第 1 次和第 2 次惯性触摸时就崩溃。
  - **原因**：
    1. WKWebView 在 `App.init` 里创建，那时场景和窗口都还不存在。WebKit 的几十个手势识别器在没有窗口的情况下建立，之后第一个要延迟触摸的识别器就会触发这个断言。
    2. 后来加的 `WebTouchGuard` 在触摸进行中修改 `delaysContentTouches`，同样会打乱 UIKit 的延迟触摸记录。
    3. WebView 是 SwiftUI 宿主视图的后代，SwiftUI 根视图上的识别器也参与 WebView 上的每一次触摸，并且会延迟触摸：`_UIRelationshipGestureRecognizer`、`_UITouchDurationObservingGestureRecognizer`、抽屉的 `UIPanGestureRecognizer`。
  - **修复**：
    1. WKWebView 只在会话页的视图进入窗口后创建（`viewIsAppearing`，`RendererBridge.makeWebView`）。
    2. 删掉 `WebTouchGuard`：不 swizzle，也不修改任何 `delaysContentTouches` 或 `delaysTouches*`，WebKit 自己的延迟机制保持原样。
    3. 改用 UIKit 结构：窗口根是 `ShellViewController`，WebView 放在纯 UIKit 的会话页里。导航栏、SwiftUI 控件层（审批区、输入框、到底部、toast）和侧栏都是 WebView 的兄弟视图，不是它的祖先。控件层只在控件的区域内接收触摸（`ChromeLayerView.hitTest`），其他位置返回 nil，触摸直接交给 WebView。抽屉只能从左边缘 20 pt 的兄弟条带拉开；打开后，只有露出来的那一条卡片能点或拖动来关闭。WebView 的祖先上只剩导航控制器的两个返回手势，都已关掉。
  - **验证**（专用的克隆模拟器，iOS 27.0）：见下表。lldb 在 `_delayTouchesForEvent:inPhase:` 下断点，用同一套触摸（`MomentumTouchTests/testGestureSample`：惯性中点击和拖动、横向拖动、长按选字、拉开和关闭抽屉）统计是哪些识别器在延迟触摸：
    - 修复前（SwiftUI 结构）：293 次，其中 34 次来自 SwiftUI 宿主视图（`_UIRelationshipGestureRecognizer` 14、`_UITouchDurationObservingGestureRecognizer` 13、抽屉 `UIPanGestureRecognizer` 7），其余都是 WebKit 的（`WKContentView`、`WKScrollView`、`WKChildScrollView` 上的识别器）。
    - 修复后（UIKit 结构）：262 次，SwiftUI 的识别器一次都没有出现。除 WebKit 的以外，只有抽屉条带自己的拖动（3 次）和关闭区的点击（1 次），它们只在触摸从左边缘或露出的卡片开始时出现。
  - 升级安装时，旧版本（SwiftUI 生命周期）保存的场景会话会带着旧的 scene delegate 恢复，窗口是空的。`AppDelegate` 监听 `UIScene.willConnectNotification`，把这种场景交给 `SceneDelegate`。

  - 验证结果（克隆的模拟器，没有新的崩溃报告）：

    | 测试 | 旧版（`App.init` 创建 + `WebTouchGuard`） | 只把创建推迟到窗口出现后 | UIKit 结构（现在） |
    | --- | --- | --- | --- |
    | `MomentumTouchTests/testTouchDuringMomentum`（每次 2 次启动 × 40 下） | 2 次运行都崩，分别在第 1、2 下 | 2 次通过 | 2 次通过 |
    | `…RightAfterColdStart`（8 次冷启动 × 8 下，启动后 1.5 s 开始） | — | — | 通过 |
    | `GestureStressTests`（12 轮 × 13 种操作：拉抽屉、点卡片关闭、长按选字、双击、横拖） | — | 通过 | 通过 |
    | `GestureStressTests/testColdStartTouches`（12 次冷启动，每次 10 s） | — | — | 通过 |
    | `ScrollerGestureTests`（表格、代码块横滑，长按后拖动，流式输出中切换会话） | — | — | 通过 |

- **「到底部」按钮压在输入框上**（用户在压测会话里截到的）：按钮原来放在底栏的 overlay 里，用 `alignmentGuide` 把自己顶到底栏上方；在高频推送时它会退回默认的顶边对齐，压住占位符。现在：
  - 按钮是控件层 VStack 里底栏正上方单独的一行，底边就是底栏实测的顶边减 6 pt，不依赖对齐技巧。
  - 加了迟滞：离末尾超过 160 pt 并且渲染包报告不在末尾时才出现；回到末尾（渲染包报告，或者距末尾不到 24 pt）才消失。距离由原生直接读 WebView 的 scroll view。这样流式输出时按钮不会反复闪现。
  - `PillLayoutTests` 用压测会话（`AA_POC_STRESS`，带审批）反复上滑、点按钮回到底部，审批区出现和消失，期间弹起键盘。`AA_POC_LAYOUT_CHECK=1` 让 App 在控件层每次布局时记录按钮和底栏的位置：302 次检查（其中审批区在 99 次，键盘弹起 8 次），全部满足 `pill.maxY <= bar.minY - 6`。这是布局层面的检查，没有逐帧采样渲染出来的位置（出现和消失的缩放动画只会让间距变大）。

- **内存相关的功能验证**（UIKit 版本，普通会话和压测会话，没有跑分档压测）：
  - 切走再切回：缓存快照和 `watch` 快照在同一时刻到达，只发出一次整快照。
  - 重新 `watch` 当前会话（`AA_POC_REWATCH`）：内容没变时什么都不发（`deltaEvents 0`）；压测会话在推送中时只发 2 个变了的事件，不重发 750 KB 的整快照。
  - `SessionCache` 上限：500 条的会话进入缓存和渲染包时是 300 条（再早的条目通过 `loadOlder` 取回）。
  - 内存警告：第一次发 `warning`，缓存只留当前会话、缩到 120 条；2 秒后第二次发 `critical`，缩到 60 条。
  - 整快照的编码在后台线程（`Task.detached`）；桥同一时间只有一次 `evaluateJavaScript` 在途（每 5 秒的统计里在途最大值都是 1），30 Hz 推送时 5 秒内合并掉 33 个事件。

- **圆角裁剪和滚轮这一轮之后的回归**（「AAv3PoC Stress」克隆，2026-11-18）：`MomentumTouchTests` 三个方法全部通过，`GestureStressTests/testColdStartTouches` 通过，没有新的崩溃报告。`GestureStressTests` 的其余方法、`ScrollerGestureTests`、`PillLayoutTests` 因为宿主负载太高暂停了，还没跑。

## 没有验证

- 真机（没有签名，也没有设备）。真机上 WKWebView 的首次加载、内存和 Web 内容进程被系统回收后的恢复（代码里会自动重新加载，但没有触发过）都没测。
- VoiceOver、动态字体放到最大、减少动态效果：代码里有处理，但没有逐项检查。
- 性能：长会话（几百条 item）的流式输出帧率、16 MB 渲染包的解析时间和内存，都没有测量。
- 回退、分叉、复制、打开文件或链接这些从渲染包发回的消息：原生的处理代码已经写好（toast、剪贴板、Sheet），但截图里没有点到（模拟器没有点击工具，压力测试也没有去点这些按钮）。
- iPad 分栏布局（UIKit 结构下侧栏是固定宽度的一栏）只编译通过，没有截图。
- 鼠标滚轮 / 触控板：只在 iPad 模拟器上用 XCUITest 的指针滚动验证过（见「滚轮与触控板」），真机 iPad 接触控板和 iPhone 接鼠标都没测。`WheelScrollTests` 拆成两个方法以后，竖向那个方法的最终版本没有在 iPad 上重跑（重跑前的版本除横向一项外全部通过，横向一项移到第二个方法后通过）。
- 抽屉卡片圆角：拖动中的状态是用 `AA_POC_DRAWER_HOLD` 停在半开位置截的，不是在真实拖动中截图；卡片右侧的两个角在抽屉打开时在屏幕外，看不到。
- 按压效果：控件里没有自定义的按下缩小（没有 `scaleEffect(pressed …)` 一类的写法），玻璃按钮都用系统的 `.glass` / `.glassProminent` 按钮样式或 `.glassEffect(.regular.interactive())`，按下放大和回弹交给系统；实色按钮（发送、加号）是 `.plain`。只做了代码检查，没有逐个截按下时的样子。
- 照片和文件选择器能打开，但附件不会上传（演示里只弹出 toast）。
