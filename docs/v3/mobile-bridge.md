# AA v3 移动端 WebView bridge（`aa.render/2`）

状态：定稿草案（2026-11-23，待确认）。iOS（`ios-v3/`）和 Android（`android-v3/`）用同一份 web-v3 渲染包（`web-v3/embed/`，构建为单个 HTML 文件）绘制消息流和终端；原生层持有 MeshCall 连接、`watch` 流和缓存，WebView 自己不联网。界面分工见 [client-experience-proposal.md](client-experience-proposal.md)，终端见 [terminal-proposal.md](terminal-proposal.md)。

## 1. 通道

| | 网页 → 原生 | 原生 → 网页 |
| --- | --- | --- |
| iOS（WKWebView） | `window.webkit.messageHandlers.aa.postMessage(obj)` | `webView.evaluateJavaScript("window.aa.receive(<json>)")` |
| Android（WebView） | `window.AndroidAA.postMessage(JSON.stringify(obj))`（`@JavascriptInterface`） | `webView.evaluateJavascript("window.aa.receive(<json>)", null)` |
| 浏览器调试 | `window.parent.postMessage` | `window.postMessage` |

- 每条消息都是 `{ v: 2, type: string, ... }`，字段用 snake_case，字节用 base64。
- 渲染包加载完成后先发 `ready`；原生层收到 `ready` 之前不发其他消息（之前的消息排队）。
- 原生层按帧（约 16 ms）合批：同一帧里的多条消息合成一条 `batch { messages: [...] }`。

## 2. 原生 → 网页

| type | 字段 | 说明 |
| --- | --- | --- |
| `theme` | `scheme: "light"\|"dark"`, `insets: {top,bottom,left,right}`, `font_scale?`, `reduce_motion?`, `high_contrast?` | 外观和被原生玻璃控件遮住的安全区；变化时重发 |
| `locale` | `locale: "zh-CN"\|"en"` | |
| `view.conversation` | `device_id`, `session_id`, `agent`, `readonly`, `encrypted` | 切换到某个对话；网页清空旧内容，等 `conversation.event` 的快照 |
| `conversation.event` | `session_id`, `event` | 原样转发 `aa.v3.Sessions/watch` 的 `WatchEvent`（`snapshot` / `message` / `session` / `control`） |
| `conversation.older` | `session_id`, `messages`, `has_more` | 回应 `load_older` |
| `conversation.cached` | `session_id`, `messages`, `control`, `stale: true` | 离线时显示缓存（只读、标为过期） |
| `file.data` | `request_id`, `ok`, `base64?`, `mime?`, `error?` | 回应 `file.read` |
| `view.terminal` | `device_id`, `terminal_id`, `controller_label?` | 切换到终端视图 |
| `term.snapshot` / `term.output` / `term.control` / `term.rejected` / `term.exit` / `term.closed` | 同 `aa.v3.Terminals/attach` 的输出帧 | 原生层转发 attach 流 |
| `scroll` | `to: "bottom"\|"top"` | 原生按钮（例如回到底部）触发 |

## 3. 网页 → 原生

| type | 字段 | 说明 |
| --- | --- | --- |
| `ready` | `version`, `capabilities: string[]` | |
| `load_older` | `session_id`, `before_seq` | 滚到顶部时请求更早的消息 |
| `answer` | `session_id`, `request_id`, `option_id` | 消息流里的审批卡片被点击（原生审批区也能答，二者等价） |
| `open_link` | `url` | 外部链接交给系统打开。`url` 也可能是云盘引用 `drive:/…`（[assistant-and-files-proposal.md](assistant-and-files-proposal.md) 6.3）：应在 App 的云盘页打开，还没有云盘页时忽略 |
| `open_file` | `path`, `line?` | 打开设备上的文件（原生层推出文件页） |
| `file.read` | `request_id`, `path`, `max_bytes?` | 预览附件或图片时取字节；原生层经隧道 `read_file`（大文件走云盘） |
| `copy` | `text` | |
| `haptic` | `kind: "light"\|"success"\|"warning"` | |
| `scroll_state` | `at_bottom`, `distance` | 原生层据此显示或隐藏「回到底部」按钮 |
| `term.attach` / `term.detach` | `terminal_id`, `mode?`, `cols?`, `rows?` | |
| `term.input` / `term.resize` / `term.claim` / `term.release` | 同 attach 输入帧 | |

原生扩展键栏（Esc、Ctrl、Tab、方向键、PgUp/PgDn、Home/End）的按键由原生层发 `term.key { key, ctrl?, alt?, shift? }` 给网页，网页按与 Web 相同的映射转成按键序列，再以 `term.input` 发回原生。

## 4. 触摸与布局

- WebView 内的触摸只归 WebView；原生控件是叠在 WebView 上方的兄弟视图，原生层不在 WebView 的祖先上挂手势，抽屉只从屏幕边缘滑出。
- 网页按 `theme.insets` 给内容留出被原生顶栏、输入框遮住的空间，滚动内容可以从玻璃下方穿过。
- WKWebView 在窗口存在之后再创建（避免触摸延迟设置失效）。
