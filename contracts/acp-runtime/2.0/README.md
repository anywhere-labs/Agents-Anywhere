# ACP Runtime 2.0（AA 在 ACP 之上的约定）

v3 Connector（`connector-ts/`）把 Codex、Claude、Hermes 和官方 ACP Agent（OpenCode、Antigravity、CodeBuddy、Command Code、MiMo、MiniMax）都当作 ACP Agent 驱动。本契约描述 Connector 作为 ACP Client 时**已经实现**的行为：initialize 协商了什么、用到哪些扩展、ACP 能力怎样映射成 AA 能力 ID、消息怎样判定接纳。

- 只约束 Connector 与 Agent 之间。ACP 类型不越过 Connector 的 `RuntimeSession` 端口（`connector-ts/src/application/ports/runtime-session.ts`），也不进入 Server 或客户端契约；客户端看到的是 `protocol` 1.2 的能力与 Timeline。
- 实现位置：`connector-ts/src/runtime/acp/`（`client.ts`、`session.ts`、`handle.ts`、`dialect.ts`、`capabilities.ts`、`config.ts`、`mapping.ts`）和 `connector-ts/src/runtime/profiles/`（`generic`、`hermes`、`claude`、`codex`、`definition.ts`）。
- `registry.json` 是下文扩展注册清单与能力映射表的机器可读版本，`manifest.json` 记录它的 SHA-256。两者与本文冲突时以代码为准，并同时修正本目录。
- 一律不协商契约版本：Connector 与被驱动的适配器按 Profile 里记录的版本发布（例如 Claude 适配器验证版本 `0.107.2`）。

## 1. initialize 协商

### 1.1 协议版本

- 客户端在 `protocolVersion` 里声明自己支持的最高版本，取值 1 或 2，由方言决定，缺省 1。**目前所有方言（generic、hermes、claude、codex）都声明 1**；声明 2 的代码路径已经存在，但还没有任何 Runtime 启用（见第 8 节）。
- Agent 回的版本必须满足 `1 ≤ 回复版本 ≤ 声明版本`；缺省按 1 处理。超出这个范围时 initialize 失败（JSON-RPC `-32600`），不会降级重试。
- `clientInfo` 固定为 `{name: "agents-anywhere", version: "3.0.0"}`。

### 1.2 客户端能力

所有方言共用的 `clientCapabilities`：

```json
{ "auth": {}, "elicitation": { "form": {} }, "session": { "configOptions": { "boolean": {} } } }
```

- 不声明 `fs`、`terminal`：AA 的文件与终端走独立通道，目前接入的 Agent 都不依赖它们。
- 布尔配置项保留布尔值，用 `session/set_config_option` 的 `type: "boolean"` 下发。

方言在此基础上追加：

| Runtime | 追加内容 | 作用 |
| --- | --- | --- |
| Codex | `clientCapabilities._meta.codexItemContext: true` | 请 codex-acp 在 `session/update` 上附带 `_meta.codex`（Codex turn、条目类型、clientMessageId），用于按 v2 规则算 Timeline ID |
| Codex | initialize 顶层 `_meta.codexIpc: {approvals: true, settings: true, historyReplacement: true}` | 审批、设置跟随 Codex App；接收历史整体替换（`_codex/session/history_reset`） |
| Claude | `clientCapabilities._meta.jetbrains.air: {version: 1, capabilities: ["sessionFailure"]}` | 只声明 AA 能处理的 `sessionFailure`；声明 AIR 后适配器才提供目标控制 |

Codex **不声明** JetBrains AIR：codex-acp 对 AIR 客户端会改用另一套工具调用上报形状。Claude 不声明 `asyncTasks`、`nativeSubagentSessions`、`diffPatch`、`rawInputRendering` 等会改变工具输出形状的 AIR 能力。generic、hermes 不追加任何内容。

### 1.3 读取的 Agent 响应字段

| 字段 | 用途 |
| --- | --- |
| `agentCapabilities.loadSession` | `session.history.native`；通用只读历史与带回放的附着依赖它 |
| `agentCapabilities.sessionCapabilities.list` / `fork` | `session.list` / `session.fork` |
| `agentCapabilities.sessionCapabilities.resume` | 不需要回放时用 `session/resume` 代替 `session/load` |
| `agentCapabilities.sessionCapabilities.close` | 关闭会话、只读历史读完后发 `session/close` |
| `agentCapabilities.promptCapabilities.image` / `audio` / `embeddedContext` | `runtime.attachment` 及其参数 |
| `_meta.steering.supported` | Codex、Claude 的 `session.steer` |
| `_meta.jetbrains.air.goal.controlMethod` / `.actions` | Claude 的目标控制方法名与可用动作 |
| `_meta.aa.guarantees` 包含 `stable_native_identity` | 信任 Agent 的 `messageId`、`toolCallId` 和 `_meta.aa.timelineItem` 作为跨连接稳定身份 |

## 2. 扩展注册清单

方向：C→A 表示 Connector 发给 Agent，A→C 表示 Agent 发给 Connector。「必需」指该 Runtime 的对应功能离不开它。

| 扩展 | 形式 | 方向 | Runtime | 必需 | 未协商或不支持时 |
| --- | --- | --- | --- | --- | --- |
| `_session/steering` | 请求 `{sessionId, prompt, _meta.steering.idleBehavior: "promptRequired"}`，Codex 另合并 `_meta.codexIpc.clientMessageId`；响应 `outcome: injected \| startedNewTurn \| promptRequired` | C→A | Codex、Claude | 否 | initialize 响应没有 `_meta.steering.supported: true` 时 `session.steer` 为 `supported=false`；调用返回 `-32601` 时插话记为 rejected（`runtime_unsupported`），其它 outcome 记为 rejected（`steer_failed`） |
| `_session/goal` | 请求 `{sessionId, action: get \| set \| pause \| resume \| clear, objective?, tokenBudget?}`；响应取 `goal`，没有时取 `state` | C→A | Codex（固定方法名）、Claude（方法名取自 `_meta.jetbrains.air.goal.controlMethod`） | 否 | Claude 没有 `controlMethod` 时 `session.goal` 为 `supported=false`，不提供目标端口；Codex 始终声明支持 |
| `_codex/session/read` | 请求 `{sessionId}`；响应 `{updates: [session/update 的 update…]}` | C→A | Codex | 是（Codex 只读历史） | 没有降级路径：只读历史不 resume、不抢写锁，请求失败即读取失败 |
| `_codex/session/history_reset`（begin） | 反向请求 `{sessionId, phase: "begin", revision}`；回复 `{revision, ready: true}`，之后的更新按历史重放翻译、条目位置从头计数 | A→C | Codex | 是（历史整体替换） | 由 `_meta.codexIpc.historyReplacement` 协商；`phase` 不是 begin 或缺 `revision` 时回 `-32601` |
| `_codex/session/history_reset`（commit / abort） | 通知 `{sessionId, phase: "commit" \| "abort", revision}`，结束重放 | A→C | Codex | 是 | 同上；其它 phase 忽略 |
| `_meta.codexIpc`（initialize） | `{approvals, settings, historyReplacement}` 均为 `true` | C→A | Codex | 是 | — |
| `_meta.codexIpc.mode: "auto"` | `session/load`、`session/resume` 的参数 | C→A | Codex | 是 | Codex App 持有会话时跟随它，否则直接打开。`follow`、`daemon` 未使用 |
| `_meta.codexIpc.clientMessageId` | `session/prompt`、`_session/steering` 的参数，值为 AA 的 clientMessageId | C→A | Codex | 是 | Codex 记进 ThreadItem.clientId，实时与历史都能认回 AA 发出的消息 |
| `clientCapabilities._meta.codexItemContext` | `true` | C→A | Codex | 是（v2 一致的 Timeline ID） | Agent 不附带 `_meta.codex` 时退回通用 ACP 身份规则 |
| `_meta.codex` | `session/update` 上的 `{turnId, itemType, clientMessageId?}` | A→C | Codex | 同上 | 缺 `turnId` 或 `itemType` 的更新按通用 ACP 身份规则处理 |
| `clientCapabilities._meta.jetbrains.air` | `{version: 1, capabilities: ["sessionFailure"]}` | C→A | Claude | 否 | 不声明时没有目标控制，也收不到会话失败提示 |
| `_meta.jetbrains.air.sessionFailure` | `session_info_update` 上的 `{id, revision, severity, title, details?, category?, reason?, actions?}` | A→C | Claude | 否 | 回合内的 warning 投影为「模型请求重试」提示（每回合一个条目），其余投影为警告或错误提示 |
| `_meta.aa.selectionCategory` | 配置项上的 `model \| permission \| effort` | A→C | 全部 | 否 | 按 ACP `category` 与配置项 ID 推断（第 4 节） |
| `_meta.aa.timelineItem` | `session/update` 上的 `{id, type: message \| tool, revision}` | A→C | 全部 | 否 | 只在 initialize 响应 `_meta.aa.guarantees` 含 `stable_native_identity` 时生效；旧 revision 丢弃 |
| `_meta.aa.guarantees` | initialize 响应 `_meta`，目前只识别 `stable_native_identity` | A→C | 全部 | 否 | 不信任原生 ID，条目 ID 只在本次连接内稳定 |

标准 ACP 反向请求只处理 `session/request_permission` 与 `elicitation/create`。其它反向请求先交给方言（上表中的 `_codex/session/history_reset`），方言不认识的一律回 `-32601`；不属于任何已附着会话的 `session/request_permission` 回 `cancelled`。

## 3. 能力映射表

能力只来自 initialize 协商和方言声明，不按 provider 名称写死。会话级能力目前等于运行时级能力；`revision` 固定为 1。

| AA 能力 ID | ACP 来源 | generic | Hermes | Codex | Claude |
| --- | --- | --- | --- | --- | --- |
| `session.send_message` | `session/prompt` | 是 | 是 | 是 | 是 |
| `session.interrupt` | `session/cancel` 通知；取消前把待答的权限请求回 `cancelled` | 是 | 是 | 是 | 是 |
| `session.steer` | `_session/steering`，或文本命令 | 否 | 是：`session/prompt` 发 `/steer <文本>`，不支持附件 | `_meta.steering.supported` | `_meta.steering.supported` |
| `session.interaction.approval` | `session/request_permission` | 是 | 是 | 是 | 是 |
| `session.interaction.form` | `elicitation/create`（客户端声明 `elicitation.form`） | 是 | 是 | 是 | 是 |
| `session.commands` | `available_commands_update`；执行时以 `/<名称> <参数>` 作为 prompt 发出 | 是 | 是 | 是 | 是 |
| `session.configuration.read` / `.update` | `configOptions`、`session/set_config_option`；没有 `configOptions` 时用旧的 `modes` / `models` 与 `session/set_mode` / `session/set_model` | 是 | 是 | 是 | 是 |
| `session.list` | `sessionCapabilities.list` | 协商 | 协商 | 协商 | 协商 |
| `session.fork` | `sessionCapabilities.fork` | 协商 | 协商 | 协商 | 协商 |
| `session.history.native` | `agentCapabilities.loadSession` | 协商 | 协商 | 协商 | 协商 |
| `runtime.attachment` | `promptCapabilities.image`，参数 `{image, audio, embeddedContext}` | 协商 | 协商 | 协商 | 协商 |
| `catalog.permission` | 定义里的权限目录或权限选项 | 否 | 是 | 是 | 是 |
| `catalog.model` | 模型配置项（`category: model`） | 未声明 | 未声明 | 是 | 是 |
| `session.planning` | Codex：`collaboration_mode` 取 `plan` / `default`；Claude：`mode` 取 `plan`，退出时回到进入前的模式 | 未声明 | 未声明 | 是 | 是 |
| `session.plan_document` | `plan_update`（`plan.type: markdown`）；Claude 另从 ExitPlanMode 的 `toolCall.rawInput.plan` 取正文 | 未声明 | 未声明 | 是 | 是 |
| `session.plan_review` | `session/request_permission`：Codex 为 `plan-review:<itemId>` 与 `implement_plan` / `revise_plan`；Claude 为 ExitPlanMode 与 `exit-plan-*` / `reject` | 未声明 | 未声明 | 是 | 是 |
| `session.goal` | `_session/goal` | 未声明 | 未声明 | 是，动作 `set`、`pause`、`resume`、`clear` | 有 `controlMethod` 时是，动作取 `air.goal.actions`，缺省 `set`、`clear` |

说明：

- 「协商」表示取决于 Agent 的 initialize 响应；「未声明」表示该方言不输出这一项。
- 模型目录由配置项生成，不依赖 `catalog.model` 是否声明：只要会话有 `category: model` 的配置项，就能列出模型与推理强度。
- 端口里还有 `session.queue`、`session.archive`、`session.rename`、`catalog.effort` 四个 ID，ACP 层目前都不输出（见第 8 节）。排队由 Connector 在 ACP 之外实现，不对应任何 ACP 能力。
- 计划审阅的回答：同意选对应的允许选项（Claude 选回到进入计划前权限模式的 `exit-plan-*`，从不选清空上下文的选项）；修改计划时拒绝，意见等当前回合结束后作为新消息发出；暂不执行时 Codex 只拒绝（留在计划模式），Claude 拒绝后再中断回合。

## 4. 配置项

**类别。** 优先使用配置项 `_meta.aa.selectionCategory`（只认 `model`、`permission`、`effort`）。否则按 ACP `category` 映射：`model` → model，`thought_level` / `effort` → effort，`mode` → mode（配置项 ID 为 `collaboration_mode` 时 → collaboration_mode），`collaboration_mode`、`permission` 原样；没有 category 时按 ID（`model`、`mode`、`reasoning_effort` / `effort` / `thought_level`、`collaboration_mode`）推断，其余为 other。方言再修正：

| Runtime | 修正 |
| --- | --- |
| Codex | `mode`（审批与沙箱预设）→ permission；计划模式在 `collaboration_mode` |
| Claude | `mode`（Claude Code 权限模式，含 `plan`）→ permission |
| Hermes | `edit_approval_policy` → permission；会话没有模型配置项时打开失败（`agent_version_unsupported`） |
| MiniMax | `permissionMode` → permission |
| Command Code | 没有权限类配置项时，把旧的 session modes 作为权限项 `command-code-permission-mode` |

**选择 ID。** 与 v2 一致，算法由 `contracts/identity-vectors/1.0` 覆盖：通用 ACP 用 `acpSelectionId`（带推理强度时为 `acp-selection:` 加 base64url 编码的 `[model, effort]`）；Codex 用 Codex 的模型选择 ID，权限选择 ID 由 codex-acp 的 `mode` 预设换算（`workspace-write` → request_approval，`agent` → auto_review，`agent-full-access` → full_access，其它预设用自身 ID）；Claude 用 Claude 的模型与权限选择 ID，推理强度 `default` 不列出。

**创建会话时的初始选择**按类别落到配置项：每个类别必须恰好对应一个配置项，否则失败（`configuration_mapping_unavailable`）；值不在可选范围（`invalid_configuration_value`）、模型选择与推理强度不一致（`configuration_conflict`）、选择 ID 无法解码（`invalid_selection`）也都失败。失败时关闭刚建的会话。

**实例配置。** 实例配置可以从 Server 修改，所以绝不携带启动指令：定义生成的 schema 必须 `additionalProperties: false`，且不能含 `command`、`commands`、`args`、`arguments`、`argv`、`env`、`environment`、`launch`、`shell`（不区分大小写）。可配置项只有 `cliPath` 和定义声明的目录（例如 Codex 的 `codexHome` → `CODEX_HOME`、`codexPath` → `CODEX_PATH`，Claude 的 `claudeExecutable` → `CLAUDE_CODE_EXECUTABLE`，Hermes 的 `hermesHome` → `HERMES_HOME`），都是不超过 4096 字符的字符串。模型网关由 Profile 注入环境变量（Claude 只接受 Anthropic 协议），不经实例配置透传。

## 5. 接纳语义

`session/prompt` 发出后，消息的结果按下列规则判定（沿用 v2 公共引擎）：

| 结果 | 条件 |
| --- | --- |
| accepted | 回合开始后第一条 `agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`plan` 或 `plan_update`；或回合内到达 `session/request_permission` / `elicitation/create`；或 `session/prompt` 正常返回 |
| rejected | 接纳之前收到确定的 JSON-RPC 错误；会话已关闭（`session_closed`）或已有回合在运行（`session_busy`） |
| unknown | 接纳之前请求超时、连接断开、Agent 进程退出或启动失败（`runtime_disconnected`、`runtime_timeout`） |

- **unknown 不重发**：调用方不得自动重试，只能等后续事件或让用户决定。
- 接纳之后的错误不改变接纳结果，只让回合以 `failed` 结束。
- JSON-RPC 错误码归类：`-32000` → `runtime_auth_required`，`-32602` → `invalid_argument`，`-32601` → `runtime_unsupported`，其余 → `runtime_error`；方言可以给出更具体的错误码（`contracts/runtime-errors`）。
- AA 先用 clientMessageId 写入用户消息条目，再发 prompt；Agent 回显的 `user_message_chunk` 不再落条目。
- 插话（`_session/steering`）：`injected` 写入用户消息条目；`startedNewTurn` 表示 Agent 已空闲并开了新回合；`promptRequired` 表示调用方应改用 prompt 或放回队列；确定的错误为 rejected，超时、断线为 unknown，同样不重发。Hermes 的 `/steer` 命令 30 秒内没有确定结果时为 unknown。
- 回合外出现内容更新时，Connector 记为 Agent 自主开启的回合；Claude 以带 `cost` 的 `usage_update` 结束它，其它 Runtime 在 30 秒没有更新后结束。

## 6. 身份规则

- Runtime 类型字符串与 v2 的 `runtime_type` 完全一致（`codex`、`claude`、`hermes`、`opencode`、`antigravity`、`codebuddy`、`commandcode`、`mimo`、`minimax`），它是会话 ID 与 Timeline ID 的输入。
- Timeline 条目 ID 沿用 v2 规则，`connector-ts/src/domain/identity/` 必须通过 `contracts/identity-vectors/1.0` 的全部向量：
  - 通用 ACP：`_meta.aa.timelineItem` 优先；可信的 `messageId` / `toolCallId` 得到跨连接稳定的 ID；否则 ID 只在本次连接内稳定，不跨回放合并。AA 发出的用户消息为 `[会话 ID, "user_message_chunk", clientMessageId]` 的指纹。
  - Codex：带 clientMessageId 的用户消息用「线程 + clientMessageId」；其余按「线程 + Codex turn + lane + lane 内位置」；不按位置计数的类型用原生条目 ID。实时更新与 `_codex/session/read` 历史走同一算法；历史整体替换开始时位置计数清零。
  - Claude：沿用 v2 Claude 规则，只读历史直接读本机 JSONL（不经 `session/load`，它会往 JSONL 追加记录）。

## 7. 与 1.x 的差别

- **1.0 的 schema 不再随 2.0 发布。** 配置快照改为 `RuntimeSession` 端口的配置项，对外经 `protocol` 1.2 发布；表单回答直接使用 ACP `elicitation/create` 的 `{action, content}`；来源回放替换由 Codex 的 `_codex/session/history_reset`（begin → 全量重放 → commit / abort）实现，Connector 内部发出 `history.reset` 事件。1.0 继续描述 v2 Connector。
- **1.1 的 `_aa/operate`、`_aa/read_history`、`_aa/observe`、`_meta.aa.unavailableCapabilities` 在 v3 Connector 中没有实现。**
  - `_aa/read_history` → 各方言的只读历史：Codex 用 `_codex/session/read`，Claude 读本机 JSONL，其它 Agent 用 `session/load` 捕获回放，Agent 支持时再 `session/close`。
  - `_aa/operate` 的配置、命令、插话、计划、目标等写操作 → `RuntimeSession` 端口方法，背后是标准 ACP 或第 2 节登记的扩展。操作身份与「结果未知不重发」由 `contracts/device-meshcall/1.0` 的 Commands（`commandId` 幂等、`command_outcome_unknown`）承担，ACP 层不再有 `operationId` / `expectedGeneration`。
  - `_aa/observe` 没有对应实现。
  - `_meta.aa.unavailableCapabilities` 不再读取：能力只来自 initialize 协商和方言声明（第 3 节）。
- **1.1 的平台 API**（`/api/v2/runtime-workflows/sessions/{id}/configuration`、`/operations`、`/tree`、`/position`、`/close`、`/recover`）属于 `runtime-workflows` 契约，2.0 不再描述。v3 Connector 在设备上实现它们（`contracts/device-meshcall/1.0` 的 `session.configuration.update`、`session.agent.operate`、`session.position.select`、`session.close`、`session.recover` 命令）：Agent 操作和会话树交给声明了对应能力的 `RuntimeSession.operate`，目前只有 Pi 提供 `authentication.status`、`resources.get`；没有 Agent 声明会话树（`session.execution_position.*`），这两个接口答 409 `capability_unavailable`。`ownerGeneration` 是会话当前的原生会话 ID。
- **保留**：`_meta.aa.timelineItem`、`_meta.aa.guarantees` 的 `stable_native_identity`；新增 `_meta.aa.selectionCategory` 的登记（v2 已在使用）。
- **新增**：协议版本协商规则、第 2 节的扩展注册清单、第 3 节的能力映射表、第 5 节的接纳语义。

## 8. 待定

以下内容在设计文档（`04-connector.md` §5）里出现，但 v3 Connector 还没有实现，本契约不把它们列为已注册扩展。实现时再登记进第 2、3 节和 `registry.json`：

- **ACP v2**：所有方言仍声明 `protocolVersion: 1`，v2 下哪些字段改走标准能力尚未确定。
- **Codex 伴随层**（实现在 #725，等它合入后登记）：
  - `_codex/session/inspect`、`_codex/ipc/sessions`；
  - Windows 写锁判定为 unknown 时改用不带 `codexIpc` 的普通加载；
  - codex-acp 在 initialize 顶层声明 `_meta.localImageLinks.supported`（anywhere-labs/codex-acp#9），没声明时 Codex 的 `runtime.attachment` 报不支持；
  - 端口能力 `runtime.owner_release`（释放外部持有者，例如退出 Codex App；两步，会话层确认）与 `runtime.app_open`（在桌面应用里打开原生会话），只在本机装有 Codex App 时声明支持，以 `open-in-codex-app`、`quit-codex-app` 斜杠命令提供给客户端；
  - codex-acp 的自动审查工具调用（`guardian_assessment:<reviewId>`）投影为时间线通知，不作为工具卡片。
  - `_meta.codexIpc.mode` 的 `follow` / `daemon` 没有用到。
- **会话目录扩展**：`_session/list/subscribe`、`_session/list/changes`、`_session/archive`、`_session/rename`；对应的 `session.archive`、`session.rename` 能力。
- **DSH**：`_dsh/session/turn`、`_dsh/session/continue`、`_meta.dsh.delivery` 等（`contracts/dsh-bridge/3.0`），Connector 侧尚无 DSH Profile。
- **Pi**：Profile 在 #706（经 pi-acp 驱动，另有 SDK bridge），本契约还没有登记它的 `_meta.pi` 守卫与接纳证据；1.1 的恢复与早期回执保证是否保留待定。
- **路由切换**：ACP 核心的回合间释放与整路由交接（#740）是 Connector 内部机制，不新增 ACP 扩展。用到的错误码 `runtime_route_switching`，以及「已接纳回合中途断开 → `details.outcome: unknown`」，要登记进 runtime-errors。
- **Claude**：定时任务与 `/loop` 需要的 AIR `asyncTasks` 尚未声明；自主回合目前靠「回合外内容」与带 cost 的 `usage_update` 识别。
- **能力**：`catalog.effort` 未输出；`session.queue` 由 Connector 在 ACP 之外实现，由哪一层声明尚未定。
