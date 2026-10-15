# Codex IPC 调研与 CodexRuntime 复刻方案

状态：调研结论 + 实施方案（2026-10-10）。依据：本机 Codex CLI 0.162.0 / daemon 0.162.1、VS Code 插件 `openai.chatgpt` 26.1007.21434、ChatGPT.app（Codex 桌面）26.1007.21159、上游 `openai/codex` 源码（commit `c3d3b142`，2026-10-10）。本文**没有**参考本仓库 connector 里已有的 IPC 实现。

配套只读探针：[devtools/codex-ipc/daemon_probe.py](../devtools/codex-ipc/daemon_probe.py)、[devtools/codex-ipc/ipc_router_probe.py](../devtools/codex-ipc/ipc_router_probe.py)。

## 0. 一句话结论

“Codex IPC” 实际上是**两层互不相同的机制**，接管 Codex 会话要分别对接：

| 层 | 路径 | 谁在用 | 协议 | 能接管什么 |
| --- | --- | --- | --- | --- |
| A. 共享 app-server daemon | `~/.codex/app-server-control/app-server-control.sock` → `/tmp/codex-daemon-<uid>/<hash>` | 交互式 `codex` TUI（0.157+ 默认）、`codex agents`、`codex queue`、`codex remote-control`、第三方工具 | WebSocket over Unix socket，载荷是 app-server JSON-RPC v2 | 终端里运行的 TUI 会话：看、发消息、steer、中断、回审批 |
| B. IDE / 桌面 IpcRouter | `~/.codex/ipc/ipc.sock`（Windows：`\\.\pipe\codex-ipc`） | VS Code 插件各窗口、ChatGPT.app（Codex 桌面） | 4 字节小端长度前缀 + JSON 帧；自定义 request/response/broadcast 路由；上面跑 **thread owner / follower 协议** | 桌面 App 和 VS Code 里的会话：订阅状态流（snapshot + JSON Patch），并通过 `thread-follower-*` 请求让 owner 代为执行 turn/approval 等 |

### 0.1 最终结论（2026-10-10 17:10）

- **主方向是层 B（IpcRouter owner/follower）**，桌面 App 和 VS Code 都已在真机上端到端验证：discovery 毫秒级、snapshot、patch 流、`thread-follower-start-turn` 发起回合。Connector 两个方向都实现了：窗口持有的线程由 connector 跟随并代发；connector 持有的线程也对窗口应答 owner 发现并供给 snapshot，窗口可通过 `thread-follower-*` 操控（见 4.5）。下午一度得出“桌面不可用”的结论，后来确认是旧桌面实例里一个 IPC client 挂死造成的意外，重启后一切正常；VS Code 当时也因此接管不了，证明那是实例故障而不是协议限制。
- 持有关系的权威判据是 `~/.codex/thread-writer-locks/<id>.lock` 的 flock 持有者。三种接管模式：有 owner 且可达 → IPC follower；无人持有 → 自家 app-server `thread/resume` 独占接管（任何来源的线程都适用）；有人持有但 discovery 找不到 owner → 只读等待，绝不 resume。
- **discovery 的实际语义（真机复核）**：窗口只对自己持有的线程应答 `canHandle: true`，对其它线程根本不应答，于是只要桌面或 VS Code 在线，所有非持有线程的 discovery 都会在 router 的 10 s 超时后返回 `no-client-found`。因此“10 s 超时”不能用来区分“无人持有”和“持有者挂死”，实现里统一按 `no_owner` 处理，持有与否要看写锁。
- 层 A（daemon）保留给终端 TUI 会话，协议公开、成本低，但不在当前主线。“让桌面 App 改走 daemon”的隐藏开关方案已放弃。
- 实现上必须处理：router 随进程生死动态转移（`ipc-connection-reset` 后重连并重发 `following`，必要时自己当 router）；revision 是 owner 进程内计数，owner 变化就重新拿 snapshot；方法版本表随 Codex 升级重新提取。

两层都已在本机验证握手：A 完成 `initialize` + `thread/loaded/list`；B 完成 `initialize`、`thread-owner-discovery`、following、snapshot/patch、start-turn（详见 3.5）。

## 1. 本机现状（已核实）

```text
pid 56923  ~/.codex/packages/app-server-daemon/releases/0.162.1-aarch64-apple-darwin/bin/codex
           app-server --listen unix:// --analytics-default-enabled --managed-daemon      ← 层 A daemon
pid 26188  codex app-server daemon pid-update-loop                                       ← daemon 自动更新循环
pid 20675  /Applications/ChatGPT.app  持有 ~/.codex/ipc/ipc.sock（它是层 B 的 router）
pid 21270  ChatGPT.app 子进程: codex -c features.code_mode_host=true app-server --analytics-default-enabled   ← 桌面自己的 stdio app-server
```

`~/.codex/` 相关文件：

- `app-server-control/app-server-control.sock`：符号链接，指向 `/private/tmp/codex-daemon-501/<sha256>`，真实 socket 权限 0600；`app-server-startup.lock` 启动锁。
- `app-server-daemon/`：`daemon.pid`、`daemon-updater.pid`（JSON，含进程身份摘要）、`settings.json`（可关自动更新）、`loaded-threads.json`（daemon 重启恢复用）、stderr 日志。
- `ipc/ipc.sock`：层 B 路由 socket，目录 0700、socket 0600，必须属于当前 uid。
- `codex app-server daemon version` 输出 JSON：`{"status":"running","backend":"pid","socketPath":...,"cliVersion":"0.162.0","appServerVersion":"0.162.1"}`。

注意：桌面 App 和 VS Code 插件**不走** daemon（各自 spawn stdio app-server），所以它们的会话在 `codex agents` 里看不到；反过来 TUI 会话也不出现在桌面 App 的 IPC 里。桌面 App 只有在 `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` 时才改用 daemon（`ws://localhost/rpc`）。`codex exec` 始终是嵌入式 app-server，两层都看不到。

## 2. 层 A：共享 app-server daemon

### 2.1 传输与握手

- Unix socket 上做标准 WebSocket 升级：`GET / HTTP/1.1`、`Host: localhost`、`Upgrade: websocket`、`Connection: Upgrade`、`Sec-WebSocket-Key`、`Sec-WebSocket-Version: 13`。服务端只特判路径 `/daemon/shutdown`（受管 daemon 的关停通道），其余路径等价；TUI 与桌面用 `ws://localhost/rpc`（`app-server-client/src/remote.rs`），daemon 生命周期命令用 `/`。
- 响应头 `x-codex-websocket-max-unfragmented-message-bytes: 16777216`：单帧上限 16 MiB，客户端应据此拒发超大请求。
- 每个文本帧一条 JSON-RPC 2.0 消息（请求 / 响应 / 通知 / 服务端请求）。服务端请求（审批、`item/tool/requestUserInput`、MCP elicitation）带 `id`，客户端用同 id 回 `result`。
- 握手序列：`initialize` → 响应 `{userAgent, codexHome, platformFamily, platformOs}` → 客户端发通知 `initialized`。`initialize` 参数：

```json
{"clientInfo":{"name":"<client-name>","title":"...","version":"..."},
 "capabilities":{"experimentalApi":true,"optOutNotificationMethods":["item/agentMessage/delta"]}}
```

- **originator 先到先得**：daemon 进程第一个 `initialize` 的 `clientInfo.name` 会成为进程级 originator（写进 rollout、UA、上报），之后的连接改不了（`set_default_originator` 返回 `AlreadyInitialized`）。只有 `codex_app_server_daemon`、`codex-backend` 两个名字不会抢 originator（`NON_ORIGINATING_CLIENT_NAMES`）。TUI 用 `codex-tui` 并开 `experimentalApi: true`。**如果我们的 runtime 可能是第一个连上（甚至是启动 daemon 的那一方），要么接受我们的名字成为 originator，要么用非 originating 名字。**
- `clientInfo.name` 必须是合法 HTTP header 值。本机验证 UA：`agents-anywhere-probe/0.162.1 (Mac OS 27.0.1; arm64) Apple_Terminal/488 (agents-anywhere-probe; 0.0.1)`。
- 实验性通知（`#[experimental]`）只发给 `experimentalApi: true` 的连接；`optOutNotificationMethods` 可按连接屏蔽 delta 类噪音。

### 2.2 TUI 什么时候挂到 daemon

`codex-rs/tui/src/lib.rs::app_server_target_for_launch` + `daemon_startup.rs::exclusion`：

- 默认（feature `daemon_auto_start` 已 Stable 且默认开）：探测控制 socket，能连上就 `LocalDaemon { allow_embedded_fallback: true }`，连不上就 embedded。连上但 `initialize` 失败也回落 embedded。
- 以下情况**不走 daemon**（会话对外不可见）：`--no-daemon`、`--oss`、`--profile`、`--strict-config`、`--dangerously-bypass-hook-trust`、workload identity、设置了 `CODEX_EXEC_SERVER_URL`、以及除少数白名单外的任何 `-c`/`--enable`/`--disable` 覆盖。`--remote <addr>` 则是显式远端，失败不回落。
- daemon 继承**启动它的那个进程**的环境变量；新终端里改环境不影响 daemon 内运行的命令。

### 2.3 连接可见性与订阅模型（app-server 源码）

- `OutgoingEnvelope::Broadcast` 发给**所有已 initialize 的连接**（`app-server/src/transport.rs::route_outgoing_envelope`），只按 opt-out 和 experimental 过滤。属于这一类的有：`thread/started`、`thread/closed`、`thread/status/changed`、`thread/archived`、`account/rateLimits/updated`、`remoteControl/status/changed` 等。
- 线程内事件（`turn/*`、`item/*`、`thread/tokenUsage/updated`、审批等服务端请求）只发给**订阅了该线程的连接**。订阅在 `thread/start`、`thread/resume`、`thread/fork` 成功时建立（`thread_state.rs::try_ensure_connection_subscribed`），`thread/unsubscribe` 或断连解除。
- 对**已加载**线程再发 `thread/resume`（`thread_processor.rs::resume_running_thread`）= 以订阅者身份加入，不会重新加载；传入的 model/sandbox 等覆盖会被忽略并打 warn（除非该线程空闲且无其他订阅者，这时会被卸载重建）。尚未产生第一轮的新线程在 rollout 落盘前 resume 会失败。`thread/resume` 建议带 `excludeTurns: true`，历史用 `thread/turns/list` / `thread/items/list` 分页拉。
- 新订阅者会收到**未决服务端请求的回放**（`outgoing_message.rs::replay_requests_to_connection_for_thread`），所以后加入者能看到并回复正在等待的审批；任意一个连接的回复即为最终决定（Ember 实测 TUI 和旁观者都可以回）。被动观察者绝不能自动回复。
- 有订阅者时线程不会被卸载；TUI 退出后约 60 s 发 `thread/closed`。建议 active 时订阅、idle 时 `thread/unsubscribe`。
- 线程状态 `ThreadStatus`：`notLoaded | idle | systemError | active{activeFlags:[waitingOnApproval|waitingOnUserInput]}`。
- 每轮会生成 `ephemeral: true` 的辅助线程和子 Agent 线程（`source.subAgent.thread_spawn.parent_thread_id`），列表时要过滤或归并到父线程。
- 经 daemon 跑的 TUI 线程 `source` 可能显示为 `vscode`，不要按 source 判断“这是不是终端会话”。

### 2.4 发现与控制的方法集

| 目的 | 方法 | 备注 |
| --- | --- | --- |
| 当前加载的线程 id | `thread/loaded/list {cursor?, limit?}` → `{data:[id], nextCursor}` | 只有 id |
| 线程元数据 | `thread/read {threadId, includeTurns:false}` | cwd、status、source、originator、ephemeral、model、name |
| 历史线程 | `thread/list {limit, cursor, ...}` / `thread/search` | 含未加载 |
| 加入/订阅 | `thread/resume {threadId, excludeTurns:true}` | 已加载时仅订阅 |
| 退订 | `thread/unsubscribe {threadId}` → `notLoaded|notSubscribed|unsubscribed` | |
| 发消息 | `turn/start {threadId, input:[{type:"text",text}], ...}` | 排队语义靠客户端：等上一轮完成再发 |
| 追加引导 | `turn/steer {threadId, expectedTurnId, input}` | |
| 中断 | `turn/interrupt {threadId, turnId}` | |
| 审批 | 回复服务端请求 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput`、`mcpServer/elicitation/request` | 回放给后加入者 |
| 其它 | `thread/compact/start`、`thread/archive`、`thread/name/set`、`review/start`、`model/list` | |

协议类型可用 `codex app-server generate-json-schema` / `generate-ts` 按版本固化。

### 2.5 daemon 生命周期带来的约束

- 受管 daemon 启动 5 分钟后、之后每小时跑一次安装器检查更新，**更新会重启 daemon 并中断进行中的工作**；挂在上面的 TUI 会直接退出。`~/.codex/app-server-daemon/settings.json` 的 `updater.autoUpdateEnabled=false` 可关闭。
- daemon 被杀后没有人自动拉起，下一次 `codex`（TUI）或 `codex app-server daemon start` 才会重启；重启后按 `loaded-threads.json` 恢复线程。
- 优雅关停期间新请求返回 `-32600 {"reason":"serverShuttingDown"}`；线程正在卸载时 `thread/resume` 返回 “is closing; retry”。
- 上游 README 明确 daemon “experimental，lifecycle contract may change”。

### 2.6 本机探针结果

```text
control socket: ~/.codex/app-server-control/app-server-control.sock -> /private/tmp/codex-daemon-501/41d7…
websocket upgraded; x-codex-websocket-max-unfragmented-message-bytes: 16777216
initialize -> {"userAgent": "agents-anywhere-probe/0.162.1 (...)", "codexHome": "/Users/t4wefan/.codex", ...}
  <- notify remoteControl/status/changed
thread/loaded/list -> 0 loaded thread(s)        （探针运行时没有 TUI 在跑）
```

## 3. 层 B：IDE / 桌面 IpcRouter

来源：VS Code 插件 `out/extension.js`（`IpcRouterManager` / `IpcRouter` / `IpcClient`）与 ChatGPT.app `app.asar` 内 `src-*.js`、`main-*.js`；两边是同一套代码。

### 3.1 socket 与路由选举

- 路径：`$CODEX_HOME/ipc/ipc.sock`；目录必须存在、0700、属于当前 uid，否则抛 “Codex IPC directory is not owned by the current user”。监听后 socket chmod 0600。旧版本回退路径 `$TMPDIR/codex-ipc/ipc-<uid>.sock` 只在能连上且属主校验通过时使用。Windows 用命名管道 `\\.\pipe\codex-ipc`。
- 每个进程启动时 `getOrStartRouterEndpoint()`：先尝试连接；连得上就只做 client；连不上则 unlink 自己 uid 的旧 socket、`net.createServer().listen(path)` 成为 router（日志 “I am the router”）；`EADDRINUSE` 表示别人抢到了。router 进程自己也会作为普通 client 连进来。
- 任何 client 断线后 1 s 自动重连，并在本地发 `ipc-connection-reset`；router 死掉时所有 pending 请求收到 `server-closed`。

### 3.2 帧与消息封装

帧 = `uint32 LE 长度` + UTF-8 JSON（单帧上限 256 MiB，0 长度非法）。消息 `type` 五种：

| type | 字段 | 说明 |
| --- | --- | --- |
| `request` | `requestId`(uuid), `sourceClientId`, `version`, `method`, `params`, `targetClientId?`, `hostId?`, `timeoutMs?` | `method=="initialize"` 由 router 自己处理，其余转发给某个 client |
| `response` | `requestId`, `resultType: "success"\|"error"`, 成功时 `method`, `handledByClientId`, `result`；失败时 `error`(字符串) | 错误字符串：`no-client-found`、`client-not-found`、`client-disconnected`、`request-timeout`、`server-closed`、`request-version-mismatch`、`no-handler-for-request`、或 handler 抛出的 message |
| `broadcast` | `method`, `sourceClientId`, `version`, `params`, `targetClientIds?` | router 转发给除发送者外的所有（或指定的）client |
| `client-discovery-request` | `requestId`, `request`(原 request) | router → client：你能处理这个请求吗 |
| `client-discovery-response` | `requestId`, `response: {canHandle: bool}` | client → router |

- `initialize`：`{"type":"request","method":"initialize","params":{"clientType":"vscode"|"desktop"},"sourceClientId":"initializing-client","version":0}` → `result: {clientId}`。router 随后向其他 client 广播 `client-status-changed {clientId, clientType, status:"connected"|"disconnected"}`；本地还会合成一条 `isSelf: true` 的 connected 事件。
- 请求路由：有 `targetClientId` 就先向该 client 发 discovery 确认 `canHandle`，再转发；没有则并行向所有其他 client 发 discovery，取第一个 `canHandle: true` 的（`Promise.any`），都不行则 `no-client-found`。discovery 超时 10 s；转发请求超时 `timeoutMs ?? 10000`；client 自己默认等 5 s。
- 版本协商：每个方法有整数版本（见下表），接收方 `version != 期望` 时拒绝（`request-version-mismatch` / 丢弃广播）。规则：`thread-follower-*` 带非空 `hostId` 时版本 +1；`thread-follower-interrupt-turn` 没有 `expectedTurnId` 时固定 3（否则 4）。未列出的方法版本为 0。

```text
thread-stream-state-changed 11   thread-stream-following-changed 1   thread-stream-following-status-requested 1
ipc-connection-reset 1           thread-read-state-changed 3         thread-archived 2   thread-unarchived 1
thread-owner-discovery 1         thread-follower-start-turn 2        thread-follower-load-complete-history 1
thread-follower-compact-thread 1 thread-follower-steer-turn 1        thread-follower-interrupt-turn 4
thread-follower-update-thread-settings 2   thread-follower-update-daybreak 1   thread-follower-read-model-settings 1
thread-follower-edit-last-user-turn 2      thread-follower-command-approval-decision 1
thread-follower-file-approval-decision 1   thread-follower-permissions-request-approval-response 1
thread-follower-submit-user-input 1        thread-follower-submit-mcp-server-elicitation-response 1
thread-follower-set-queued-follow-ups-state 1  thread-follower-remove-queued-message 1
thread-follower-clear-queued-messages 1    thread-queued-followups-changed 2
```

### 3.3 Owner / Follower 协议（接管的核心）

每个会话（`conversationId` = app-server threadId，配 `hostId`，本机为 `"local"`，远端 SSH/WSL/remote-control 环境有各自 id）在任意时刻只有**一个 owner**：把该线程加载进自己 app-server 的那个窗口/进程。其他窗口都是 follower。

1. **找 owner**：请求 `thread-owner-discovery {hostId, conversationId}`。owner 的 discovery handler 只在 `hostId` 匹配且自己确实持有该线程时答 `canHandle: true`；响应 `handledByClientId` 即 owner 的 clientId，`result: {supportsUntrustedAppInput: true}`。返回 `no-client-found` 表示没人持有，调用方应**自己 `thread/resume` 成为 owner**（桌面叫 `resumeConversationForUnavailableOwner`）。
2. **开始跟随**：广播 `thread-stream-following-changed {conversationId, hostId, following: true}`。owner 把发送者加入 follower 集合，然后向该 follower 定向广播（`targetClientIds`）一条 `thread-stream-state-changed`：

   ```json
   {"conversationId":"…","hostId":"local",
    "change":{"type":"snapshot","revision":N,"conversationState":{…完整会话 UI 状态…}}}
   ```

   之后 owner 每次状态变化都广播 `change:{type:"patches", baseRevision, revision, patches:[JSON Patch…], acceptedTextChanges?}`。follower 只在 `baseRevision == 自己当前 revision` 且来源是当前 owner 时应用，否则丢弃（等下一次 snapshot）。`revision` 严格递增；需要“至少到某版本”时 follower 等待（`waitForConversationRevision`）。
3. **保持一致**：owner（重）连接或收到 `client-status-changed connected` 时广播 `thread-stream-following-status-requested {conversationId, hostId}`，所有正在跟随的 follower 重新发 `following: true`。follower 断开则 owner 从集合移除；owner 断开则 follower 标记 “needs resume”，再次发请求时若得到 `no-client-found` 就自己 resume 接管。
4. **操控**：follower 对线程的所有写操作都变成请求 `thread-follower-*`，`targetClientId` = owner。owner 收到后调用自己的 app-server，然后把结果返回。参数几乎就是 app-server 的参数包一层：

   | 请求 | params | owner 侧动作 / result |
   | --- | --- | --- |
   | `thread-follower-start-turn` | `{conversationId, turnStart:{request:<TurnStartParams>, context:{…UI 上下文…}}}` | `turn/start` → `{result}` |
   | `thread-follower-steer-turn` | `{conversationId, input, restoreMessage?, serviceTier?, attachments?, clientUserMessageId?, additionalContext?, toolOutput?}` | `turn/steer` → `{result}` |
   | `thread-follower-interrupt-turn` | `{conversationId, mode:"user-stop"\|…, expectedTurnId?}` | `turn/interrupt` → `{interruptedTurnId, ok}` |
   | `thread-follower-command-approval-decision` | `{conversationId, requestId, decision}` | 回复 `item/commandExecution/requestApproval` → `{ok}` |
   | `thread-follower-file-approval-decision` | `{conversationId, requestId, decision}` | 回复 `item/fileChange/requestApproval` |
   | `thread-follower-permissions-request-approval-response` | `{conversationId, requestId, response}` | 回复 `item/permissions/requestApproval` |
   | `thread-follower-submit-user-input` | `{conversationId, requestId, response}` | 回复 `item/tool/requestUserInput` |
   | `thread-follower-submit-mcp-server-elicitation-response` | `{conversationId, requestId, response}` | 回复 MCP elicitation |
   | `thread-follower-compact-thread` | `{conversationId}` | `thread/compact/start` |
   | `thread-follower-edit-last-user-turn` | `{conversationId, …}` | 回滚并重发 |
   | `thread-follower-load-complete-history` | `{conversationId}` | owner 拉全量历史后广播新 snapshot → `{revision}`（超时 5 min） |
   | `thread-follower-read-model-settings` | `{conversationId}` | `{settings:{model, reasoningEffort, daybreakEnabled, resumeState, mode, threadSource, modelProvider}}` |
   | `thread-follower-update-thread-settings` | `{conversationId, threadSettings, condition?, activeTurnId?}` | `{applied}` |
   | `thread-follower-set-queued-follow-ups-state` / `remove-queued-message` / `clear-queued-messages` | 排队消息 | `{ok}` |

   `thread-follower-start-turn` 若带 `context.responseItems`（不可信外部输入），follower 会先再做一次定向 owner-discovery 确认 `supportsUntrustedAppInput`。

5. **其它广播**：`thread-archived` / `thread-unarchived`、`thread-queued-followups-changed`、`thread-read-state-changed`（带 `context`）、`query-cache-invalidate`、`app-connect-oauth-callback-received`；桌面还会向 VS Code client 发请求 `ide-context {workspaceRoot}`。

### 3.4 需要特别注意的点

- `conversationState` 是桌面/插件**内部 UI 状态模型**（turns、turnHistory、requests、resumeState、cwd、model…），不是 app-server 协议的一部分，`thread-stream-state-changed` 已经改到版本 11，跨版本变化没有兼容承诺。复刻时只消费少量稳定字段（状态、pending requests、cwd、model），其余仍以 app-server 事件/历史为准。
- 两层是**互斥**的可见范围：桌面/VS Code 的线程只在层 B 里；TUI 的线程只在层 A 里。如果某个线程两边都没人持有，谁 `thread/resume` 谁成为 owner；**不要**在未做 owner-discovery 前直接 resume 一个可能正被桌面持有的线程，否则会在两个 app-server 里各加载一份（两份进程、两份 rollout 写入）。
- IPC router 是“哪个窗口先起谁当 router”，router 进程退出会让所有 client 重连并重新广播跟随状态。我们的 client 必须实现重连 + `ipc-connection-reset` 后重发 `following`。
- 版本不匹配是静默丢弃/拒绝，升级 Codex 后要先核对版本表（可从插件 `extension.js` 的方法版本表或桌面 bundle 中重新提取）。
- 以 `clientType: "vscode"` 自报可能让桌面向我们发 `ide-context` 等请求；用自己的 clientType（如 `agents-anywhere`）时未知类型会被忽略，本机验证可以正常注册。

### 3.5 本机探针结果（2026-10-10 下午补测，桌面 App 已打开会话）

- 桌面 app-server（pid 21270）确实加载了用户打开的线程：`lsof` 可见对应 rollout 与 `~/.codex/thread-writer-locks/<threadId>.lock`。
- 对该线程做 `thread-owner-discovery`（`hostId: "local"` 与不带 hostId 两种）均在 **10.00 s** 后返回 `no-client-found`。10 s 正好是 router 的 discovery 超时，说明桌面至少有一个 IPC client 对 discovery **不应答**（应答 false 会立刻返回）。
- 用两个探针 client 复现：A 答 false 时 B 仍等满 10 s 才得到 `no-client-found`；A 答 true 时 B 0.00 s 拿到 A。证明 router 本身正常，挂住的是桌面侧 client。
- 绕过 discovery 直接向所有 client 广播 `thread-stream-following-changed {following:true}`，15 s 内没有收到 snapshot。
- 桌面日志（`~/Library/Logs/com.openai.codex/`）只记录每次连接的 “I am the router” 和探针断开时的 EPIPE，没有 “no handler” / “no socket” 警告。
- 代码层面：打包版 `runAppServerManagerInMain` 固定为 false，所以每个窗口的 IPC client 都会注册 owner 处理器；但线程 ownership 登记（`setThreadOwnership`）挂在主进程 host manager 的 client 上，窗口 client 的 discovery 要回退到 webview 的 `getThreadRole`。本次观测与“这条回退链在当前版本上不工作”一致，但根因没有定位。

**修正（同日 17:00）：桌面 App 重启后，同样的 discovery 0.01 s 即返回桌面窗口 client，follow 后收到 188 KB 的 v11 snapshot（rev 258）。之前的失败是旧桌面实例（pid 20675）里有一个 IPC client 挂死不应答，不是版本限制；VS Code 当时同样发现不了 owner，只能退回 `thread/resume` 并撞上写锁。实现上必须把“discovery 超时”当成“持有者存在但不可达”处理（结合写锁判断），而不是当成无人持有去 resume。**

VS Code 插件日志还原的完整时间线（线程 `01a124e5`，桌面持有中）：16:33:21 打开 → IPC 找不到 owner（`previousStreamRole=null`）→ 退回 `thread/resume` → `already has an active writer`；16:38:13 再试仍失败；16:38:17 收到 `ipc-connection-reset`（桌面进程退出，写锁随之释放）→ 16:38:18 VS Code 自己当选 router → 16:38:19 `thread/resume` 成功，`thread_stream_role_changed role=owner`；随后新的桌面实例以 client 身份连到 VS Code 的 router 上。说明插件在“被占用”时确实先走了 IPC，是旧桌面实例不应答才落到写锁冲突；router 角色会随进程生死动态转移。

桌面/VS Code 应答 discovery 的条件（来自 `KZ`/`a4e` 代码）：请求 `hostId` 等于该窗口的 host（本机 `local`）；该窗口的 app-server 真的加载了线程（拿到写锁、stream role 为 owner，并通过 `setThreadOwnership` 登记），或 webview 的 `getThreadRole` 在超时内返回 owner；方法版本匹配；窗口的 app view 已就绪并注册了处理器。不满足时会**立刻**回 `canHandle: false`。

#### VS Code 正向验证（同日 16:40 之后，线程由 VS Code 持有）

前提：同一线程不能同时被两个 app-server 加载。VS Code 打开桌面正持有的线程时，插件日志报 `thread … already has an active writer`（`rollout/src/writer_lock.rs` 的排他 flock），VS Code 退化为只跟随不持有。桌面关闭该线程后，VS Code 才拿到写锁成为 owner。此时：

- `thread-owner-discovery` **毫秒级**返回 VS Code 的 clientId，`result: {supportsUntrustedAppInput: true}`。
- 定向广播 `following: true` 后立刻收到 `thread-stream-state-changed` v11 snapshot（约 5 KB）。
- 在 VS Code 里跑一轮，收到连续的 patches（rev 3→22，21 条消息，`add` 14 / `replace` 28），中途 owner 会主动重发 snapshot（本次 rev 8、rev 23），follower 以 snapshot 的 revision 为新基线。
- 其它随之而来的广播：`query-cache-invalidate`、`thread-queued-followups-changed`、`thread-read-state-changed`；桌面还会用 `ide-context` discovery 找 VS Code。

**`conversationState`（v11）已验证的结构**：

| 字段 | 含义 |
| --- | --- |
| `threadRuntimeStatus` | `{type:"idle"}` / `{type:"active", activeFlags:[…]}`，与 app-server `ThreadStatus` 同形 |
| `requests` | 待处理的服务端请求（审批、用户输入）数组；回复时用其中的 requestId 走 `thread-follower-*-decision` |
| `currentPermissions` / `latestThreadSettings` | approvalPolicy、sandboxPolicy、permission profile、model、effort、cwd |
| `latestModel`、`latestReasoningEffort`、`latestCollaborationMode`、`latestTokenUsageInfo` | 当前选择与用量 |
| `cwd`、`rolloutPath`、`sessionId`、`title`、`source`、`originator`、`createdAt`、`updatedAt`、`hasUnreadTurn` | 元数据 |
| `turnHistory.history.islands[]` | 有序的 turn 键列表（`entries[].key`） |
| `turnHistory.history.entitiesByKey[key]` | 每个 turn：`params`（原始 `turn/start` 参数）、`turnId`、`status`、`durationMs`、`items[]`（`userMessage`、`agentMessage` 等，字段与 app-server item 一致）、`completedItemIds` |
| `turns` | 旧字段，paginated 模式下为空，内容以 `turnHistory` 为准 |

**patch 语义**：JSON Patch（`add`/`replace`，`path` 是数组）。一轮的生命周期是：`add entitiesByKey/<turnKey>` + `islands/0/entries` 追加 → `threadRuntimeStatus` 变 active → `items` 逐个 `add` → 助手文本每次增量都是一条 `replace …/items/N/text`（携带**全文**），同一条消息的 `acceptedTextChanges` 另给出增量（`{key:{threadId, entityKey, itemId}, target:{field:"text"}, edits:[{at, deleteCount, insert}]}`），二者任选其一消费 → `reasoning` item 先以空 `summary` 出现再被 replace→ `completedItemIds` → `latestTokenUsageInfo` → `threadRuntimeStatus` 回 idle → `hasUnreadTurn`。新 turn 在拿到服务端 turnId 前用本地键 `tail:0:local:<uuid>`，随后 `replace …/turnId`。

录制脚本：[devtools/codex-ipc/ipc_stream_recorder.py](../devtools/codex-ipc/ipc_stream_recorder.py)；原始数据在 `/tmp/codex-ipc-dumps/`。

#### 控制方向已验证：`thread-follower-start-turn`

用 [devtools/codex-ipc/ipc_start_turn_probe.py](../devtools/codex-ipc/ipc_start_turn_probe.py) 向 VS Code owner 发了一条真实消息：请求 0.07 s 返回 `turn/start` 的原样响应（`{result:{turn:{id, status:"inProgress", …}}}`），随后 patch 流里出现 `agentMessage`，助手回复“收到”，状态回到 idle。owner 会把 patch 同时发给所有 follower（本次两个探针 client 都收到了）。

生效的请求格式（`version: 2`，本机 `hostId` 不填，`targetClientId` = owner）：

```json
{"conversationId": "<threadId>",
 "turnStart": {
   "request": {
     "threadId": "<threadId>", "turnTrigger": "composer",
     "responsesapiClientMetadata": {"source": "codex", "client_type": "extension"},
     "clientUserMessageId": "<uuid>",
     "input": [{"type": "text", "text": "...", "text_elements": []}],
     "cwd": "<snapshot.cwd>", "model": null, "effort": null,
     "multiAgentMode": "explicitRequestOnly", "serviceTier": null,
     "collaborationMode": "<snapshot.latestCollaborationMode>",
     "approvalPolicy": "<snapshot.currentPermissions.approvalPolicy>",
     "approvalsReviewer": "user", "sandboxPolicy": "<snapshot.currentPermissions.sandboxPolicy>",
     "permissions": null, "runtimeWorkspaceRoots": null, "summary": "none",
     "personality": null, "outputSchema": null, "attachments": [], "commentAttachments": [],
     "useAppServerPermissionDefault": true},
   "context": {"inheritThreadSettings": true}}}
```

`request` 就是 app-server 的 `TurnStartParams` 加上 VS Code 扩展的几个附加字段；`threadId` 必须等于 `conversationId`，否则 owner 侧直接抛错。模型、权限等直接从 snapshot 里取，保证和 owner 当前设置一致。`context` 给最小集合即可；`responseItems` 一旦非空，owner 会额外做一次“不可信输入”的所有权确认。

原始探针输出：


```text
ipc router socket: ~/.codex/ipc/ipc.sock
initialize -> {"type":"response","resultType":"success","method":"initialize","result":{"clientId":"38a941bc-…"}}
  owner of 01a123db-a38a-7a40-9c40-36b5a5794ffb: no-client-found      （6 个最近线程均无 owner：桌面当前没有打开/运行它们）
```

## 3.6 层 B 的可用范围（修订）

| 目标 | 层 B 现状 |
| --- | --- |
| VS Code 插件里的线程 | **已验证可用**：discovery、following、snapshot、patch 流全部正常 |
| 桌面 App 里的线程 | **已验证可用**（桌面重启后）：discovery 0.01 s、snapshot 正常；需防御旧实例 IPC client 挂死导致的 10 s 超时 |
| 终端 TUI 线程 | 不经过层 B，只在层 A |

持有关系的权威判据是 `~/.codex/thread-writer-locks/<id>.lock` 的 flock 持有进程（`lsof` 可查）：有人持有且 discovery 能找到 owner → follower 模式；有人持有但 discovery 超时 → 持有者不可达，只读等待；无人持有 → 可用自家 app-server `thread/resume` 独占接管。

## 4. 在 CodexRuntime 里复刻

### 4.1 目标形态

Connector 的 Codex runtime 从“自己 spawn 一个 stdio app-server、只看得到自己创建的线程”变成一个**多来源 attach 的客户端**：

```text
CodexRuntime
 ├─ DaemonAttachment   ── WS over UDS ──▶ 共享 daemon（TUI / codex agents / 其它 daemon 客户端的线程）
 ├─ IpcFollowerAttachment ── 长度前缀帧 ──▶ ipc.sock router ──▶ 桌面 App / VS Code owner
 └─ EmbeddedAttachment ── stdio ──▶ 自己 spawn 的 app-server（现有路径，兜底；或改为 daemon 不可用时的 fallback）
```

每个会话在 `SessionMeta.metadata` 里带 `attachment: daemon | ipc | embedded` 与 `ownerClientId`（ipc 时），客户端按能力显示；Runtime 协议本身不需要新增 RPC。

### 4.2 模块切分（connector/connector/runtimes/codex/）

已落地（2026-10-10）：`ipc/` 包 —— `framing.py`（长度前缀帧）、`versions.py`（方法版本表）、`paths.py`（socket 路径与属主校验）、`router.py`（最小 router，无 IDE/桌面时自己监听）、`client.py`（asyncio `CodexIpcClient`：initialize、request/broadcast、discovery 应答、重连与 `ipc-connection-reset`）、`jsonpatch.py`（RFC 6902 子集）、`follower.py`（`ThreadFollower`：owner 发现、following、snapshot/patch 应用、revision 校验与 resync、owner 掉线 / 连接重置处理）、`candidates.py`（写锁文件 + `session_index.jsonl` 最近项）、`projection.py`（`CodexIpcSessionProjector`：投影为 SessionMeta / SessionState / 审批 Notice）、`service.py`（`CodexIpcService`：后台扫描、按其它窗口的 following 广播即时跟进）。`CodexRuntime.start()` 在 provider 开启 `ipc_enabled` 时后台连接并启动服务，`stop()` 停止。测试：`tests/test_codex_ipc.py`、`tests/test_codex_ipc_follower.py`。真机：服务启动后对桌面持有的线程立即拿到 snapshot 并投影。

待做：



- `sdk/transports/ws_unix.py`（层 A，后续）：Unix socket 上的最小 WebSocket 客户端，原型见 `daemon_probe.py`。
- `sessions/daemon_inventory.py`：`thread/loaded/list` + `thread/read` + 广播 `thread/started|closed|status/changed` 维护“daemon 上活着的线程”集合，过滤 `ephemeral` 与子 Agent 线程，归并到父线程。
- `sessions/ipc_followed_threads.py`：owner-discovery、following、snapshot/patch 应用（只提取稳定字段）、owner 断开处理。
- `turns/` 和 `notifications/` 复用：daemon 事件已经是 app-server 通知，走现有投影；ipc 路径把 `conversationState` 中的 pending requests / status 投影为 `SessionState` / `SessionNotice`，文本内容仍以 `thread/turns/list`（通过 daemon 或自己的 app-server 只读读取 rollout）为准。

### 4.3 分阶段

**P0 观察（只读，可直接做）**

1. 连接 `ipc.sock`（clientType `agents-anywhere`），连不上就自己 listen 当 router；对候选线程（`session_index.jsonl` 最近项 + `thread-writer-locks` 中被持有的 id）做 `thread-owner-discovery`：有 owner 的发 `following: true`，接收 snapshot/patches，投影状态、待审批与 Timeline；超时的标记为“持有者不可达”。
2. 处理 `client-status-changed`、`ipc-connection-reset`、owner 断开：重连后重发 `following`，owner 变化时丢弃旧 revision 重新拿 snapshot。
3. 无人持有的线程继续走现有的自家 app-server 路径（独占接管），接管前后用写锁持有者做校验。
4. （后续）探测 `app-server-control.sock`，把 daemon 上的 TUI 线程也纳入列表；失败不自动拉起 daemon。
5. 每一步都要能被桌面 App / VS Code / `codex agents` 的现象交叉验证。

**P1 控制**（已实现：`ipc/control.py` + `CodexRuntime` 分流，见 4.5）

1. daemon 线程：`turn/start` / `turn/steer` / `turn/interrupt` / 审批回复直接走 daemon 连接；排队语义用“等待上一轮 `turn/completed` 再 `turn/start`”实现（与 `codex queue` 一致）。
2. ipc 线程：相同操作改为 `thread-follower-*` 请求发给 owner；`turnStart.request` 就是 `TurnStartParams`，`context` 可以只给空对象起步；审批回复用 `thread-follower-*-approval-decision`。
3. 把两类线程的能力差异写进 `codex_session_capabilities`，前端按能力显示（例如 ipc 线程暂不支持模型切换时隐藏入口）。

**P2 生命周期与故障**

1. daemon 重启/更新：连接断开 → 指数退避重连 → 重新 `thread/loaded/list` → 对仍在的线程重新 `thread/resume`。线程 id 不变，Timeline 以 cursor 续传。
2. owner 消失：收到 `client-status-changed disconnected` 或请求返回 `no-client-found` → 标记 “needs resume”，由用户或策略决定是否由 Connector 自己 `thread/resume` 接管（接管后 Connector 就是 owner，桌面重开该线程时会先 discovery 到我们——所以 Connector 也要实现 owner 侧的 discovery/following 应答，否则桌面会以为没人持有而重复加载）。
3. 升级检测：启动时记录 `appServerVersion` 与 IPC 方法版本表，不匹配时降级为只读并上报。

### 4.5 实现状态（2026-10-10 晚）

已完成并通过 connector 全量测试（1095）与真机验证：

| 能力 | 实现 | 验证 |
| --- | --- | --- |
| 发现与跟随 | `CodexIpcService` 扫描写锁 + 最近会话，`ThreadFollower` 跟随有 owner 的线程 | 真机：桌面持有的线程 0 s 内 snapshot |
| 会话投影 | `CodexIpcSessionProjector`：SessionMeta、SessionState、审批 Notice、活动回合、`session_turn_ended` | 真机 + 单测 |
| Timeline | `ipc/timeline.py` 把 `turnHistory` 转成 `thread/read` 形状，复用 `CodexTimelineAccumulator`；snapshot 走 `timeline_sync`，patch 只 upsert 变化的 item | 真机：98 条 item 一次同步；`get_session_snapshot` 走 IPC 快照 |
| 发消息 / steer / 中断 | `CodexIpcTurnController` → `thread-follower-start-turn` / `steer-turn` / `interrupt-turn` | 单测（FakeOwner）+ 探针真机 start-turn |
| 审批 / 用户输入回复 | `thread-follower-*-approval-decision` / `permissions-request-approval-response` / `submit-user-input`，Notice 状态机与 SDK 路径一致 | 单测 |
| 能力声明 | `ipc_attached` 的会话视为已加载，send / interrupt / steer / approval 按状态开放 | 真机 + 单测 |
| Deeplink 交接 | `ipc/deeplink.py` + `CodexRuntime._ipc_handoff_to_desktop`：写锁被持有但无 owner 时让桌面 App 通过 `codex://threads/<id>` 打开线程，再跟随；`/open-in-codex-app` 命令按需触发 | 真机：deeplink 后桌面 0.1 s 内 resume 并应答 discovery；单测 |
| 分流规则 | `CodexRuntime` 对 `start_turn` / `steer_turn` / `interrupt_session` / `respond_interaction` / `get_session_snapshot`：线程被跟随且 owner 可达 → IPC；否则原有 app-server 路径（独占接管） | 单测 |
| **owner 侧（反向接管）** | `ipc/owner.py` `CodexIpcOwnerService`：对自家 app-server 持有的线程应答 discovery，用 `thread/read` + `thread/turns/list` 生成 v11 `conversationState` snapshot（状态变化与原生通知后节流重发，不发 patch），并代执行窗口的 `thread-follower-*`（start / steer / interrupt / 审批与用户输入回复 / load-complete-history / read-model-settings / compact） | 真机：真实 runtime 持有测试线程，模拟窗口 0 s 发现 owner、收到 rev 1→3 的 snapshot（running→idle，含双方消息）；单测 |

#### 模型 / 权限选择的双向同步（2026-10-10 晚补）

- **原生 SDK 路径之前读不到模型 selection 的根因**：`sessions/reader.py` 的 `thread_state_from_sdk_thread` 只保留了 `id` / `modelProvider` / `name`，把 SDK `Thread` 上的 `model` 和 `reasoning_effort` 丢掉了，于是 `model_selection_from_thread_state` 永远拿不到模型。`thread/read` 在线程创建后（0 轮对话）就带 `model` 与 `reasoningEffort`，所以**不需要等一轮**；修复后真机 `get_session_state` 立即返回模型 selection。权限在 app-server 的 `thread/read` 里不存在（`Thread` 没有审批/沙箱字段），原生路径只能依赖我们自己缓存的 selection。
- **窗口 → AA**：follower 投影把 `latestModel` / `latestReasoningEffort`（或 `latestThreadSettings`）和 `currentPermissions` 映射成 catalog selection（`projection.ipc_settings_state`），窗口里切换模型会随 `latestThreadSettings` patch 立即同步。权限目录里 `full_access` 没写 `approvalsReviewer`，而线程默认带 `user`，匹配规则已放宽为“默认 reviewer 可匹配未指定 reviewer 的目录项”。
- **AA → 窗口**：`update_session_selections` 对 IPC 挂载线程发 `thread-follower-update-thread-settings {conversationId, threadSettings, condition:null, activeTurnId:null}`，`threadSettings` 以 owner 的 `latestThreadSettings` 为底并覆盖 model / effort / approvalPolicy / approvalsReviewer / sandboxPolicy / permissions profile；真机对桌面 owner 发送后返回 `applied: true`。
- **connector 作为 owner**：snapshot 的 `latestModel` / `latestReasoningEffort` / `currentPermissions` / `latestThreadSettings` 由我们缓存的 selection 生成；窗口发来的 `update-thread-settings` 会映射回 selection 并通过 `update_session_selections` 应用。

已知限制：

- owner 侧的 snapshot 已用模拟窗口验证字段与流程，但还没有用真实 VS Code / 桌面窗口确认渲染效果；`conversationState` 是对方的私有模型，若某个版本要求额外字段，窗口可能显示不全。验证方法：让 connector 持有一个线程（从手机发一条消息），再在 VS Code 里打开它。
- 附件：IPC 路径与 SDK 路径一致，先经 host 下载到本机附件目录，图片以 `{type:"localImage", path}` 放进 `input`，其它文件在正文末尾追加 `[Attached file: …]` 引用；owner 侧收到窗口的 `localImage` 也会转成 SDK 附件。owner 的 app-server 与我们同机，读本地路径没有问题。
- 推给 owner 的 `threadSettings` 只能带 `sandboxPolicy` + `activePermissionProfile`，**不能**再带 profile 字段 `permissions`，否则 app-server 报 `permissions cannot be combined with sandboxPolicy`（真机踩过）。
- **接管竞态**：窗口刚打开线程时会先广播 `following`，稍后 resume 成功才登记 ownership；这时如果 AA 立刻发消息，discovery 还找不到 owner，原来会退回自家 app-server resume 并撞上写锁（真机报“该 Codex 会话正由其他进程持有写入权限”）。现在：(1) 对窗口广播过的线程，discovery 失败后 3 s 重试，最多 3 次；(2) 有写锁文件的线程 20 s 重探一次（无锁文件的仍是 5 min）；(3) `start_turn` / `steer_turn` / 选择更新在走 SDK 路径前，若该线程存在写锁文件，先做一次 3 s 上限的 owner 发现，找到就改走 IPC。
- **Deeplink 交接（2026-10-11）**：桌面 App 注册了 `codex://` scheme，`codex://threads/<thread-id>` 会让正在运行的 App 跳到该线程并 resume（真机 `open -g` 后约 0.1 s 出现 `maybe_resume_started`，随即登记 ownership、应答 discovery）。用途：写锁被桌面 app-server 持有、但没有任何窗口应答 discovery 的线程（上面竞态里“AA 尚未接管”的情形），`_ipc_attach_for_write` 在 3 s 探测失败后，如果检测到桌面 App 进程在运行（macOS 看 `ChatGPT.app/Contents/MacOS/ChatGPT` 或 `Codex.app/Contents/MacOS/Codex` 主进程），就打开 deeplink，再用 5 s 上限做一次 discovery，成功即改走 IPC；App 没在运行或平台无法判断时不触发，避免把 App 拉起来。实现见 `ipc/deeplink.py` 与 `CodexRuntime._ipc_handoff_to_desktop`，可用 `ipc_deeplink_handoff=False` 关闭。同一能力也作为会话命令 `/open-in-codex-app`（别名 `open-in-codex`、`codex-app`）暴露，任何状态下可用，返回 `{deeplink, attached, ownerClientId}`；App 未运行时返回 `codex_app_not_running`。其它已见过的 deeplink 形式：`codex://threads/<id>?ephemeral`、`?artifact`、`codex://shared-thread/<id>`、`codex://review?pr=`、`codex://settings/connections`、`codex://plugins/`。注意 deeplink 走的是 `open`，平台差异：macOS `open -g`（不抢焦点）、Linux `xdg-open`、Windows `os.startfile`。
- 权限对象必须和桌面自己生成的一模一样（webview `app-shared` 里的 `aM` / `iM` / `rvt`），否则桌面线程页会被 React error boundary 打崩（真机报 `TypeError: e is not iterable`，刷新后恢复）：profile id 只有 `:read-only`、`:workspace`、`:danger-full-access`；read-only 的 `sandboxPolicy` 是 `{type:"readOnly", networkAccess:false}`；workspace-write 必须带 `writableRoots`（= `runtimeWorkspaceRoots`，缺了就是上面那个崩溃）、`excludeSlashTmp`、`excludeTmpdirEnvVar`、`networkAccess`，并同时给 `runtimeWorkspaceRoots`；full access 是 `{type:"dangerFullAccess"}` + `approvalPolicy: never`。实现见 `ipc/control.py::permission_block`，owner 侧共用。
- `requests` 里的用户输入（`item/tool/requestUserInput`）尚无真机样本，投影只处理审批类请求；回复路径已实现。
- 桌面 / VS Code 只对自己持有的线程应答 discovery，其余线程统一报 `no-client-found`（约 10 s），扫描间隔 30 s、失败重试 5 min；新窗口 following 广播会触发即时跟进。
- Windows 已支持（2026-10-12），见下文「Windows 适配与真机修复」。

#### 配置开关、kill-chatgpt 与扫描策略（2026-10-11）

- **配置开关**：Codex Runtime 配置新增 `ipcEnabled`（默认开）与 `ipcDeeplinkHandoff`（默认开，仅 IPC 开启时生效），schema revision 升到 8，i18n key 为 `dashboard.device.runtimeConfigFields.ipcEnabled.*` / `ipcDeeplinkHandoff.*`（Web / Desktop / iOS 已加文案，Android 读 schema 的 `title`）。`ipcEnabled=false` 时 Runtime 不连 IPC 路由、不跟随任何窗口、也不作为 owner 应答，所有线程走自家 app-server。
- **`/kill-chatgpt` 命令**（别名 `kill-codex-app`、`quit-chatgpt`）：找到桌面 App 主进程（macOS 为 `ChatGPT.app/Contents/MacOS/ChatGPT` 或 `Codex.app/Contents/MacOS/Codex`），先 SIGTERM，5 s 后仍存活则 SIGKILL；App 退出后它持有的所有写锁随之释放，当前线程若正被跟随会立即 unfollow，下一条消息直接走自家 app-server。这个命令不依赖 IPC 开关，目的是在 IPC 关闭或 App 不可达时也能把线程"抢"回来。实现见 `ipc/desktop_app.py`，结果里带 `terminated` / `killed` / `survivors` 三组 pid。
- **写锁判定改用 flock**：Codex 的 `thread-writer-locks/<id>.lock` 文件在持有者退出后并不会删除，所以"文件存在"不等于"被持有"。`CodexIpcService.thread_is_held` 现在对文件做一次非阻塞 `flock(LOCK_EX|LOCK_NB)`：拿不到就是真的被持有，拿到了立即释放并视为空闲。这样 kill 掉 App 后不会再为残留的锁文件白做 3 s 探测。
- **不再定期扫描**：`CodexIpcService` 默认 `scan_interval=None`，只在启动（IPC 连上）时扫描一次写锁目录与最近会话；之后只由事件触发重探：窗口广播 `thread-stream-following-changed`、新客户端 `client-status-changed: connected`、announce 重试（3 s × 3），以及写前 `_ipc_attach_for_write` 的按需探测。需要周期扫描时可显式传 `scan_interval`。

#### Windows 适配与真机修复（2026-10-12）

依据：Windows 11、Codex App 26.1007.2314.0（内置 codex-cli 0.162.0-alpha.17.2）真机，AA Web 用 Playwright 操作，App 侧用 `codex://threads/<id>?prompt=` 预填后按回车。

Windows 适配：

- 路由是命名管道 `\\.\pipe\codex-ipc`。`pathlib` 会把它改写成 `\pipe\codex-ipc`，所以连接时直接用字符串常量 `WINDOWS_PIPE_PATH`，不经过 `Path`。
- Windows 上 Connector **不当 router**：`IpcRouter` 只有 Unix socket 实现，命名管道服务端还没写、也没验证，所以等 App 或 VS Code 来当 router。选举本身是可行的：libuv 和 CPython asyncio 创建第一个管道实例时都带 `FILE_FLAG_FIRST_PIPE_INSTANCE`，第二个监听者会像 socket 的 `EADDRINUSE` 一样失败，不会出现两个 router。另外 Windows 上能不能启用 IPC 取决于事件循环而不是平台：`create_pipe_connection` 只有 `ProactorEventLoop` 才有（Windows 默认），`CodexIpcClient.start()` 据此判断，不满足就记日志并禁用。
- 没有 uid 和 IPC 目录，`ensure_ipc_directory` 在 win32 直接返回（原实现调用 `os.getuid()` 会抛错）。
- App 进程识别：主进程是 `...\WindowsApps\OpenAI.Codex_<version>_x64__<publisher>\app\ChatGPT.exe`，按包名 `OpenAI.Codex_` 匹配，不会误认同名的 ChatGPT 桌面版；Windows 没有 `ps`，改用 psutil。
- 写锁判定用 `msvcrt.locking` 非阻塞字节锁代替 `flock`。实测 Windows 上 Codex 释放写锁时会删除锁文件。

真机验收中发现并修复的问题：

- **App 往 Connector 持有的线程发消息被吞、一直转圈**：窗口作为 follower 发消息时不会请求 `thread-follower-start-turn`，而是把整个排队交给 owner（`thread-follower-set-queued-follow-ups-state`，`state[conversationId]` 是消息列表），由 owner 在空闲时取出执行（App 自身的 owner 实现是 `turnCoordinator.acceptFromFollower`）。原实现对这个请求只回 `{"ok": true}`。现在 owner 保存排队、广播 `thread-queued-followups-changed`（`{conversationId, hostId, messages}`），线程空闲时取第一条用 `clientUserMessageId = message.id` 开始一轮，回合结束后继续下一条；`remove-queued-message` / `clear-queued-messages` 按 App 的返回格式处理。附件目前只取文字。
- **Connector 重启后往 AA 创建的会话发消息报 502** `connector returned sessionId that does not match the session binding`：投影在缓存里没有绑定时用派生 id（`stable_session_id`）发布状态，Server 读状态时按 externalSessionId 命中派生 id。现在投影优先用缓存里 Server 绑定的 id；读状态时若缓存是派生 id、调用方给的是绑定 id，就把缓存重新绑定。
- **App 回 `thread-follower-start-turn-timeout` 时会话被标成 error**：App 自己的 turn start 超过约 5 s 时会回这个错误，但回合照样开始。现在 `-timeout` 结尾或无响应按结果未知处理，在 owner 状态流里等新回合（最多 20 s），等到即成功，等不到返回 `codex_ipc_start_turn_outcome_unknown`，不重发也不标 error。
- **启动后 App 新建的线程只能靠轮询看到，重启 Connector 才实时跟随**：启动扫描之后，`thread-stream-following-status-requested` 只给已跟随的线程重发 following。现在收到这条广播且线程未跟随时立即探测（实测 0.5 s 内开始跟随）。
- **AA 改权限后显示被旧值盖回**：`currentPermissions` 要等下一轮才更新，映射时改为 `latestThreadSettings` 优先，`currentPermissions` 只补缺。
- **切回 workspace-write 时 `writableRoots` 为空**：沿用 App 现有设置里的 `writableRoots`（App 自身的做法），没有时才用 `runtimeWorkspaceRoots` / cwd。
- **AA 新建的会话要重启 App 才出现在侧边栏**：App 的会话列表只在启动时完整加载一次（`refreshRecentConversations({mode:'catalog'})`），之后只增量加入自己产生的会话。现在 owner 对 AA 自己新建的线程（会话状态来源出现过 `codex.thread/start`）广播 `thread-unarchived {hostId, conversationId}`：第一轮开始时一次（rollout 已落盘，App 读得到），第一轮结束时再一次（带上标题），之后不再发。App 的 `handleThreadUnarchived` 会 `readThread` 并 `upsertConversationFromThread`，会话立即出现在 Recents，不用重启。AA 只是 resume 的旧线程不发，避免把用户在 App 里归档的会话重新显示出来。广播失败只记警告。
  - 已知副作用：发过广播的会话只进 Recents，**不会归到 App 的项目分组**，App 重启后才归组。对比实测：未广播的「6666」被 App 自己的目录同步（共享状态库增量同步，定时器最长约 1 h）归进了 AA 项目；广播过的「77777」一直只在 Recents。推断是广播让 App 提前认识了该会话，之后的目录同步不再为它分组。已排除：给线程写 app-server `projectId`（`thread/metadata/update`）后再广播无效，这版 App 分组不看该字段；`codex://threads/<id>` 打开也不会归组。外部无法触发 App 的完整重载（只在启动或 App 与自家 app-server 重连时发生）。

已知未解决：

- 一次 Connector 卡死：主线程停在 `threading.Thread.start()`（anyio 开工作线程，调用方 `reader._read_native_activity`），心跳超时 `keepalive ping timeout` 后不再重连；之后连续运行 2 小时以上未复现。再出现时用 `py-spy dump --native` 看本机层调用栈。
- 本文的 IPC 测试（socket fake）在 win32 上整体跳过；Windows 相关的修复由 `tests/test_codex_ipc_windows_fixes.py` 覆盖，这个文件不跳过。
- 从 Connector 经 IPC 让 App 开始一轮，App 端需要 3–6 s；App 内直接发送约 1.3 s，慢在 App 内部。

### 4.4 对现有行为的影响与跨端

- 不改 `contracts/` 即可完成 P0（`SessionMeta.metadata` 是自由字段）。若要在 Web / Desktop / Android / iOS 上明确标注“终端会话 / 桌面会话 / Connector 会话”，需要先在 `contracts/` 增加 `sessionSource` 枚举再同步四端。
- Connector 现在依赖的 `openai_codex` Python SDK 只支持 `subprocess` stdio 传输，没有 websocket/unix 能力，所以传输层必须自写（或向 SDK 注入自定义 transport）。
- Server 测试与 headless 检查不覆盖真机 daemon / 桌面 App，验收要靠本机探针与真实会话。

## 5. 未验证 / 待办

- 层 B 尚未实测的控制项：`thread-follower-steer-turn`、`interrupt-turn`、各类审批/用户输入回复（owner 侧与 start-turn 同一分发，风险低）；待审批时 `requests` 的具体结构也还没抓到样本（需要一个默认权限的线程触发审批）。
- 持有者释放写锁的时延（关闭标签 / 线程空闲卸载）与我们 `thread/unsubscribe` 后卸载的时延未测量。
- 旧桌面实例 IPC client 挂死的根因未定位；实现侧按“discovery 超时 = 持有者不可达”防御即可。
- 没有对 daemon 做任何写操作（`thread/resume`、`turn/start`、审批）；写路径的行为依据是上游源码与 Ember/codexctl 的实测记录。
- 108 字节 AF_UNIX 路径限制未测试。
- 上游明确 daemon 是实验特性，接口可能变化；复刻实现应把方法名、版本表、socket 路径集中在一处配置，便于随 Codex 升级调整。

## 6. 参考

- 上游：`codex-rs/app-server-daemon/README.md`、`codex-rs/app-server-transport/src/transport/{mod,unix_socket}.rs`、`codex-rs/app-server-daemon/src/client.rs`、`codex-rs/tui/src/{lib,daemon_startup,app_server_connection}.rs`、`codex-rs/app-server/src/{transport,thread_state,outgoing_message}.rs`、`codex-rs/app-server/src/request_processors/{thread_processor,thread_lifecycle,initialize_processor}.rs`、`codex-rs/app-server-protocol/src/protocol/v2/thread.rs`。
- 第三方实现：[tarakanof/Ember issue #263](https://github.com/tarakanof/Ember/issues/263)（daemon 旁观者实测与 originator 坑）、[samuelhe52/codexctl](https://github.com/samuelhe52/codexctl)（stdlib Python daemon 客户端，WS over UDS 握手与方法序列）。
- IPC 相关 issue：[openai/codex#8965](https://github.com/openai/codex/issues/8965)、[#21806](https://github.com/openai/codex/issues/21806)、[#32385](https://github.com/openai/codex/issues/32385)、[#34109](https://github.com/openai/codex/issues/34109)（socket 路径演变与多窗口竞争）。
