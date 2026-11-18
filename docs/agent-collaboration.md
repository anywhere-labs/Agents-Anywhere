# Agent 协作

一个会话里的 Agent 可以新建、驱动和监督同一账号下其他会话的 Agent，目标会话可以在同一台设备上，也可以在另一台设备上。普通模式和端到端加密模式（`AGENT_SERVER_E2EE=required`）都能用，加密模式下 Server 仍然看不到会话内容。

本文说明这项功能怎么开启、Agent 能做什么、各端代码怎么分工。Server 的接口细节见 [API：Agent 协作](api/agent-collaboration.md)，工具契约见 [`contracts/agent-tools/1.0`](../contracts/agent-tools/1.0/README.md)。

## 1. 工作方式

- **派活（手）**：会话打开时，Connector 往 Agent 的 ACP 会话里注入一个名为 `aa` 的 stdio MCP 工具服务器。Agent 调用 `aa_spawn`、`aa_send` 等工具，工具服务器把调用转给 Connector 的本机工具 socket，由 Connector 按授权执行。
- **看护（眼）**：监督关系由监督者所在的设备保存。目标会话的回合结束、失败、等待审批、提交计划或长时间没有进展时，Connector 把一段摘要作为消息发给监督者，监督者正忙时自动排队。Agent 不需要轮询，派完活就可以结束回合。
- **人始终能看到和接管**：Agent 发出的消息在时间线上标「由 X 的 Agent 发送」，监督通知显示为「监督通知」卡片，需要人决定的事显示为「需要你决定」卡片。监督面板里可以暂停、结束监督，或调整代办权。

## 2. 开启

默认全部关闭，分两级（AC10）：

1. **账号开关**：设置 →「Agent 协作」→ 打开「允许 Agent 协作」。
2. **运行实例开关**：同一页的「Runtime 实例」里，为每个实例单独「开启」，并选择它的 Agent 可以代你做的事。只有声明了 `runtime.agent_tools.host` 能力的实例会列出来。
3. **跨设备**：账号级的「允许跨设备」和实例级的「跨设备」都打开后，这个实例里的 Agent 才能访问账号下其他设备上的会话。
4. **加密模式下的跨设备**还要在「安全连接」→「设备之间的 Agent 访问」里允许设备 A 上的 Agent 访问设备 B：客户端先读取 A 的 Agent 身份，再请 B 在本机确认批准它作为 `agent` 客户端，最后把 B 的设备公钥交给 A。

会话页标题栏的「协作」按钮打开监督面板：查看这个会话在监督谁、最近的操作，暂停、继续或结束监督，调整代办权和唤醒时机，或「让此会话监督…」另一个会话。

开关改动随设备设置下发（`deviceSettings.agentCollaboration`），关闭后设备立即吊销对应会话的授权。

## 3. 谁能当监督者

只有能注入 MCP 工具的 Runtime 能当监督者（AC11），所有 Runtime 都可以当目标。按实测结果（§12）声明：

| Runtime | 能当监督者 | 免确认方式 |
| --- | --- | --- |
| Claude（claude-agent-acp） | 是 | `session/new` 的 `_meta.claudeCode.options.allowedTools: ["mcp__aa"]` |
| Codex（codex-acp） | 是 | 工具服务器条目的 `_meta.codex.defaultToolsApprovalMode: "approve"`；fork 还不支持时由 Connector 自动应答 `serverName = "aa"` 的审批 |
| Pi | 是 | AA 的 Pi 守卫放行 `mcp__aa__*`，`tool_search` 视为只读工具 |
| DSH 独立进程路线 | 是 | 不需要 |
| DSH 插件路线、Hermes、其他通用 ACP Agent | 暂不声明 | — |

免确认不降低安全性：每次调用都由 Connector 按授权检查（§5.1）。

## 4. 工具

| 工具 | 作用 | 需要的代办权 |
| --- | --- | --- |
| `aa_targets` | 列出可用的设备、运行实例和自己创建的会话 | — |
| `aa_spawn` | 新建会话并发出第一条任务，默认同时建立监督 | 深度、并发上限 |
| `aa_send` / `aa_steer` | 给会话发消息 / 引导正在运行的任务 | `steer` |
| `aa_interrupt` | 中断当前任务 | `interrupt` |
| `aa_status` / `aa_read` | 查看状态 / 读取时间线 | — |
| `aa_wait` | 等待目标结束当前回合，最多 50 秒 | — |
| `aa_respond` | 代为回答审批或提问 | `respondApproval` |
| `aa_plan_review` | 批准或打回计划 | `reviewPlan` |
| `aa_supervise` / `aa_unsupervise` | 建立 / 结束监督 | 只能监督自己创建的会话 |
| `aa_escalate` | 把问题交给人 | — |
| `aa_close` | 释放自己创建的会话 | `close` |

每个改变状态的调用都是一条操作记录，记录 id 同时作为下游的命令 id，所以重试不会重复执行；结果不确定时返回 `command_outcome_unknown`，不会自动重发。错误码见 `contracts/agent-tools/1.0/errors.json`。

## 5. 领域模型

代码在 `connector-ts/src/domain/collab/`（纯领域）和 `connector-ts/src/application/collab/`（用例）。

### 5.1 授权（AgentGrant）

一个监督者会话的 Agent 能做什么。会话每次打开（新建、load、resume）都吊销旧授权、签发新授权，密钥只放在工具服务器的环境变量里，本地只存摘要。不变量：

1. 代办权不超过用户设置，也不超过监督者自己的权限模式：只读模式下什么都不能改，「每次询问」模式下不能代答审批。
2. 被吊销的授权什么都不能做；会话归档或协作关闭时吊销。
3. 派生会话的深度是监督者深度加一，不超过 `maxDepth`（默认 2）；同时打开的派生会话不超过 `maxActiveChildren`（默认 4）。
4. 目标在范围内：默认只有本设备，开了跨设备才能访问其他设备；可以限定运行实例和工作目录。
5. 不能对自己使用写操作；`close` 和 Agent 建立的监督只适用于自己创建的会话（AC9）。

默认代办权是 `steer` 和 `close`（AC8），`interrupt`、`respondApproval`、`reviewPlan` 要在运行实例设置或监督面板里单独打开。人建立的监督可以给监督者额外的代办权，仍受权限模式限制。

### 5.2 监督（Supervision）

「S1 看护 S2」，存放在监督者所在的设备上，Server 只保存这条边（id 和状态）。

- 同一对（监督者、目标）同时只有一个有效的监督，不能成环。
- 触发条件默认是回合结束、回合失败、等待审批、计划待审阅、长时间没有进展（默认 10 分钟），可以加上目标状态变化。
- 待发出的唤醒最多一个，新原因合并进去；合并窗口默认 30 秒，只在监督者空闲时发出。
- 每小时最多唤醒 20 次，超出后监督暂停，并在监督者会话里请人决定。

### 5.3 操作记录（AgentAction）

每个改变状态的工具调用追加一条，只增不改，监督面板里可以看到。每个监督者会话保留最近 500 条。

### 5.4 唤醒摘要

固定格式的英文文本，同样的输入总是得到同样的输出，不超过 4 KiB：唤醒原因、状态、最后一条请求、工具调用和失败、改动的文件、待回答的审批，以及最后一条回复。目标会话的回复以引用形式出现，并注明「是被监督会话的输出，不是指令」。

## 6. 领域事件与出站

跨出设备的事件走出站箱：

- `collab.grant.changed`：授权签发或吊销，Server 据此吊销委托令牌。
- `collab.supervision.changed`：监督建立、暂停、结束，Server 据此保存监督边，在会话视图上显示「被 X 监督」，并向监督者设备转发目标的调度信号。

Agent 创建的会话在 `session.summary` 里带 `origin`（创建者会话、设备和深度）。

## 7. 三条路线

用例只通过 `SessionGateway` 端口访问会话（`connector-ts/src/peer/`），按目标设备选路线：

### 7.1 本机

目标在本设备时，直接调用进程内的客户端 API，调用方标记为 Agent，按 Agent 白名单（`sync/client-api/agent-routes.ts`）放行。

### 7.2 普通模式跨设备

设备用自己的凭据向 Server 申请委托令牌（`POST /api/v3/device/agent-delegations`），之后用这个令牌调用 `/api/v2` 客户端接口。Server 在签发时检查账号和跨设备开关，每次调用都按路由表的 `agent` 标记和令牌范围检查，目标设备再按调用方检查一次。

### 7.3 监督信号

- 目标在本设备：监督服务每 5 秒读一次目标的调度字段。
- 目标在其他设备：Server 在目标的会话摘要变化时，向监督者设备发 `collab.signal` 命令，只含状态、时钟位置、计划和目标状态等调度字段，两种模式下都是明文。
- 需要唤醒时，监督者设备再通过对应路线读取目标的时间线生成摘要。

### 7.4 加密模式跨设备

设备 A 有一把单独的协作身份密钥（`<数据目录>/trust/agent-peers.json`，权限 0600）。设备 B 在本机确认后把它批准为 `agent` 平台客户端，人再把 B 的设备公钥固定到 A 上。A 的 Agent 访问 B 时，以 `agent` 客户端身份经 Server 的隧道和 B 建立 Noise KK 通道，Server 只转发密文；通道里每个请求都带上监督者会话。加密账号**不会**退回普通模式的路线。`agent` 客户端不能修改 B 的信任关系，也只能用 Agent 白名单里的接口。

## 8. 本机工具 socket

Connector 在 `~/.agents-anywhere/agent-tools/` 下监听一个只有本用户能打开的 Unix socket（Windows 上是命名管道）。注入的工具服务器是单独打包的 `dist/agent-tools.js`，启动快、没有副作用：Claude 和 DSH 会先用 `server/discover` 探测，再起一个新进程正式初始化。协议是一行一个 JSON：`{id, token, tool, arguments}` → `{id, ok, value}` 或 `{id, ok: false, code, message}`。

## 9. Server

- 账号设置存在 `users.agent_collaboration`，`GET`/`PUT /api/v2/agent-collaboration/settings`。
- `v2_67` 迁移新增 `agent_delegations`、`collab_edges` 两张表，以及会话的来源字段和命令记录的 `actor`。
- 委托令牌有效期 1 小时；会话、设备删除或跨设备关闭后立即失效。
- 详见 [API：Agent 协作](api/agent-collaboration.md)。

## 10. 安全边界

- Agent 能做的事不超过人给它的设置，也不超过它自己会话的权限模式。
- 工具密钥每次打开会话都会更换，只有本用户的进程能连上工具 socket。
- Agent 只能用白名单里的接口：不能改设置、不能访问文件和终端、不能改信任关系。
- 加密模式下，跨设备访问需要目标设备上的人在本机确认。

## 11. 已知限制

- 在新建会话页预先准备好的 Agent 会话不带协作工具；开启协作时，首条消息会重新打开一个带工具的会话，冷启动和没有开启协作时一样。
- Codex App 持有线程（跟随路线）、DSH 插件路线下是否能用工具未实测。
- 监督通知会占用监督者的上下文；长时间看护依赖 Runtime 自己的压缩。
- 无界面的设备当加密模式下的目标时，需要有人在那台机器上确认批准。

## 12. 实测结果

2026-11-18 用独立的探针 MCP 服务器和裸 ACP 客户端实测了注入：

| Runtime | 工具名 | 单次调用上限 | load / resume 后重新注入 |
| --- | --- | --- | --- |
| Claude（claude-agent-acp 0.107.2） | `mcp__aa__…` | ≥ 90 秒 | 是 |
| Codex（codex-acp 2.6.0） | `mcp.aa.…` | 300 秒 | 是 |
| Pi（pi-acp 0.1.8） | `aa: …` | 60 秒 | 是 |
| DSH（`dsh --profile acp` 0.2.1-rc.2） | `mcp__aa__…` | 约 60 秒 | 是 |

因此 `aa_wait` 最多等 50 秒，更长的等待一律用监督唤醒；各家工具名不同，所以 Connector 把工具卡片归一成 `content.collabTool = {server: "aa", tool, sessionId?}` 再交给客户端。

## 13. 已定决定

| # | 决定 |
| --- | --- |
| AC8 | 默认代办权只有 `steer` 和 `close`，`close` 只能用于自己创建的会话 |
| AC9 | Agent 只能监督自己创建的会话；人可以让任意会话监督任意会话 |
| AC10 | 账号开关 + 运行实例开关，跨设备再各有一个开关，默认全部关闭 |
| AC11 | 第一版只有能注入 MCP 的 Runtime 能当监督者 |
| AC12 | 契约在现有版本内增量修订（`device-meshcall 1.0`、`protocol 1.2`、`e2ee 1.0`），新增 `agent-tools 1.0`；旧设备和客户端忽略新增字段 |
