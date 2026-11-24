# Agents Anywhere v3 Connector

v3 的工作设备进程（TypeScript，Node ≥ 22）。它在本机运行任意 ACP Agent（Claude Code、Codex 等），把会话、终端、文件和 git 作为 MeshCall 服务挂到 Router 上，供 Desktop / Web / 手机客户端和 v3 控制面调用。会话数据只保存在这台设备上，控制面不保存会话内容。

设计依据：

- [v3 架构提案](../docs/v3/architecture-proposal.md)
- [设备级端到端加密准入方案](../docs/v3/e2ee-admission-proposal.md)
- [终端方案](../docs/v3/terminal-proposal.md)（控制权、屏幕快照、断线续传）
- 契约：[`contracts/aa-v3/1.0/control.schema.json`](../contracts/aa-v3/1.0/control.schema.json)、[`pairing.schema.json`](../contracts/aa-v3/1.0/pairing.schema.json)、[`terminals.schema.json`](../contracts/aa-v3/1.0/terminals.schema.json)
- 会话数据模型：[`v3poc/protocol/timeline.ts`](../v3poc/protocol/timeline.ts)、[`services.ts`](../v3poc/protocol/services.ts)

## 架构

```
src/
  core/                 可移植（无 Node 内置模块），也可用于 WebView
    config.ts           设置、配对客户端、ACP 预设和每个 Agent 的本机设置的形状与校验
    timeline.ts         aa.v3 会话模型（Session / Message / Control / WatchEvent）
    session-store.ts    内存会话库：唯一的会话真相来源，watch 推送整值替换
    acp-protocol.ts     ACP 类型与 AcpTimelineProjector（session/update → 时间线）
    gate.ts             DeviceGate：配对、允许名单、每次业务调用的准入判断
  runtime/              Node 侧实现
    state-store.ts      数据目录里的 identity / settings / paired-clients / sessions / agents（原子写入，0600）
    device-ops.ts       文件、目录、git、附件（有上限、不走 shell）
    terminal-manager.ts 终端：PTY（可选原生依赖）或管道、无界面屏幕模拟器、输出序号、控制权
    acp-host.ts         通用 ACP 宿主：每个会话一个 Agent 进程，stdio 行分隔 JSON-RPC 2.0；重启 Agent 时恢复它的上下文，回收空闲进程
  rpc/                  MeshCall 服务（targeted，instance = 设备 id）
    device-admin-service.ts  aa.v3.DeviceAdmin：ping / close_tunnel_sessions / check_update / rename
    sessions-service.ts      aa.v3.Sessions
    device-service.ts        aa.v3.Device
    terminals-service.ts     aa.v3.Terminals（attach 为 duplex，按调用方身份判定控制者）
  host/
    control-client.ts   控制面 HTTP（register / router-token）、presence 流、推送
    connector-host.ts   ConnectorHost：装配上面所有部分，负责挂载、模式切换、重连
  index.ts              库入口（Desktop 嵌入用）
  cli.ts                aa-connector 命令行
```

### 两种设备模式

| | 普通模式 `normal` | 加密模式 `encrypted` |
| --- | --- | --- |
| 控制面直接调用业务服务 | 允许（`aa-via: client`） | 拒绝（`e2e_peer_required`） |
| MCP（`aa-via: mcp`） | 默认关闭，`aa-connector mcp on` 后允许 | 永远拒绝 |
| 普通隧道 | 允许 | 拒绝（`tunnel_rejected`） |
| E2E 隧道 | 允许（已配对客户端可用 IK） | 只接受已配对客户端（Noise_IK / 首次配对 Noise_IKpsk2） |
| `aa.v3.DeviceAdmin` | 控制面可直接调用 | 控制面可直接调用（不含任何内容） |
| presence 上报 | 带 `summary`（runtimes、活跃会话数、待审批数） | 不带 `summary`，带 `e2e_public_key_hint` |
| 推送 | 带会话 id、标题、正文 | 本地就去掉会话 id、标题、正文，只发事件类型 |

每个业务方法的第一行都是 `gate.assertBusinessCallAllowed(ctx)`；加密模式下 MeshCall 层还会用 `requireE2E` + `requireE2EPeer` 先挡一次。

**模式切换**（e2ee 提案 §7）：先停止所有 Router 上的服务、断开现有隧道连接和所有 watch，再写入 `settings.json`，最后按新策略重新挂载。切到加密模式时，设备门在停止服务之前就已改为加密，中间不会有调用漏过去。从加密改回普通会让控制面看到内容，命令行需要 `--yes` 确认。

### Sessions 的线协议兼容

`aa.v3.Sessions` 同时接受 v3poc 客户端和 `server-v3` MCP 工具的写法：

| MCP 工具 | 调用 | 说明 |
| --- | --- | --- |
| `read_session` | `list_messages({ session_id, cursor?, limit? })` | 返回 `next_cursor` 用于翻页 |
| `create_session` | `create({ agent, cwd, title? })` | |
| `send_message` | `send({ session_id, text, wait? })` | `wait: true` 时等本轮结束并返回 `reply_text`；消息作者记为 `mcp:<客户端名>` |
| `stop_session` | `stop({ session_id })` | |
| `answer_approval` | `answer({ session_id, approval_id, decision })` | `approve` 选第一个 `allow_once`/`allow_always`，`reject` 选第一个 `reject_once`/`reject_always` |

可选字段都接受 `null`（Python 控制面把缺省值发成 `null`）；`list` 和 `DeviceAdmin/ping` 的返回值与 `server-v3` 的 `extra="forbid"` 模型完全一致。

会话忙时，新消息进入 `control.queued`，本轮结束后自动发送；`delivery: "steer"` 或 `steer_queued` 会中断当前轮次并让该消息排到下一个（ACP 没有原生的轮内插话）。

### 新对话：预先启动 Agent（`prepare`）

新对话页选好设备、Agent 和目录后，客户端调用 `prepare`：Connector 马上启动这个 Agent（`initialize` + `session/new`），把模型、模式（权限）、推理强度等配置项交给客户端，用户在发第一条消息前就能选，第一次 `npx` 下载也发生在用户打字的时候。发送时 `create` 带上 `prepared_id`，接管这个已经启动的 Agent。

| 调用 | 请求 | 响应 / 行为 |
| --- | --- | --- |
| `prepare` | `{ agent, cwd? }`：`cwd` 的解析（默认 `~`）、目录校验和准入都与 `create` 相同 | `{ prepared_id, agent, cwd, config, expires_at }`：`cwd` 是解析后的路径；`config` 与 `Session.config` 同形，可以直接交给配置选择器；`expires_at`（RFC 3339）之前没被接管、也没再次 `prepare`，Agent 就会被关闭 |
| `create` | 新增可选 `prepared_id` | 预热的 Agent 属于同一 `agent`、同一 `cwd` 且没过期时直接接管：不再起进程、不再 `session/new`，预热期间 Agent 发来的 `session/update`（斜杠命令、配置变化等）回放进会话，然后照常应用 `config`。`prepared_id` 不存在、已过期、Agent 已退出或 `agent` / `cwd` 不匹配时，按原流程新起 Agent，不报错 |

- 同一 Agent、同一目录只有一个预热 Agent：再次 `prepare` 返回同一个 `prepared_id` 并重新计算过期时间（新对话页停留较久时可以用它续期）；正在启动时，并发的 `prepare` 共用同一次启动。第一次 `npx` 启动可能要几分钟，调用超时后再调一次 `prepare` 就会接上还在进行的那次启动。
- 新对话的设置：每个 Agent 最近一次新建对话时用的设置（模型、模式、推理强度等，`create` 结束时的值）记在数据目录的 `last-session-config.json` 里。`prepare` 返回前先把预热的 Agent 设成这些值，`create` 也先套用它们，再应用请求里的 `config`；Agent 已经不提供的值跳过。没有单独的「新对话默认选项」设置，客户端也不再自己记。对话之后再改的设置不算，只认新建时的。
- 生命周期：空闲超过 TTL（默认 10 分钟，从 Agent 就绪或上一次 `prepare` 算起）关闭；每台设备最多保留 4 个，超出时关闭最久未用的（正在启动的不会被挤掉）；Connector 停止时全部关闭，正在启动的 `prepare` 返回 `agent_start_failed`。两个上限可以用 `ConnectorHost` / `AcpRuntimeHost` 的 `preparedTtlMs`、`maxPrepared` 调整。预热的 Agent 只在内存里，Connector 重启后旧的 `prepared_id` 失效，`create` 会按原流程启动。
- 接管之前没有会话：Agent 发来的权限请求一律回答 `cancelled`，读写文件请求照常按 `cwd` 处理。
- 启动失败时 `prepare` 直接返回错误，`create` 遇到同样的失败也返回同样的错误（`details.agent` 是 Agent id）：

| `details.reason` | 错误码 | 含义 |
| --- | --- | --- |
| `unknown_agent` | `invalid_argument` | 这台设备上没有这个 Agent |
| `invalid_cwd` | `invalid_argument` | `cwd` 不是这台设备上的目录 |
| `agent_auth_required` | `failed_precondition` | Agent 要求先登录（ACP `-32000`，消息如 `could not start Claude Code: Authentication required`）；`details.auth_methods` 是 Agent 在 `initialize` 里给出的登录方式（`id`、`name`、`description`） |
| `agent_start_failed` | `unavailable` | 程序不存在、启动后退出、超时或应答无法使用；消息形如 `could not start <Agent>: …` |

### 终端（`aa.v3.Terminals`）

设计见[终端方案](../docs/v3/terminal-proposal.md)，帧格式见 [`terminals.schema.json`](../contracts/aa-v3/1.0/terminals.schema.json)。

- **PTY**：默认用可选依赖 `@lydell/node-pty`（各平台预编译包）启动 shell，`TERM=xterm-256color`，改尺寸会真正下发到 PTY。它在第一次创建终端时才加载；加载或启动失败时退回 `script`（Linux 且装有 util-linux `script`）或 `pipe`（`TERM=dumb`），实际模式写在 `TerminalInfo.mode` 里。`pipe` 模式的输出是裸 `\n`，客户端渲染实时输出时应打开 xterm.js 的 `convertEol`（快照里已经是 `\r\n`）。
- **第一帧是屏幕快照**：每个终端有一个 `@xterm/headless` 模拟器，接收全部输出，保留 1000 行历史。`attach` 的第一帧是序列化的屏幕（含全屏程序的备用屏、光标位置和终端模式），快照带上它已包含到的 `seq`，之后是快照之后缓冲的输出和实时输出，不重不漏。
- **序号与续传**：输出块从 1 开始编号，保留最近约 1 MiB。`attach` 带 `resume_seq` 且后面的输出都还在缓冲区里时只补发缺的块，不发快照；否则发快照。积压超过 4 MiB 的连接会被断开，重连后从快照开始。
- **控制者**：每个终端最多一个控制者，其他连接只读。`claim` 帧立即接管，控制代数 `generation` 加一；`attach` 的 `mode: "control"` 不抢控制权，只在没有控制者、或当前控制者（在线或在宽限期内）的 `client_id` 与调用方相同时才成为控制者（这时才应用 `attach` 的 `cols/rows`），否则按旁观者加入；`input` / `resize` 必须来自控制者的这条连接并带上当前代数，否则丢弃并回一次 `rejected`（每条连接每代最多一次）。控制者的连接断开后保留 10 秒（`connected: false`），期间重新接管会恢复控制；超时后清空控制者（代数加一），尺寸保持不变。每次控制者、代数或尺寸变化都会给所有连接发 `control` 帧（`you` 表示这条连接是不是控制者）。
- **调用方身份**（`client_id`）：端到端加密的调用是 `e2e:<客户端公钥>`，名称取本机配对记录；普通隧道是隧道 `principal`，名称取 `attach` 里的 `label`；临时 token 的调用取 token principal，其余（控制面、MCP）是 `control`。
- **一元 `resize`**：没有连接可以带代数，所以只在调用方身份等于当前控制者的 `client_id` 时执行，否则返回 `failed_precondition`（`details.reason = "not_controller"`）。正常客户端应在 `attach` 流里发 `resize` 帧。
- `owner` 目前都是 `user`；`agent`（ACP `terminal/create` 创建的终端，所有人只读）已预留，对它的 `claim`、`input`、`resize` 都会被拒（`agent_owned`）。

### Agent 管理（`agents` / `update_agent` / `stop_agent`）

设备页列出这台设备上的每个 Agent：开关、运行状态和停止按钮，以及设置对话框（权限控制、空闲后关闭进程、命令、参数、环境变量、恢复默认）。三个方法都在 `aa.v3.Device` 上。

| 调用 | 请求 | 响应 / 行为 |
| --- | --- | --- |
| `agents`（只读） | `{}` | `{ agents: AgentEntry[] }`：每个已注册的 Agent 一项（内置预设和配置的预设，关闭的也在内），顺序与 `status.runtimes` 相同 |
| `update_agent`（幂等） | `{ id, enabled?, approvals?, idle_close_minutes?, command?, args?, env?, reset? }` | 修改后的 `AgentEntry` |
| `stop_agent`（不可撤销，幂等） | `{ id, force? }` | `{ stopped }`：停掉的 Agent 进程数 |

`AgentEntry`：

| 字段 | 含义 |
| --- | --- |
| `id` | Agent id |
| `name` | 预设的名称，即 Agent 的产品名（`--presets` 配置的预设用它自己的 `name`） |
| `builtin` | 是不是 Connector 自带的默认预设（`--presets` 配置的为 `false`） |
| `enabled` | 开关 |
| `command`、`args` | 现在启动会用的命令和参数（含本机的修改） |
| `env_keys` | 为它额外设置的环境变量的名字；值不离开设备 |
| `customized` | 命令、参数或环境变量与预设不同（开关不算） |
| `running` | 正在运行的 Agent 进程数：进程在跑的会话 + 预热的 + 正在启动的 |
| `busy` | 正在执行一轮的会话数（包括 Agent 还在启动的） |
| `approvals` | 只有 AA 能为它加上审批的 Agent（Pi）才有：权限控制是否打开 |
| `idle_close_minutes` | 对话的 Agent 进程空闲多少分钟后关闭；`0` 表示不自动关闭（默认） |

`update_agent`：

- 不给或为 `null` 的字段保持不变，其他字段和所有请求一样被忽略。`command` 不能为空（去掉首尾空白），`args` 是字符串数组（最多 256 个，可以有空字符串）；命令、参数和环境变量的值都不能含 NUL。
- `env`：值为字符串时设置该变量，为 `null` 时删除。变量名须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`，每个 Agent 最多 128 个。这些变量加在 Connector 自身的环境之上传给 Agent，删不掉 Connector 进程继承来的变量。
- `reset: true`：先丢掉对命令、参数和环境变量的修改（回到预设），再应用同一次调用里的其他字段。`reset` 不改开关、权限控制和空闲关闭时间，要同时打开就一起传 `enabled: true`。
- `idle_close_minutes`：`0`–`10080` 的整数，`0` 表示不自动关闭。立即生效：已经空闲的进程按新时间重新计时。见「恢复 Agent 的上下文，回收空闲进程」。
- `approvals`：只对预设带 `approvals` 的 Agent 有效（内置的 Pi），其他 Agent 返回 `failed_precondition` / `approvals_unsupported`。打开时先在 Pi 的全局扩展目录（`$PI_CODING_AGENT_DIR/extensions`，默认 `~/.pi/agent/extensions`）写入 `agents-anywhere-approvals.js`，关闭时删除它，写入或删除失败则整个修改不生效（`approvals_extension_failed`）。同名但不是 AA 写的文件不会被覆盖或删除。详见下面的「Pi 的权限控制」。
- 改回与预设相同的值等于没改：`customized` 为 `false`，这一项也不再保存。
- 修改先写入数据目录的 `agents.json`（0600，目录 0700），写入失败则整个修改不生效。环境变量的值只保存在这个文件里，不会出现在任何 RPC 的返回（包括 `get_settings`）、日志或推送里。
- **只影响之后启动的 Agent 进程**：正在运行的保持原来的设置，直到被停止（`stop_agent`）、空闲回收或自己退出。命令、参数或环境变量变了（或被关闭）的 Agent，它的预热 Agent 会被关闭，下一次 `prepare` 按新设置启动。

关闭的 Agent（`enabled: false`）：

- 不出现在 `status.runtimes` 和 presence 上报的 runtimes 里，客户端不会再提供它；`agents` 里仍然列出。
- `prepare`、`create` 返回 `failed_precondition` / `agent_disabled`。已有会话的新一轮（`send`、`compact`、`steer_queued`、带 `content` 的 `rewind`）也这样拒绝，不会悄悄把 Agent 再启动起来；排队的消息留在队列里，重新打开后由下一次发送或 `steer_queued` 继续。
- 关闭不会停掉正在运行的进程和正在执行的一轮，需要时再调用 `stop_agent`。

`stop_agent`：

- 停掉这个 Agent 的所有进程：会话的 Agent、预热的和正在启动的。会话都保留，下一条消息按那时的设置重新启动 Agent。支持恢复的 Agent（四个内置 Agent 都支持）会重新打开原来的 ACP 会话，带着之前的上下文继续；会话的设置（模型、模式等）保持对话里的值。与 Connector 重启后一样，见下面的「恢复 Agent 的上下文，回收空闲进程」。
- 有会话正在执行一轮时，不带 `force` 返回 `failed_precondition` / `turns_running`（`details.count` 是这样的会话数）。带 `force: true` 时先像 `aa.v3.Sessions/stop` 那样取消这些轮次（排队的消息等下一次发送），给 Agent 3 秒正常结束，再停掉进程；到时还没结束的轮次和 Agent 还在启动的轮次都记为取消（`cancelled`），不算出错。
- 重复调用只会停掉之后又启动的进程，没有可停的时返回 `{ stopped: 0 }`。

**谁可以调用**：`update_agent` 会让设备运行调用方指定的程序，`stop_agent` 会中断会话，所以两者只接受经隧道连来的客户端：普通设备上的普通隧道，或加密设备上已配对的端到端会话。控制面的直接调用返回 `permission_denied` / `tunnel_required`，MCP 返回 `permission_denied` / `mcp_not_allowed`（MCP 开关关着时，设备门先以 `mcp_disabled_on_device` 拒绝）。`agents` 与 `status` 规则相同：普通设备上控制面和已允许的 MCP 也能读。加密设备上三个方法都只接受已配对的端到端客户端。

| `details.reason` | 错误码 | 含义 |
| --- | --- | --- |
| `unknown_agent` | `invalid_argument` | 这台设备上没有这个 Agent |
| `request` | `invalid_argument` | 字段不合法（MeshCall 的请求校验，`details.violations` 列出字段）；嵌入方直接调用 `ConnectorHost.updateAgent` 时为 `invalid_agent_settings`（`details.field`） |
| `tunnel_required` | `permission_denied` | 控制面的直接调用不能修改或停止 Agent |
| `mcp_not_allowed` | `permission_denied` | MCP 不能修改或停止 Agent |
| `turns_running` | `failed_precondition` | `stop_agent` 时有会话正在执行一轮且没带 `force`；`details.count` 是会话数 |
| `agent_disabled` | `failed_precondition` | Agent 已关闭：`prepare`、`create` 和已有会话的新一轮都被拒绝；`details.agent` 是 Agent id |
| `agent_not_configurable` | `failed_precondition` | 嵌入方用 `registerRuntime` 注册、没有预设的 Runtime 只能开关，不能改命令、参数和环境变量 |
| `approvals_unsupported` | `failed_precondition` | 这个 Agent 没有 AA 能加上的审批（只有 Pi 有） |
| `approvals_extension_failed` | `failed_precondition` | 打开或关闭权限控制时，写入或删除 Pi 的扩展失败；修改没有生效 |

### Pi 的权限控制

Pi 和它的 ACP 适配器都不会在改文件、跑命令前询问，Agent 报的选项里也没有权限。打开 Pi 的 `approvals` 后，AA 用一个 Pi 扩展补上：

- 扩展装在 Pi 的全局扩展目录，Pi 每次启动都会加载它，但只有 AA 启动的 Pi 才有 `AA_APPROVALS_FILE` 环境变量，别的 Pi（用户自己在终端里用的）里它什么也不做。Connector 每次启动 Pi 前都会检查一遍，文件丢了或是旧版本就重新写入。
- 每个对话多一个设置 `aa_approvals`（`category: "mode"`，在输入框的权限按钮里）：`ask`（除了读取都问）、`accept_edits`（改文件也不问，其余都问）、`full_access`（都不问，和 Pi 原本一样）。读取是 Pi 自带的 `read`、`grep`、`find`、`ls`，改文件是 `edit`、`write`；其余一律询问，包括命令，以及扩展和 MCP 服务器加的、AA 不认识的工具（名字说明不了它做什么）。这个设置由 Connector 自己管，不会发给 Pi；它写在每个 Pi 进程自己的模式文件里（数据目录的 `pi-approvals/`，进程退出时删除），扩展在每次调用工具前读一次，所以对话中途切换立即生效。新对话的默认值和其他设置一样，取这个 Agent 最近一次新建对话时的值；第一次是 `ask`。
- 需要审批时，扩展通过 Pi 的扩展界面请求确认，消息里带上这次调用的编号、工具名和参数。pi-acp 会把它转成 ACP 的权限请求，但挂在一个另起的工具调用上；Connector 认出后把请求挂回 Pi 自己那次调用，所以对话里只有一步，审批卡片显示完整的命令或参数，选项和其他 Agent 一样是 `Allow` / `Reject`。别的扩展弹出的对话框原样处理。拒绝时这次调用被拦下，Pi 收到「用户拒绝了」。
- 打开或关闭只影响之后启动的 Pi 进程；关闭时，正在运行的进程立即改为不再询问，对话里的这个设置也随之消失。

### 恢复 Agent 的上下文，回收空闲进程

每个对话都记下它的 Agent 自己的会话 id（ACP `sessionId`，在 `session/new` 之后、`create` 接管预热 Agent 时记下），随对话保存在 `sessions.json` 里，不出现在任何 RPC 返回里。Connector 重启、`stop_agent`、Agent 崩溃或空闲回收之后，对话的下一条消息（或 `compact`）启动 Agent 时，新进程会重新打开这个会话，而不是新开一个：

- Agent 在 `initialize` 里声明了 `sessionCapabilities.resume` 时用 `session/resume`，Agent 不回放历史。
- 否则，或者 Agent 拒绝了 `session/resume`（例如 Antigravity 读不到会话时会建议改用 `session/load`），在声明了 `loadSession: true` 时用 `session/load`。Agent 会先把整个对话作为 `session/update` 重放一遍再应答；这些历史 AA 已经有了，所以在请求完成之前，这个会话的对话内容（用户消息、回复、思考、工具调用、计划）一律丢弃，只保留最新的斜杠命令、配置和模式。`session/resume` 期间也这样处理，以防 Agent 不按规范重放。
- 设置以对话为准：Agent 启动后报告的值与对话里的不同、而 Agent 仍提供对话里的值时，在下一轮开始前改回对话里的值；Agent 不再提供的值放弃，以 Agent 报告的为准。Agent 没能恢复、新开会话时也这样处理。
- 恢复失败（Agent 两种方法都不支持、会话已不存在或 Agent 报错）时，退回 `session/new`：对话照常继续，但 Agent 不带之前的上下文，新会话的 id 取代旧的。Connector 日志里会记一条 warn，写明原因（对话里已有 Agent 的回复时才记）；对话里没有提示，因为时间线现在没有表达这种提示的条目类型。
- 不恢复的情况：`rewind` 之后（Agent 的上下文里有被删掉的消息，而 ACP 不能截断上下文），以及 fork 出来的新对话，都从新的 Agent 会话开始。

四个内置 Agent（Claude Code、Codex、Antigravity、Pi）现在的版本都同时声明了 `session/resume` 和 `session/load`，所以都用 `session/resume`。

**空闲回收**：每个 Agent 可以设置 `idle_close_minutes`（默认 `0`，不回收）。设置了且 Agent 支持恢复（`session/resume` 或 `session/load`）时，对话持续这么久没有在进行的事：没有正在执行的一轮、没有待回答的权限请求、也没有正在进行的设置修改，就关闭它的 Agent 进程。对话保留，下一条消息重新启动 Agent 并恢复上下文；`Device/agents` 的 `running` 相应减少。Agent 在两轮之间自己发来的输出（消息、思考、工具调用、计划）也算有动静，会重新计时；用量报告之类的元数据不算。不支持恢复的 Agent 不回收，和以前一样一直运行到被停止。预热的 Agent 仍按自己的 TTL。没有设置 `idle_close_minutes` 的 Agent 用 `ConnectorHost` / `AcpRuntimeHost` 的 `idleTtlMs`（毫秒，默认不回收，`0` 或 `null` 也表示不回收）。回收中的进程还没退出时来了新消息，新进程会等它退出后再启动，不会有两个进程同时打开同一个 Agent 会话。

## 运行

```bash
cd connector-v3
yarn install
yarn build
```

### 接入 v3 控制面

```bash
# 1. 注册设备（只需一次）。access token 来自控制面登录。
node dist/src/cli.js register --control-url https://aa.example.com --access-token <TOKEN> --name "我的 Mac"
# 加密设备：
node dist/src/cli.js register --control-url https://aa.example.com --access-token <TOKEN> --mode encrypted

# 2. 启动：用设备密钥换取各 Router 的 token，挂载服务，并保持 presence 流
node dist/src/cli.js start
```

### Local-First 模式（内置本地 `meshcall-router`，无需远程控制面）

```bash
# 仅启动本地 Router + Connector（不连云端，断网可用；若已 register 也可同时挂云端 Router）
node dist/src/cli.js start --local-router

# 给本地 Desktop / CLI / 本地 SDK / MCP 签发受控本地 Token
node dist/src/cli.js local-token --principal local:sdk --ttl 3600
```

本地 Router 默认监听 `127.0.0.1` 随机端口（可用 `--local-router-port PORT` 指定），自动在数据目录生成 `0600` 的 `local-router-auth.json`（不开放 `anonymous`）和 `local-router.json`。

### 直连指定 Router（本地测试、外部托管 Router）

```bash
node dist/src/cli.js start --router ws://127.0.0.1:7600
node dist/src/cli.js start --router 'wss://router.example.com#mt_xxx'   # URL#TOKEN
```

直连模式下没有 identity 时会自动生成设备 id 和设备 X25519 密钥。

### 命令

| 命令 | 作用 |
| --- | --- |
| `register` | 在控制面注册设备，保存 `identity.json` |
| `start` | 启动并服务，直到 Ctrl-C / SIGTERM |
| `pair [--code \| --link] [--ttl 秒] [--label 名称] [--platform ios\|android\|desktop\|web\|cli]` | 生成一次性配对码（如 `7KQ2M-X9PTA`，在客户端手动输入）和配对链接 `aa-pair://v1/…`（扫码或粘贴）；`--code` / `--link` 只要其中一种（需要 Connector 正在运行） |
| `mode <normal\|encrypted> [--yes]` | 切换设备模式；运行中会立即安全切换 |
| `mcp <on\|off>` | 「允许外部 Agent 控制」开关（只对普通模式生效） |
| `clients` | 列出已配对客户端 |
| `revoke <client_pub>` | 撤销客户端：它的现有流立即结束，下次握手失败 |
| `status` | 运行状态，或未运行时的本地设置 |

`start` 会在数据目录里监听本地管理 socket（`admin.sock`，0600；路径过长时放在临时目录），`pair`、`mode`、`mcp`、`clients`、`revoke` 通过它操作正在运行的 Connector。没有运行时，后四个命令直接修改状态文件。配对码和配对链接里都带有配对密钥，只能在本机显示（终端或二维码），不能经过服务端。配对码 10 分钟内有效、只能用一次、最多试 8 次，同一时间只有一个；输错不会作废，换一个新码会替换旧码。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `AA_CONNECTOR_DATA_DIR` | 数据目录，默认 `~/.agents-anywhere/connector-v3` |
| `AA_CONTROL_URL` / `AA_ACCESS_TOKEN` | `register` 的控制面地址和登录 token |
| `AA_ROUTER_URLS` | `start` 直连模式的 Router 列表，逗号分隔，`URL#TOKEN` |
| `AA_CONNECTOR_PRESETS` | 额外 ACP 预设的 JSON 文件 |
| `AA_LOG_LEVEL` | `info`（默认）、`warn`、`error`、`silent` |

### Agent 预设

内置预设只在本机装有对应程序时提供（`agents` 里 `builtin: true`）：

| id | 名称 | 命令 | 需要的程序 |
| --- | --- | --- | --- |
| `claude` | Claude Code | `npx -y @agentclientprotocol/claude-agent-acp` | `claude` |
| `codex` | Codex | `npx -y @agentclientprotocol/codex-acp` | `codex` |
| `antigravity` | Antigravity | `agy acp` | `agy` |
| `pi` | Pi | `npx -y @openma/pi-acp --quiet-startup` | `pi` |

其他任何说 ACP（stdio 上的 JSON-RPC 2.0）的命令都可以通过 `--presets presets.json` 加入（id 相同时取代内置预设）：

```json
[{ "id": "my-agent", "name": "My Agent", "command": "my-agent", "args": ["--acp"] }]
```

每个预设的命令、参数和环境变量都可以在这台设备上单独修改，也可以关闭，见上面的「Agent 管理」。

### 数据目录

| 文件 | 内容 |
| --- | --- |
| `identity.json` | 设备 id、设备密钥、控制面地址、设备 X25519 私钥（0600，私钥不离开本机） |
| `settings.json` | 模式、MCP 开关、配对确认、RPC 文件上限、设备名 |
| `paired-clients.json` | 已配对客户端公钥（加密模式的信任名单） |
| `sessions.json` | 会话快照（防抖写入），包括每个对话的 Agent 会话 id（`acp_session_id`，Agent 重启时用它恢复上下文）。旧文件没有这个字段也能照常加载 |
| `agents.json` | 每个 Agent 的开关和本机设置：权限控制、空闲关闭时间、命令、参数、环境变量（0600；环境变量的值只保存在这里）。不认识的键会被忽略；已知的值损坏时 Connector 不启动并指出出错的字段，不会悄悄忽略（否则关掉的 Agent 会重新打开） |
| `last-session-config.json` | 每个 Agent 最近一次新建对话时的设置，新对话从这些值开始 |
| `pi-approvals/` | 打开了权限控制的 Pi 进程各自的模式文件（进程退出时删除） |
| `attachments/<对话 id>/` | 对话没有工作目录或目录不可写时的附件（通常附件在项目的 `.agents-anywhere/attachments/<对话 id>/`） |

## 在 Desktop 中嵌入

```ts
import { ConnectorHost } from "@anywhere-labs/aa-connector-v3";

const host = new ConnectorHost({
  dataDir,
  routers: [{ url: "ws://127.0.0.1:7600" }],      // 或 controlUrl + deviceId + deviceSecret
  onPushEvent: (event) => showNotification(event),
  onPairingConfirm: ({ peerKey }) => askUser(peerKey), // settings.require_pairing_confirm 打开时询问
});
await host.start();
const { uri } = await host.createPairing();        // 在本机显示二维码
await host.switchMode("encrypted");
await host.stop();
```

## 测试

```bash
cd connector-v3
yarn typecheck
yarn test
```

`tests/connector-router-e2e.test.ts` 会启动真实的 Go `meshcall-router`（v0.4.0）和一个用 Node 写的 stdio ACP 模拟 Agent，覆盖：控制面直接调用、MCP 开关、普通隧道上的创建（含 `prepare` 后带 `prepared_id` 创建）/发送/审批/排队/文件读取/终端 attach、两台客户端共用一个终端时的控制权（旁观者输入被拒、接管后旧控制者的输入被丢弃、只有控制者能改尺寸）和 `resume_seq` 续传（终端的帧都按 `terminals.schema.json` 校验）、经 MeshCall 的 Agent 管理（列表、改设置、恢复默认、停止，以及控制面和 MCP 被拒）、`close_tunnel_sessions`、presence 与推送的契约形状、普通 → 加密的安全切换，以及加密模式下的配对（IKpsk2）、陌生客户端被拒、重连（IK）和撤销。Router 二进制按以下顺序查找：`MESHCALL_ROUTER_BINARY`、`../../meshcall/meshcall-router/bin/meshcall-router`、`findRouterBinary()`；都找不到时跳过该测试文件。

`tests/acp-prepare.test.ts` 不需要 Router：用一个记录每次进程启动、`session/new` 和配置修改的模拟 Agent 覆盖 `prepare` 与 `create({ prepared_id })`——配置项的形状、并发共用一次启动、接管同一个进程（没有第二次 `session/new`）并回放预热期间的通知、不匹配 / 过期 / 已退出时退回原流程、TTL 与续期、上限淘汰、启动错误、停止时关闭，以及新对话沿用同一 Agent 最近一次新建对话的设置（预热的 Agent 上已经设好，各 Agent 互不影响，Agent 不再提供的值跳过，记在 `last-session-config.json`）。

`tests/acp-restore.test.ts` 也不需要 Router：模拟 Agent 把会话存成文件，新进程可以重新打开，每次回复都说出它记得的内容。覆盖 `session/resume`、只有 `session/load`（重放的历史不进对话）、Agent 不按规范在 resume 时也重放、两种都不支持（新开会话、记 warn、不回收）、恢复被拒（先 resume 再 load，都失败时新开会话并记 warn）、resume 被拒但 load 成功、Agent 崩溃后恢复、Connector 重启后恢复（`sessions.json` 里的 id）、恢复后把设置改回对话里的值、接管预热 Agent 后记下它的会话 id、`rewind` 后不再恢复、空闲回收（默认不回收、Agent 设置里的空闲时间立即生效且对已经空闲的进程也算、轮次比 TTL 长时不回收、回收后下一条消息恢复、两轮之间自己的输出算有动静而用量报告不算、Agent 重启后稍晚才报告命令时 `compact` 会等它、预热 Agent 不受影响、`0` / `null` 关闭、回收中的进程退出前不启动新进程），以及没有这个字段的旧 `sessions.json`。

`tests/agent-settings.test.ts` 也不需要 Router：在初始化好的 `ConnectorHost` 上直接调用服务，模拟 Agent 记下每次启动时拿到的命令（argv0）、参数和一个环境变量。覆盖 `agents` 的形状与计数、开关（`status.runtimes`、`prepare` / `create` / 已有会话的新一轮被拒、预热 Agent 被关闭）、设置写入 `agents.json`（0600）并在重启后用于下一次启动、正在运行的进程保持旧设置、环境变量的值不出现在任何返回 / 日志 / 推送里、恢复默认、空闲后关闭进程的时间（默认不关闭、按分钟保存、`0` 改回不关闭、恢复默认时保留）、字段校验、设置变了时关闭预热 Agent（没变时保留）、带旧字段的 `agents.json` 照常加载、`stop_agent` 的计数与会话恢复、有轮次在跑时的 `turns_running` 与 `force`（含 Agent 还在启动、Agent 不理会取消的情况），以及控制面、MCP 和加密设备上的调用限制。

`tests/pi-approvals.test.ts` 也不需要 Router：扩展文件只在是 AA 自己的时候才会被更新或删除；哪些工具在哪种模式下要询问（不认识的工具、不认识的模式都按询问处理）；一个模拟的 Pi 加载扩展，覆盖不是 AA 启动的 Pi 里扩展什么也不做、按对话的模式决定是否询问、拒绝或无法询问时拦下这次调用、确认挂回它问的那次调用（别的扩展的对话框不动）；一个记录启动环境的模拟 ACP Agent 覆盖「权限控制」这个 Agent 设置：只给能加权限的 Agent、默认关闭、打开后安装扩展且每个对话有自己的设置和模式文件、像 pi-acp 那样发出确认时对话里只有一步、带完整命令、答复传回 Agent，Connector 停止时模式文件都已删除，关闭后删除扩展，正在进行的对话不再询问、也不再显示这个设置。

## 已知限制

- ACP 没有截断上下文的接口：`rewind` 会重启该会话的 Agent，新的 Agent 不带之前的上下文（设置保持对话里的值）；fork 出来的对话也从新的 Agent 会话开始。
- Agent 不支持恢复或恢复失败时，Connector 重启、`stop_agent` 之后的下一条消息会新开 ACP 会话，不带之前的上下文。这只记在 Connector 日志里，对话里没有提示：时间线还没有这种提示的条目类型，要显示需要先改跨端契约。
- 预热的 Agent 已经执行过 `session/new`：如果某个 Agent 在 `session/new` 时就写入自己的会话记录，没被接管的预热会话会在它自己的历史里留下一条空会话（Pi 要到第一条消息才写入，不受影响）。
- `compact` 只在 Agent 通过 `available_commands_update` 提供 `compact` 命令时可用。Agent 刚启动（包括重启、空闲回收之后）还没报告任何命令时，`compact` 最多等 3 秒。
- Router token 过期被拒后会重新获取 token 并重新挂载，期间该 Router 上的隧道会断开，客户端需要重连。
- MeshCall 的契约检查（W002）只把 `idempotent/readOnly/destructive: true` 当作声明；`create`、`send` 等方法确实不幂等，已显式标 `idempotent: false`，启动时仍会打印 5 条 W002 警告。
- 终端：Windows 上的 ConPTY 只按 node-pty 的接口实现，尚未在真实 Windows 设备上验证；`script` 和 `pipe` 模式不能改变程序看到的窗口尺寸。
- 尚未与真实的 `server-v3` 实例和真实的 Claude Code / Codex ACP 适配器联调；兼容性目前由契约 schema 校验和 Router 端到端测试保证。

### 附件

- `aa.v3.Device/save_attachment({ name, base64, mime?, session_id? })`：不超过 `max_rpc_file_bytes`（默认 8 MiB）的附件随 RPC 传来。带 `session_id` 时保存到该对话工作目录下的 `.agents-anywhere/attachments/<对话 id>/`（首次创建时写入内容为 `*` 的 `.gitignore`，不会被提交），这样 Agent 不离开工作区就能读到；目录不存在或不可写时退回数据目录的 `attachments/<对话 id>/`。
- `aa.v3.Device/fetch_drive_file({ file_id, session_id?, name?, mime?, sha256?, file_key? })`：大附件先由客户端传到控制面云盘，设备再用自己的设备凭据换下载链接、下载到同一个附件目录。下载后按云盘记录核对大小和 SHA-256（针对存储的字节）。`ephemeral_key` 文件是 AES-256-GCM：密钥为 `file_key`（32 字节 base64url，只能经端到端加密隧道传来），nonce 为云盘记录的 `encryption_nonce`，对象内容为密文后接 16 字节认证标签，无附加数据。只在接入控制面时可用。
- 删除对话时一并删除它的附件目录。
- 发给 Agent 时，附件作为 `file://` 链接（`resource_link`）；Agent 声明支持图片输入时，不超过 5 MiB 的图片改为内联图片块。
