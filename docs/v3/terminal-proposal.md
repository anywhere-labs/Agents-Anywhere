# AA v3 终端：控制权、第一帧与滚动

状态：已定稿（2026-11-22）。服务定义见 [contracts/aa-v3/1.0/terminals.schema.json](../../contracts/aa-v3/1.0/terminals.schema.json)，总体架构见 [architecture-proposal.md](architecture-proposal.md)。

## 1. 前提

- 终端跑在工作设备上，由 Connector 的 `aa.v3.Terminals` 提供，客户端经隧道 `attach`。
- 一个终端可以同时被多台设备查看，但**同一时间只有一台设备能输入和改尺寸**。
- 四端用同一套 xterm.js 终端组件渲染：Web 直接用，Desktop 和移动端在 WebView 里加载同一份打包产物。移动端的原生层只负责连接、缓存和叠在 WebView 上的原生控件（扩展键栏），WebView 自己不联网。

## 2. 真终端（PTY）

- Connector 默认用 PTY 启动 shell（`TERM=xterm-256color`），改尺寸会真正下发到 PTY，全屏程序（vim、htop、Claude Code）能正常运行。
- PTY 通过可选依赖 `@lydell/node-pty`（带各平台预编译包）提供；加载失败时退回管道模式（`mode: "pipe"`，Linux 上可用 `script`），并在 `TerminalInfo.mode` 里如实标出，客户端据此提示「这台设备不支持全屏程序」。

## 3. 控制者与旁观者

- 每个终端有一个**控制者**（可以为空）。只有控制者的 `input` 和 `resize` 会被执行；其余连接都是**旁观者**，只收输出。
- 控制者按 `attach` 连接认，身份标识按客户端：加密设备用握手得到的客户端公钥（`e2e:<peer_key>`），普通设备用隧道 `principal`。名称只用于显示：加密设备取本机配对记录的名称，普通设备取客户端在 `attach` 时自报的 `label`。
- **接管**：任何连接发 `claim` 立即成为控制者，原控制者收到 `control` 事件后切为只读。不做「申请、对方同意」：设备都属于同一个用户，原控制者可能已经锁屏或切到后台，等它同意会卡住。
- **`attach` 的 `mode: "control"` 不抢控制权**：只在没有控制者、或当前控制者（在线或在宽限期内）的 `client_id` 与调用方相同时才成为控制者，此时 `attach` 带的 `cols/rows` 才会应用；否则按旁观者加入，收到普通的 `control` 帧（`you: false`），要接管必须再显式发 `claim`。只有 `claim` 帧是无条件接管。
- **控制代数**（`generation`）：每次换控制者加一。`input` 和 `resize` 必须带上当前代数，代数不对的输入一律丢弃，并给发送方回一次 `rejected`。这样交接时旧控制者还在路上的按键不会落进新控制者的会话。
- **自动释放**：控制者的 `attach` 断开后保留 10 秒宽限期，期间同一客户端以 `mode: "control"` 重连会直接恢复控制（代数照样加一），别的客户端以 `mode: "control"` 连上只是旁观者；过了宽限期控制者清空，尺寸保持最后的值。
- **自动认领**由客户端决定：没有控制者时，用户一打字客户端就先发 `claim`；已有控制者时，客户端提示「要接管吗？」，不悄悄抢。新建终端的那台设备 `attach` 时用 `mode: "control"`。
- **尺寸只听控制者**：PTY 的行列数等于控制者窗口的大小。旁观者按控制者的行列数渲染（放不下就横向滚动或缩小字号），从不发 `resize`。`claim` 可以带上自己的尺寸，也可以 `keep_size: true` 保持当前尺寸（手机接管只敲一条命令时，不把电脑上的 vim 挤成手机宽度）。
- 独立的一元方法 `Terminals/resize` 没有 `attach` 连接可以带代数，只在调用方身份（规则同上）等于当前控制者的 `client_id` 时执行（宽限期内也算），否则返回 `failed_precondition`（`details.reason = "not_controller"`）。客户端应优先在 `attach` 流里发 `resize` 帧。
- 预留：将来由 Agent 通过 ACP `terminal/create` 创建的终端 `owner = "agent"`，所有人只读，`claim` 一律拒绝。

## 4. 第一帧：屏幕快照，而不是原始字节回放

Connector 给每个终端维护一个无界面终端模拟器（`@xterm/headless` + `@xterm/addon-serialize`，纯 JS），把全部输出都喂给它，它一直保存「当前屏幕长什么样」。

- `attach` 后第一帧是 `snapshot`：序列化后的当前屏幕、普通模式下最近 1000 行历史、全屏程序的画面、光标位置，以及程序打开的终端模式（鼠标上报、括号粘贴、应用光标键等）。客户端把它写进一个干净的 xterm.js 实例，就得到和设备上完全一致的画面。
- 快照之后是实时 `output`，每块带递增的 `seq`；快照带上它已包含到的 `seq`。快照和订阅在同一步登记，中间不会漏输出。
- 紧接着是 `control` 事件：当前控制者、代数、你是不是控制者、行列数。之后控制权或尺寸每次变化都会再发一次给所有连接。
- **断线续传**：重连时带上 `resume_seq`（最后收到的 `seq`）。如果后面的输出还在 Connector 的缓冲区（最近 1 MiB）里，就只补发缺的部分，不再发快照；否则发一份新快照。
- **客户端缓存**：移动端原生层保存每个终端最后的画面，重新打开时立刻显示并标为「重新连接中」，连上后用新快照替换；设备离线时只读显示这份缓存。
- 跟不上的连接（积压超过 4 MiB）会被断开，重连后从快照开始，不无限缓冲。

## 5. 滚轮、翻页、鼠标

| 情况 | 由谁处理 | 是否发给设备 |
| --- | --- | --- |
| 普通 shell 输出 | 客户端本地滚动 xterm.js 的历史 | 否，旁观者也可以随便滚 |
| 全屏程序且开了鼠标上报（vim `mouse=a`、htop、tmux） | xterm.js 转成鼠标序列 | 是，只有控制者 |
| 全屏程序但没开鼠标上报（less、man） | xterm.js 把滚轮转成上下方向键 | 是，只有控制者 |

- 旁观者在客户端就丢掉所有会产生输入的事件（`disableStdin` 并过滤输入回调），界面提示「接管后可操作」；Connector 按代数再拒绝一次作为兜底。
- 桌面和 Web：滚轮、点击、拖选直接交给 xterm.js。
- 移动端（WebView 内，触摸只归 WebView，原生层不挂手势）：
  - 单指上下拖动：把位移换算成合成的 `WheelEvent` 派发给 xterm 元素，由 xterm.js 按当前模式决定本地滚动、发方向键还是发鼠标上报；松手后按速度衰减继续派发，做出惯性。
  - 单击：聚焦并弹出键盘（只有控制者）；程序开了鼠标上报时同时发一次点击。
  - 长按：进入选择，拖动选中后弹出 JS 的「复制」工具条。
  - 双指捏合：调整字号；控制者捏合改变行列数，手势停下约 300 ms 后发一次 `resize`。
  - 键盘上方的原生玻璃扩展键栏：Esc、Ctrl、Tab、方向键、PgUp/PgDn、Home/End，经 bridge 发进 WebView，由终端组件转成按键序列，只有控制者可用。
  - 键盘弹出或收起导致可见行数变化时，控制者防抖后发 `resize`。输入框关闭自动纠错、自动大写和拼写检查，中文输入走 xterm.js 自带的组字。

## 6. 移动端 bridge

- 原生发给 WebView：`term.snapshot`、`term.output`、`term.control`、`term.exit`。
- WebView 发给原生：`term.input`、`term.resize`、`term.claim`、`term.release`。
- 原生层按帧（约 16 ms）把 `output` 合批后再发给 WebView；WebView 跟不上时丢掉积压并请求新快照。这一项影响 bridge 吞吐，原生端实现后要专门做一次终端输出洪峰的 WebView 压测。
