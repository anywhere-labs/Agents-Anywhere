# DSH Bridge 3.0（插件在 DSH host 里说 ACP）

装了 DSH Desktop（或开着 `dsh web`）并装了 AA 插件 3.x 时，插件在 DSH host 进程里实现一个 ACP Agent，拨号到 Connector 的本机 socket。会话就是 host 里的真实会话，和 DSH 界面双向实时一致。2.0（MeshCall）继续留给旧插件，两者并存至少一个大版本周期。

本契约的 JSON Schema 在 `schemas/`，由 `manifest.json` 记录校验和；它们是本契约的唯一来源（不经 Server 的 Pydantic 导出，Server 不参与这条本机链路）。Connector 的 TS 类型由 `connector-ts` 的 `yarn contracts:generate` 生成；插件侧的类型在 `dsh-bridge-next/src/contracts/bridge-v3.ts`，由测试对照这些 Schema 校验。

线上协议是 **ACP v1**（`protocolVersion: 1`），插件是 Agent 端，Connector 是 Client 端。标准方法的语义以 ACP 为准，本文只写 DSH 的约定和扩展。

## 1. 传输与握手

1. Connector 监听本机 Unix socket（macOS / Linux）或 named pipe（Windows），发布 rendezvous 文件 `<用户主目录>/.agents-anywhere/dsh-bridge/connector-acp.json`（`schemas/rendezvous.schema.json`）：

   ```json
   {
     "version": 3,
     "protocol": "acp",
     "instanceId": "4f1a…",
     "pid": 12345,
     "endpoint": {"unixPath": "/Users/me/.agents-anywhere/dsh-bridge/acp-4f1a….sock"},
     "key": "ak_…"
   }
   ```

   - 文件权限 0600，原子替换；Connector 退出时按 `instanceId` 匹配后删除。
   - `key` 每次 Connector 启动重新生成（`ak_` 前缀加至少 32 字节随机数的 hex）。
   - Unix socket 文件权限 0600，Connector 接受连接后校验对端 uid 与自己相同；named pipe 只授予当前用户。
   - 2.0 的 `connector.json`（`version: 2`, `protocol: "meshcall"`）保持原文件名和原格式。v3 Connector 两个文件都发布；插件 3.x 只读 `connector-acp.json`，插件 2.x 只读 `connector.json`。
2. 插件 `fs.watch` rendezvous 所在目录（加 1 s 轮询兜底），文件出现或 `instanceId` / `key` 变化时断开旧连接、拨号新地址。
3. 连上后插件先发**一行** JSON（UTF-8，`\n` 结尾，不超过 64 KiB），即握手帧 `hello`（`schemas/hello.schema.json`）：

   ```json
   {"t": "hello", "bridgeProtocol": "3.0", "key": "ak_…", "hostInstance": "b7c2…", "hostKind": "desktop",
    "dshVersion": "0.2.2-rc.3", "pluginVersion": "3.0.0", "dshHome": "/Users/me/.dsh"}
   ```

   - Connector 用 SHA-256 后常量时间比较 `key`。
   - 通过时回一行 `welcome`（`schemas/welcome.schema.json`）：`{"t":"welcome","bridgeProtocol":"3.0","connectorInstance":"4f1a…","connectorVersion":"3.0.0"}`；之后同一连接上只跑 ACP 的 ndjson 帧。
   - 不通过时回一行 `reject`（`{"t":"reject","code":"bad_key"|"unsupported_protocol"|"duplicate_host"|"busy","message":"…"}`）后关闭连接。插件对 `bad_key` 等 rendezvous 变化后再拨；对 `unsupported_protocol` 提示升级；其他代码按 1–30 s 指数退避重拨。
   - Connector 10 s 内收不到 `hello` 就关闭连接。
4. **每个 host 一条连接**，以 `hostInstance` 区分（host 进程启动时生成的随机 ID，插件热重载时不变）。同一 `hostInstance` 的新连接替换旧连接（旧连接被关闭）。多个 host（例如 DSH Desktop 和 `dsh web` 同时开着）各连一条，取代 2.0 的 manager lock。
5. 不依赖 ACP 的 `authenticate`：`initialize` 返回 `authMethods: []`。

## 2. `initialize`

Connector 发 `initialize`，`clientCapabilities` 照常声明（`fs`、`terminal` 都为 false；支持提问时声明 `elicitation`）。插件返回：

- `agentInfo`：`{name: "agents-anywhere-dsh-bridge", version: <插件版本>}`。
- `agentCapabilities`：`loadSession: true`；`sessionCapabilities: {list: {}, resume: {}, close: {}}`；`promptCapabilities.image` 只在 host 有附件存储时为 true，`audio` 与 `embeddedContext` 为 false。
- `_meta.dsh`（`schemas/agent-meta.schema.json`）：`bridgeProtocol`、`hostInstance`、`dshVersion` 和 `features`。`features` 是插件按 host 当前服务算出的布尔表：`queue`、`steer`、`continue`、`planning`、`questions`、`attachments`、`fileUploads`、`agentPresets`、`permissionPresets`。Connector 只按这张表发布能力，不按 DSH 版本号推断。服务热插拔后插件发 `_dsh/host/features`（同形）更新。

## 3. 会话 ID

- 线上的 `sessionId` 一律是 **DSH 原生会话 ID**。平台会话 ID 由 Connector 推导（`contracts/identity-vectors/1.0` 的 DSH 算法），插件不再知道 AA 的 namespace。
- `session/new` 的 `_meta.dsh.sessionId` 由 Connector 指定（AA 新建会话的原生 ID `aa_<namespace 摘要>_<平台会话 ID>`）。插件用它调用 `sessionController.create`；同一 ID 已存在且 `cwd` 相同时返回已有会话（幂等，供「响应丢失后重试」使用），`cwd` 不同时报错 `-32602`。
- 直连路由（`dsh --profile acp`）只能随机 UUID，由 Connector 的别名表记录；插件路由看到的是同一个原生 ID，无需特殊处理。

## 4. 会话列表

- `session/list`：返回 host 里**对用户可见**的全部会话（与 DSH 侧栏同一套可见性、归档、子 Agent 过滤），按更新时间倒序，`cursor` 分页（每页最多 100 条）。条目：`sessionId`、`cwd`、`title`、`updatedAt`，以及 `_meta.dsh`（`schemas/session-info-meta.schema.json`）：`createdAt`、`running`、`lastSeq`、`workspaceId`、`writer`（见 §9）。
- `_session/list/subscribe`（请求，参数 `{}`，返回 `{}`）之后，插件在列表变化时发通知 `_session/list/changes`（`schemas/list-changes.schema.json`）：`{upserts: SessionInfo[], removals: string[]}`。新建、标题变化、开始/结束运行、归档、取消归档、被另一 host 写入后重新扫描到，都会推送。`_session/list/unsubscribe` 停止推送。

## 5. 附着与回放

- `session/load {sessionId, cwd, mcpServers, _meta.dsh.replayFromSeq?}`：把会话从 `replayFromSeq`（缺省 0，即全部）起的**已提交**事件依次作为 `session/update` 发出，然后附着，之后的实时更新继续推送。返回前保证回放已全部发出。
  - 返回 `configOptions` 和 `_meta.dsh`（`schemas/load-result-meta.schema.json`）：`lastSeq`（回放截止的原生 seq）、`running`、`continuable`（见 §7）。
  - `replayFromSeq` 大于会话当前 seq 时不回放（Connector 用它做断线续传）；小于 DSH 已压缩掉的部分时，插件从能读到的最早事件开始，并在结果里标 `replayTruncated: true`。
- `session/resume`：等价于 `replayFromSeq = 当前 seq + 1` 的 `load`（只附着、不回放）。
- `session/close`：**只解除附着**，不 dispose host 里的 Agent、不取消回合、不释放写锁。插件从不因为 Connector 的请求或断线 dispose 用户的 Agent（不变量 I1）。
- Connector 断线时插件解除该连接的全部附着；会话继续在 host 里运行。重连后 Connector 用 `load` + `replayFromSeq = 已提交的最大 seq + 1` 补齐。

## 6. `session/update` 的 DSH 约定

每条 `session/update` 的 `update._meta.dsh`（`schemas/update-meta.schema.json`）带：

| 字段 | 含义 |
| --- | --- |
| `seq` | 产生这条更新的原生事件 seq（已提交的更新必有；流式片段为当时已提交的最大 seq） |
| `turn` | 原生回合号 |
| `transient` | `true` 表示流式片段（`agent/assistant-stream`），没有落盘，可能被同一 `attemptId` 的提交整条替换或作废 |
| `attemptId` | 流式片段所属的生成尝试 |
| `committed` | 已提交的整条 `assistant/message`：`{messageId, replacesAttempt?}`。Connector 收到后丢弃同一 `attemptId` 的流式内容，用提交内容整条替换 |
| `abandoned` | `{attemptId}`：该尝试作废（重试、中断），丢弃其流式内容 |
| `source` | 用户消息的来源：`user`（DSH 界面或 AA）、`retry`（DSH 的空继续，Connector 不显示） |
| `requestId` | 用户消息的 `rpcId`；AA 发出的消息与 `session/prompt` 的 `_meta.dsh.requestId` 相同，Connector 据此去重 |
| `turnEvent` | 回合边界（§7），只出现在 `session_info_update` 上 |

更新类型映射（借用 DSH 官方 `dsh-acp` 的纯转换函数，MIT，文件头注明来源）：

| 原生事件 | ACP 更新 |
| --- | --- |
| `user/message`（`source.kind` 为 `user`） | `user_message_chunk`（每个文本或图片块一条，`messageId` 为原生消息 ID） |
| `agent/assistant-stream` 的文本 / 推理增量 | `agent_message_chunk` / `agent_thought_chunk`，`transient: true` |
| `assistant/message` | 每个块一条 `agent_message_chunk` / `agent_thought_chunk`，带 `committed` |
| `tool/call` | `tool_call`（`status: in_progress`，`rawInput` 为解析后的参数，`title` 为工具名） |
| `tool/result` | `tool_call_update`（`completed` / `failed` + 内容） |
| `session/title` | `session_info_update`（`title`） |
| 模型目录变化 | `config_option_update` |
| `assistant/message` 的用量 | `usage_update` |

## 7. 回合

ACP v1 只在 `session/prompt` 返回时体现回合结束，而 DSH 界面发起的回合没有对应的 prompt。所以插件对每个附着的会话，在回合开始和结束时各发一条 `session_info_update`，回合信息放在 `update._meta.dsh.turnEvent`（`schemas/turn-notification.schema.json`）：

- `{sessionId, phase: "started", turn, seq}`：原生 `turn/start`。
- `{sessionId, phase: "ended", turn, seq, requestIds, stopReason, reason, continuable}`：原生 `turn/end`。`requestIds` 是这一轮消费的用户输入的 `rpcId`（含 DSH 的空继续）；`stopReason` 用 ACP 词汇（`end_turn` / `max_tokens` / `cancelled` / `refusal`），`reason` 是原生 `TurnEndReason.kind`（`completed`、`interrupted`、`error`、`blocked`、`aborted`、`max-tokens`）与可选的 `message`；`continuable` 表示 DSH 的 `conversationContinuation` 投影等于这一轮的 `turn/end` seq（0.2.2-rc.3 起；更早的 DSH 恒为 false）。

为什么不用扩展通知：`@agentclientprotocol/sdk` 把扩展通知和 `session/update` 走不同的分派路径，扩展通知可能越过前面的更新和请求响应（S7 实测）。放进 `session/update` 才能保证和消息、工具更新同序。**Connector 不得假设扩展通知（`_session/list/changes`、`_dsh/*`）与 `session/update`、请求响应之间的到达顺序。**

失败卡片的「继续」：`_dsh/session/continue {sessionId, turnEndSeq}`（请求）→ `{outcome: "accepted" | "unavailable"}`。插件用空内容、`mode: "queue"` 调 `sessionController.prompt`，请求 ID 由会话和 `turnEndSeq` 推导，重复调用无副作用。

## 8. 发送

`session/prompt` 的 `_meta.dsh`（`schemas/prompt-meta.schema.json`）：

- `requestId`（必填，≤ 512 字节）：写进原生用户消息的 `rpcId`，用于幂等与去重。同一 `requestId` 已被 DSH 接纳时直接返回成功，不再发一次。Connector 用 AA 的 `clientMessageId` 推导（`dshPluginUserMessageId`）。
- `delivery`：
  - 缺省（`"turn"`）：标准 ACP 语义，等这条输入所在的回合结束后返回 `stopReason`。
  - `"queue"`：进 DSH 原生收件箱，**接纳后立即返回**，`_meta.dsh.admitted: true`（`schemas/prompt-result-meta.schema.json`）；回合的开始与结束只经 §7 的 `turnEvent` 报告。Connector 默认用这种方式，以便和 DSH 界面的排队共存。
- `selections`：可选 `{model?, reasoningEffort?, permission?, agentPreset?}`，在接纳前应用（等价于先调 `session/set_config_option`）。

运行中追加输入用 `_session/steering`（与 codex-acp、claude-agent-acp 同名）：`{sessionId, prompt, _meta.dsh.requestId}` → `{outcome: "injected" | "promptRequired" | "failed", message?}`，内部是 `mode: "steer"` 的 `sessionController.prompt`。会话空闲时返回 `promptRequired`，由 Connector 改发普通 prompt。`features.steer` 为 false 时不提供。

内容：`text`；`image`（`promptCapabilities.image` 为 true 时）；普通文件用 `resource_link`，`_meta.dsh.upload: {path, name, mimeType?, size}` 指向 Connector 暂存目录里的文件，插件经 `fileUploads.uploadStream` 上传后作为 DSH 文件引用发送。

`session/cancel`：`agents.get(id).cancel({kind: "user"})`。

## 9. 配置与写锁

- `configOptions`：`model`（category `model`，值为 `JSON.stringify([provider, model])`，与官方 `dsh-acp` 相同）、`reasoning_effort`（category `thought_level`）、`permission`（category `mode`，DSH 权限预设）、`agent_preset`（新建会话时可选，category `mode`）。`session/set_config_option` 只对附着的会话生效。
- 写锁：`session/list` 条目与 `_dsh/session/writer` 通知（`schemas/writer-notification.schema.json`）报告 `writer`：
  - `"host"`：本 host 持有（会话在本 host 里有 Agent）。
  - `"external"`：另一个进程持有（`sessionController` 恢复时返回 `session/writer-held`）。Connector 据此执行 `docs/v3/04-connector.md` §5.6 的交接表；插件在 DSH 界面提示「Agents Anywhere 正在使用，回合结束后可编辑」。
  - `"none"`：没人持有。
- 插件的写操作遇到 `session/writer-held` 时返回 ACP 错误 `-32002`（`data.code: "writer_held"`）。

## 10. 交互

- 审批：DSH `$events` 交互流里的 `approval/request` 转成 `session/request_permission`（`options` 为 DSH 给出的选项，`optionId` 原样；`toolCall.toolCallId` 为原生 `callId`）。Connector 回答后插件提交给 DSH。
- DSH 界面先答：插件对挂起的 `session/request_permission` 发 `$/cancel_request`（`@agentclientprotocol/sdk` 1.4.0 的 `cancellationSignal`，协作式），并发通知 `_dsh/interaction/resolved {sessionId, interactionId, by: "dsh", optionId?}`（`schemas/interaction-resolved.schema.json`）。Connector 收到后关闭 AA 侧的审批卡片，并对挂起的请求回 `{outcome: {outcome: "cancelled"}}`；插件忽略这个迟到的回答。
- 提问（`ask_user_question`）：Connector 声明 `clientCapabilities.elicitation` 时走 `elicitation/create`；否则 `features.questions` 为 false，提问只在 DSH 界面出现。
- 计划：`_dsh/planning/get {sessionId?}` → `{available, active?, pending?}`；`_dsh/planning/set {sessionId, active}` → `{outcome: "committed" | "queued" | "cancelled" | "noop", active, pending?}`，语义与 2.0 的 `getPlanning` / `setPlanning` 相同。计划审阅以带 `_meta.dsh.planningReview: {markdown, questionId, approveOptionId}` 的 `session/request_permission` 发出。

## 11. 错误

| ACP code | `data.code` | 含义 |
| --- | --- | --- |
| -32602 | `invalid_params` | 参数不合法（空内容、cwd 不同、requestId 过长） |
| -32002 | `session_not_found` | 会话不存在或在 DSH 里不可见 |
| -32002 | `writer_held` | 另一个进程持有写锁 |
| -32603 | `dsh_unavailable` | host 服务（`sessionController` 等）当前不可用，`data.retryable: true` |
| -32601 | — | 未提供的扩展（`features` 里为 false） |

## 12. 不变量

- **I1**：Connector 断线、`session/close`、插件卸载都不 dispose host 里的 Agent，不取消回合。
- **I2**：同一 DSH 会话任一时刻只有一个写者；路由（插件 / 直连 `dsh --profile acp`）只在回合之间切换，交接规则见 `docs/v3/04-connector.md` §5.6。
- **I3**：插件只上报 host 的事实（事件、能力、写锁），不做 AA Timeline 投影、检查点、账号逻辑；这些都在 Connector。

## 13. 与 2.0 的关系

| | 2.0 | 3.0 |
| --- | --- | --- |
| 传输 | 本机 MeshCall Router（Go）+ `connector.json` | 本机 socket + `connector-acp.json`，无 MeshCall |
| 线上形状 | 私有服务 `aa.dsh.v2.Bridge` / `Sync`，插件投影成 AA Timeline 操作 | ACP v1 + `_meta.dsh` / `_dsh/*` 扩展，Connector 投影 |
| 多 host | manager lock，只认一个 | 每个 host 一条连接 |
| 插件体量 | 账号、onboarding、uv/Python Connector 管理、投影 | 只做 host 适配；用 DSH 自带 Node 拉起 TS Connector |
| 检查点 | 「Server 已接受」 | 不需要：Connector 按 `seq` 续传 |
