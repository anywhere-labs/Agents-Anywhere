# Agents Anywhere v3 iOS / iPadOS

AA v3 的原生 iOS / iPadOS 客户端（SwiftUI，iOS 18+，iOS 26 起使用系统 Liquid Glass）。界面结构与手机布局见
[客户端体验方案](../docs/v3/client-experience-proposal.md)（在 `docs/docs/v3-client-experience` 分支），架构见
[总体架构](../docs/v3/architecture-proposal.md)和[加密设备准入](../docs/v3/e2ee-admission-proposal.md)。

- 账号、设备、隧道走 AA v3 控制面（`server-v3`）：HTTP 只用于登录、刷新和换 Router Token，其余都是 MeshCall
  （`aa.v3.Control`）。
- 对话、终端、文件直接经 MeshCall 隧道调用设备上的 Connector（`aa.v3.Sessions` / `aa.v3.Device` /
  `aa.v3.Terminals`）；加密设备走端到端隧道（首次扫码 `Noise_IKpsk2`，之后 `Noise_IK`），显示绿锁。
- 消息流和终端由 web-v3 的移动端渲染包（`web-v3/embed`）在 WKWebView 里绘制，协议是 `aa.render/2`
  （[mobile-bridge.md](../docs/v3/mobile-bridge.md)，同在该文档分支；以 `web-v3/embed/src/protocol.ts` 为准）；侧栏、顶栏、输入框、
  审批区、扩展键栏是原生控件。

## 目录

| 路径 | 内容 |
| --- | --- |
| `Packages/AAClientCore/` | 与界面无关的核心（Swift 包，`swift test` 覆盖） |
| `  Models/` | `connector-v3/src/core/timeline.ts` 与 `contracts/aa-v3/1.0/control.schema.json` 的 Swift 镜像（解码开放：未知 part / 枚举值保留） |
| `  Auth/` | 控制面 HTTP：`/auth/login`、`/auth/refresh`（轮换 refresh token 并写回钥匙串）、`/auth/router-token` |
| `  Mesh/ControlPlaneClient.swift` | `aa.v3.Control`：`watch_devices`、`list_sessions`（流）、`open_tunnel`；Router 重启后 `unauthenticated` 时自动换 Token 重试 |
| `  Mesh/DeviceTunnelPool.swift` | 每台设备一条隧道；加密设备的防降级规则（见下）、扫码配对、Sessions / Device / Terminals 调用 |
| `  Mesh/SessionMerge.swift` | 多设备会话合并，跑 `contracts/aa-v3/1.0/fixtures/session-merge.json` 全部用例 |
| `  Security/` | 钥匙串存储、本机 X25519 身份、`aa-pair://v1/…` 解析、信任记录、公钥指纹 |
| `  Cache/` | 离线缓存（设备列表、各设备会话列表、最近对话快照），设备离线时只读显示 |
| `  Bridge/RenderBridge.swift` | `aa.render/2` 原生侧：消息构造与解析、`ready` 前排队、按帧合批 |
| `AgentsAnywhere/` | App（Xcode 同步文件夹）：`App/` 模型，`Views/` 界面，`Web/` WKWebView 宿主，`Resources/` 占位渲染页 |
| `AgentsAnywhere.xcodeproj` | 手写的工程（无 xcodegen），共享 scheme `AgentsAnywhere` |
| `scripts/bootstrap.sh` | 把 MeshCall Swift SDK 链接到 `Vendor/meshcall-swift` |
| `scripts/copy-render-bundle.sh` | 构建阶段：拷入 web-v3 渲染包，没有时用占位页 |

## 准备

MeshCall Swift SDK 位于 meshcall 仓库的子目录 `meshcall-swift/`（仓库根没有 `Package.swift`），SwiftPM 无法按 git
URL 解析，所以按本地路径依赖。把 [meshcall](https://github.com/t4wefan/meshcall) 检出到与 Agents-Anywhere 同级的目录
（`v0.4.0`），然后：

```bash
cd ios-v3
scripts/bootstrap.sh          # 生成 Vendor/meshcall-swift（已忽略，不提交）；在 git worktree 里也能找到主检出旁的 meshcall
# 或指定位置：MESHCALL_SWIFT_PATH=/path/to/meshcall/meshcall-swift scripts/bootstrap.sh
```

## 构建与测试

`xcode-select` 指向 Command Line Tools 时要设 `DEVELOPER_DIR`：

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
(cd Packages/AAClientCore && swift test)
xcodebuild -project AgentsAnywhere.xcodeproj -scheme AgentsAnywhere \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' CODE_SIGNING_ALLOWED=NO build
```

连本地 v3 栈的端到端测试（默认跳过）：登录 → `watch_devices` → 开隧道 → 新建对话 → 发消息 → 在 `watch` 上等到回复；
另一个测试新建终端、以控制者身份 attach、输入命令并读回输出：

```bash
cd Packages/AAClientCore
AA_LIVE_CONTROL_URL=http://127.0.0.1:8790 AA_LIVE_EMAIL=dev@aa.local AA_LIVE_PASSWORD=… AA_LIVE_AGENT=pi swift test --filter Live
```

在模拟器里运行：钥匙串需要签名，用「Sign to Run Locally」构建（`CODE_SIGNING_ALLOWED=NO` 的产物能编译但登录时会报
`Keychain error -34018`）：

```bash
xcodebuild … CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= -derivedDataPath build build
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/AgentsAnywhere.app
```

Debug 构建支持用启动环境变量自动登录和跳转（Release 不编译这段代码，见 `App/DebugLaunch.swift`）：

```bash
SIMCTL_CHILD_AA_DEBUG_CONTROL_URL=http://127.0.0.1:8790 SIMCTL_CHILD_AA_DEBUG_EMAIL=dev@aa.local \
SIMCTL_CHILD_AA_DEBUG_PASSWORD=… SIMCTL_CHILD_AA_DEBUG_ROUTE='new:pi:你好' \
xcrun simctl launch booted dev.agentsanywhere.v3
```

`AA_DEBUG_ROUTE`：`device`、`terminal`、`settings`、`newsheet`、`pairsheet`、`new:<agent>:<消息>`、
`conversation:<设备 id>:<对话 id>`、`pair:<aa-pair://v1/…>`；`AA_DEBUG_DEVICE` 选设备（id 或名称片段）；
`AA_DEBUG_BRIDGE=1` 打印发给页面的消息；`AA_DEBUG_TERM_KEYS` 在终端 attach 后按扩展键发送这些字符。

## 渲染包

构建阶段 `Copy web-v3 render bundle` 把 `../web-v3/embed/dist/aa-render.html` 拷进 App；产物不提交，先在 web-v3 里构建：

```bash
cd web-v3 && corepack yarn embed:build      # → embed/dist/aa-render.html
```

- `AA_RENDER_BUNDLE=<文件>`：用指定文件（例如别的检出里构建好的）。
- `AA_BUILD_RENDER_BUNDLE=1`：构建 App 前先在 `../web-v3` 跑 `embed:build`（需要 Node 和依赖，默认关闭，保持 Xcode 构建快且不联网）。
- 没有渲染包时加载内置的 `Resources/aa-render-placeholder.html`：同一个 `aa.render/2` 协议，纯文本显示消息、审批按钮、
  分页和一个纯文本终端，App 在渲染包就绪前也能用。设置页「关于 › 渲染包」显示当前用的是哪一个。

原生侧按 `protocol.ts` 实现：`ready`（带 `protocol: "aa.render/2"`）之前不发消息，之后按帧（约 16 ms）合成 `batch`；
先发 `theme`（含被原生玻璃控件遮住的 `insets`）、`locale`，再发 `view.conversation`（带 `me`）/ `view.terminal`（带
`attach_mode`、`term_mode`、`owner`、尺寸）；`watch` 事件原样包进 `conversation.event`；`load_older` → `list_messages`；
`file.read` → 隧道 `read_file`；终端 `term.attach` 的 `mode` / `cols` / `rows` / `resume_seq` / `label` 原样带进
`Terminals/attach`，`term.input` / `term.resize`（含 `generation`）/ `term.claim` / `term.release` 原样写回，attach 结束时发
`term.closed { fatal }`；扩展键栏发 `term.key`（`escape`、`tab`、`up`…`page_down`，`ctrl` 锁存下一个键入字符）。

## 界面与交互约定

- 手机单栏导航（设备 / 最近对话 → 设备 → 对话），iPad 用 `NavigationSplitView` 侧栏 + 详情；侧栏只从屏幕边缘出现（系统行为），
  App 不在任何地方加边缘手势。
- WebView 内的触摸只归 WebView：原生控件是叠在上方的兄弟视图（`safeAreaInset`），不在 WebView 的祖先上挂手势识别器；
  WKWebView 在宿主视图进入窗口（`didMoveToWindow`）之后才创建。
- WebView 铺满屏幕，内容从导航栏和输入框的玻璃下方穿过；页面按 `theme.insets` 留白（UIKit 报告的安全区 + 底部原生控件高度）。
- 系统材质和语义色：iOS 26 起浮层用 `glassEffect`，之前用系统材质；不给玻璃加自定义色调；「减弱透明度」时改为不透明底色，
  「增强对比度」时加描边并发 `high_contrast`；动态字体按比例发 `font_scale`。
- 对话页：审批区固定在输入框上方；运行中可以排队（默认）或插话（长按发送键选择）；停止；Agent 配置（模型、推理强度、权限模式）
  用胶囊菜单；附件 ≤ 8 MiB 经隧道 `save_attachment` 存到设备后随消息引用路径。

## 安全

- 本机 X25519 私钥和账号凭据只存钥匙串（`AfterFirstUnlockThisDeviceOnly`，不随 iCloud 钥匙串同步）。
- 加密设备的公钥只来自它的二维码；配对前先写入「要求端到端加密」的信任记录，失败则回滚。
- 本地钉住或服务端提示为加密的设备：没配对 → `e2e_not_paired`；服务端给明文隧道 → `e2e_required_locally`；
  握手失败 → `e2e_handshake_failed`，一律不回退明文。二维码公钥与已钉住的不同 → `device_pub_mismatch`，只能先在设置里移除再扫码。
- 控制面聚合结果里，本地钉住的加密设备只接受客户端自己经隧道拿到的列表（合并规则 4）。

## 已知限制

- 大于 8 MiB 的附件（经云盘中转、`fetch_drive_file`）还没接；`save_attachment` 还没带 `session_id`（Connector 侧未实现）。
- 文件页（目录浏览、文件预览、git diff）、对话的重命名以外的更多菜单（分叉、压缩、删除）、⌘K 搜索、随身助手、推送通知都还没做。
- 界面文字只有中文，没有英文本地化；没有 App 图标。
- 只在 iPhone 18 Pro 模拟器（iOS 27）上验证过；iPad 布局、真机、相机扫码（模拟器无相机，用的是粘贴 / 调试路由）未验证。
