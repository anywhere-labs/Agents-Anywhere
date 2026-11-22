# 移动端渲染包（`web-v3/embed`，`aa.render/2`）

iOS（`ios-v3/`）和 Android（`android-v3/`）用 WebView 加载的单文件 HTML：用 web-v3 自己的对话组件（`components/conversation/*`、`lib/timeline/store.ts`、Streamdown + Shiki）画消息流，用 web-v3 的 xterm.js 终端（`components/terminal/terminal-view.tsx` + `lib/terminal/bridge-transport.ts`）画终端。WebView 不联网：所有数据经 bridge 从原生层来，协议见 [docs/v3/mobile-bridge.md](../../docs/v3/mobile-bridge.md)。

## 构建

```bash
cd web-v3
corepack yarn embed:build      # → embed/dist/aa-render.html（约 3 MB，JS / CSS / 字体全部内联）
corepack yarn embed:smoke      # 无头浏览器冒烟测试（390×844，浅色 / 深色），截图写到 embed/.artifacts/
corepack yarn embed:dev        # 开发服务器 + 夹具回放页 http://127.0.0.1:5179/harness/
corepack yarn embed:schema     # 由 src/protocol.ts 重新生成 protocol.schema.json
```

产物不提交，原生工程在构建时运行 `embed:build` 并把 `dist/aa-render.html` 拷进 App 资源。

- 页面带 CSP（`default-src 'none'`，图片 / 字体只允许 `data:` / `blob:`），任何网络请求都会被拦下。
- 不内联网页字体：中文走系统字体（iOS PingFang、Android Noto），KaTeX 只保留 woff2。
- Shiki 只带常用语法（TypeScript/JavaScript、Shell、Python、Go、Rust、Java、Kotlin、Swift、C、JSON、YAML、TOML、SQL、Diff、Dockerfile、CSS、XML/HTML 等），其余语言按纯文本显示；Mermaid 不打包（约 2 MB），图表显示源码。见 `src/shims/`。

## 文件

| 文件 | 内容 |
| --- | --- |
| `src/protocol.ts` | **协议的唯一来源**：两个方向全部消息的 TS 类型、`CAPABILITIES`。原生层照它镜像 |
| `protocol.schema.json` | 由 `protocol.ts` 生成的 JSON Schema（draft-07，根类型 `BridgeMessage`），原生测试可用它校验收发的消息 |
| `src/bridge.ts` | 通道选择（iOS / Android / 浏览器）、`ready` 握手、`batch` 拆包、按类型分发、`window.aa.receive` |
| `src/controller.ts` | 不依赖 React 的状态：主题、语言、当前视图、时间线、`answer` / `load_older` / 链接 / `scroll_state` |
| `src/file-cache.ts` | `file.read` → `file.data`，按路径缓存为 object URL |
| `src/terminal-channel.ts` | `term.*`（`terminal_id`）与 `bridge-transport.ts`（`id`）之间的适配，`term.key` 映射 |
| `src/conversation-view.tsx`、`src/terminal-screen.tsx`、`src/app.tsx` | 视图 |
| `harness/` | 夹具回放页（扮演原生层：等 `ready`、按帧合批、应答 `load_older` / `file.read`、发 `theme` / `scroll` / `term.key`） |
| `fixtures/` | 回放夹具：`conversation-pi`、`conversation-antigravity`、`terminal` 是从本地 v3 栈录下的真实 `aa.v3.Sessions/watch` / `aa.v3.Terminals/attach` 事件（已去掉本机信息）；`conversation-showcase` 是覆盖审批、计划、子 Agent、附件、分页的合成数据；`conversation-cached` 是离线缓存 |
| `scripts/record-fixtures.mjs` → `scripts/build-fixtures.mjs` | 重新录制（只作为普通客户端连接正在运行的栈）并生成夹具 |

## 原生层接入要点

1. 加载 `aa-render.html`（iOS `loadFileURL`，WKWebView 在窗口存在后再创建；Android `file:///android_asset/…` 或 `WebViewAssetLoader`）。
2. 注册通道：iOS `messageHandlers.aa`（收到的是对象），Android `@JavascriptInterface` 对象 `AndroidAA.postMessage(String json)`。
3. 收到 `ready` 之前把要发的消息排队；之后按帧（约 16 ms）合成一条 `batch`，用 `window.aa.receive(<json>)` 送进页面。先发 `theme`、`locale`，再发 `view.conversation` / `view.terminal`。
4. 对话：把 `aa.v3.Sessions/watch` 的事件原样包进 `conversation.event`；页面发 `load_older` 时调 `list_messages({ before_seq })` 回 `conversation.older`；离线时发 `conversation.cached`。
5. 终端：页面发 `term.attach`（带 `mode`、`cols`、`rows`、`label`，重连时带 `resume_seq`）后再转发 attach 流；页面的 `term.input` / `term.resize` / `term.claim` / `term.release` 原样写回 attach 流；attach 断开时发 `term.closed`（`fatal` 表示不要重连）。
6. 扩展键栏发 `term.key`：`key` 取 `escape`、`tab`、`up`、`down`、`left`、`right`、`home`、`end`、`page_up`、`page_down`，或单个字符配 `ctrl` / `alt`（如 `{ key: "c", ctrl: true }`）；`{ key: "ctrl" }` 锁存 Ctrl 给下一个键盘输入的字符。

## 相对 mobile-bridge.md 的补充

都是可选字段或新增的类型，不影响按文档实现的原生层：

- `ready` 多一个 `protocol: "aa.render/2"`。
- `view.conversation` 可带 `me`（读者账号名：自己发的消息、自己处理的审批显示为「你」）。
- `view.terminal` 可带 `attach_mode`（`"control"`：本机刚创建的终端）、`term_mode`（`pty` / `pipe` / `script`）、`owner`（`agent` 只读）、`cols` / `rows`。
- 原生 → 网页的 `term.*` 可带 `terminal_id`，不是当前终端的帧会被丢掉。
- 新增 `term.closed { fatal?, snapshot_next? }`（文档表格里列了名字，没列字段）。
- `conversation.cached` 状态下不发 `load_older`、不显示审批按钮；`readonly` 时审批只做标记，由原生审批区处理。
- 消息流里的 `file://` 链接走 `open_file`（带 `#L行号` 时附 `line`），其余链接走 `open_link`。

## 已知限制

- 对话组件里的文字目前写死为中文（与 Web 端相同），`locale` 只影响渲染包自己的提示和终端。
- Streamdown 的 HTML 清洗会去掉 `file://` 链接（Web 端同样显示为 `[blocked]`），所以 Agent 输出里的文件链接暂时点不了；`open_file` 目前来自工具步骤里的文件路径。要修需要给 `components/conversation/markdown.tsx` 的 Streamdown 放开 `file:` 协议。
- 没有在真机 WKWebView / Android WebView 上验证过（冒烟测试用的是 Chromium 无头浏览器，模拟 iOS 通道）。
