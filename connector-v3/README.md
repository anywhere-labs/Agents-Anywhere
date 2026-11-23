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
    config.ts           设置、配对客户端、ACP 预设的形状与校验
    timeline.ts         aa.v3 会话模型（Session / Message / Control / WatchEvent）
    session-store.ts    内存会话库：唯一的会话真相来源，watch 推送整值替换
    acp-protocol.ts     ACP 类型与 AcpTimelineProjector（session/update → 时间线）
    gate.ts             DeviceGate：配对、允许名单、每次业务调用的准入判断
  runtime/              Node 侧实现
    state-store.ts      数据目录里的 identity / settings / paired-clients / sessions（原子写入，0600）
    device-ops.ts       文件、目录、git、附件（有上限、不走 shell）
    terminal-manager.ts 终端：PTY（可选原生依赖）或管道、无界面屏幕模拟器、输出序号、控制权
    acp-host.ts         通用 ACP 宿主：每个会话一个 Agent 进程，stdio 行分隔 JSON-RPC 2.0
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

### 终端（`aa.v3.Terminals`）

设计见[终端方案](../docs/v3/terminal-proposal.md)，帧格式见 [`terminals.schema.json`](../contracts/aa-v3/1.0/terminals.schema.json)。

- **PTY**：默认用可选依赖 `@lydell/node-pty`（各平台预编译包）启动 shell，`TERM=xterm-256color`，改尺寸会真正下发到 PTY。它在第一次创建终端时才加载；加载或启动失败时退回 `script`（Linux 且装有 util-linux `script`）或 `pipe`（`TERM=dumb`），实际模式写在 `TerminalInfo.mode` 里。`pipe` 模式的输出是裸 `\n`，客户端渲染实时输出时应打开 xterm.js 的 `convertEol`（快照里已经是 `\r\n`）。
- **第一帧是屏幕快照**：每个终端有一个 `@xterm/headless` 模拟器，接收全部输出，保留 1000 行历史。`attach` 的第一帧是序列化的屏幕（含全屏程序的备用屏、光标位置和终端模式），快照带上它已包含到的 `seq`，之后是快照之后缓冲的输出和实时输出，不重不漏。
- **序号与续传**：输出块从 1 开始编号，保留最近约 1 MiB。`attach` 带 `resume_seq` 且后面的输出都还在缓冲区里时只补发缺的块，不发快照；否则发快照。积压超过 4 MiB 的连接会被断开，重连后从快照开始。
- **控制者**：每个终端最多一个控制者，其他连接只读。`claim` 帧立即接管，控制代数 `generation` 加一；`attach` 的 `mode: "control"` 不抢控制权，只在没有控制者、或当前控制者（在线或在宽限期内）的 `client_id` 与调用方相同时才成为控制者（这时才应用 `attach` 的 `cols/rows`），否则按旁观者加入；`input` / `resize` 必须来自控制者的这条连接并带上当前代数，否则丢弃并回一次 `rejected`（每条连接每代最多一次）。控制者的连接断开后保留 10 秒（`connected: false`），期间重新接管会恢复控制；超时后清空控制者（代数加一），尺寸保持不变。每次控制者、代数或尺寸变化都会给所有连接发 `control` 帧（`you` 表示这条连接是不是控制者）。
- **调用方身份**（`client_id`）：端到端加密的调用是 `e2e:<客户端公钥>`，名称取本机配对记录；普通隧道是隧道 `principal`，名称取 `attach` 里的 `label`；临时 token 的调用取 token principal，其余（控制面、MCP）是 `control`。
- **一元 `resize`**：没有连接可以带代数，所以只在调用方身份等于当前控制者的 `client_id` 时执行，否则返回 `failed_precondition`（`details.reason = "not_controller"`）。正常客户端应在 `attach` 流里发 `resize` 帧。
- `owner` 目前都是 `user`；`agent`（ACP `terminal/create` 创建的终端，所有人只读）已预留，对它的 `claim`、`input`、`resize` 都会被拒（`agent_owned`）。

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
| `pair [--ttl 秒] [--label 名称] [--platform ios\|android\|desktop\|web\|cli]` | 生成一次性配对链接 `aa-pair://v1/…`（需要 Connector 正在运行） |
| `mode <normal\|encrypted> [--yes]` | 切换设备模式；运行中会立即安全切换 |
| `mcp <on\|off>` | 「允许外部 Agent 控制」开关（只对普通模式生效） |
| `clients` | 列出已配对客户端 |
| `revoke <client_pub>` | 撤销客户端：它的现有流立即结束，下次握手失败 |
| `status` | 运行状态，或未运行时的本地设置 |

`start` 会在数据目录里监听本地管理 socket（`admin.sock`，0600；路径过长时放在临时目录），`pair`、`mode`、`mcp`、`clients`、`revoke` 通过它操作正在运行的 Connector。没有运行时，后四个命令直接修改状态文件。配对链接里带有配对密钥，只能在本机显示（终端或二维码），不能经过服务端。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `AA_CONNECTOR_DATA_DIR` | 数据目录，默认 `~/.agents-anywhere/connector-v3` |
| `AA_CONTROL_URL` / `AA_ACCESS_TOKEN` | `register` 的控制面地址和登录 token |
| `AA_ROUTER_URLS` | `start` 直连模式的 Router 列表，逗号分隔，`URL#TOKEN` |
| `AA_CONNECTOR_PRESETS` | 额外 ACP 预设的 JSON 文件 |
| `AA_LOG_LEVEL` | `info`（默认）、`warn`、`error`、`silent` |

### Agent 预设

内置这些 Agent，本机装了对应的命令行才会提供：

| id | 启动命令 | 需要 |
| --- | --- | --- |
| `claude` | `npx -y @agentclientprotocol/claude-agent-acp` | `claude` |
| `codex` | `npx -y @agentclientprotocol/codex-acp` | `codex` |
| `antigravity` | `agy acp` | `agy` |
| `pi` | `npx -y @openma/pi-acp --quiet-startup` | `pi` |

Gemini CLI 不再内置。其他任何说 ACP（stdio 上的 JSON-RPC 2.0）的命令都可以通过 `--presets presets.json` 加入：

```json
[{ "id": "opencode", "name": "OpenCode", "command": "opencode", "args": ["acp"] }]
```

### 数据目录

| 文件 | 内容 |
| --- | --- |
| `identity.json` | 设备 id、设备密钥、控制面地址、设备 X25519 私钥（0600，私钥不离开本机） |
| `settings.json` | 模式、MCP 开关、配对确认、RPC 文件上限、设备名 |
| `paired-clients.json` | 已配对客户端公钥（加密模式的信任名单） |
| `sessions.json` | 会话快照（防抖写入） |
| `attachments/` | 客户端上传的附件 |

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

`tests/connector-router-e2e.test.ts` 会启动真实的 Go `meshcall-router`（v0.4.0）和一个用 Node 写的 stdio ACP 模拟 Agent，覆盖：控制面直接调用、MCP 开关、普通隧道上的创建/发送/审批/排队/文件读取/终端 attach、两台客户端共用一个终端时的控制权（旁观者输入被拒、接管后旧控制者的输入被丢弃、只有控制者能改尺寸）和 `resume_seq` 续传（终端的帧都按 `terminals.schema.json` 校验）、`close_tunnel_sessions`、presence 与推送的契约形状、普通 → 加密的安全切换，以及加密模式下的配对（IKpsk2）、陌生客户端被拒、重连（IK）和撤销。Router 二进制按以下顺序查找：`MESHCALL_ROUTER_BINARY`、`../../meshcall/meshcall-router/bin/meshcall-router`、`findRouterBinary()`；都找不到时跳过该测试文件。

## 已知限制

- ACP 没有截断上下文的接口：`rewind` 会重启该会话的 Agent，新的 Agent 不带之前的上下文；Connector 重启后，已有会话的下一条消息也会启动新的 Agent 会话。
- `compact` 只在 Agent 通过 `available_commands_update` 提供 `compact` 命令时可用。
- Router token 过期被拒后会重新获取 token 并重新挂载，期间该 Router 上的隧道会断开，客户端需要重连。
- MeshCall 的契约检查（W002）只把 `idempotent/readOnly/destructive: true` 当作声明；`create`、`send` 等方法确实不幂等，已显式标 `idempotent: false`，启动时仍会打印 5 条 W002 警告。
- 终端：Windows 上的 ConPTY 只按 node-pty 的接口实现，尚未在真实 Windows 设备上验证；`script` 和 `pipe` 模式不能改变程序看到的窗口尺寸。
- 尚未与真实的 `server-v3` 实例和真实的 Claude Code / Codex ACP 适配器联调；兼容性目前由契约 schema 校验和 Router 端到端测试保证。
