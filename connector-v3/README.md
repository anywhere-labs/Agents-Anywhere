# Agents Anywhere v3 Connector

v3 的工作设备进程（TypeScript，Node ≥ 22）。它在本机运行任意 ACP Agent（Claude Code、Codex 等），把会话、终端、文件和 git 作为 MeshCall 服务挂到 Router 上，供 Desktop / Web / 手机客户端和 v3 控制面调用。会话数据只保存在这台设备上，控制面不保存会话内容。

设计依据：

- [v3 架构提案](../docs/v3/architecture-proposal.md)
- [设备级端到端加密准入方案](../docs/v3/e2ee-admission-proposal.md)
- 契约：[`contracts/aa-v3/1.0/control.schema.json`](../contracts/aa-v3/1.0/control.schema.json)、[`pairing.schema.json`](../contracts/aa-v3/1.0/pairing.schema.json)
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
    terminal-manager.ts 无原生依赖的终端
    acp-host.ts         通用 ACP 宿主：每个会话一个 Agent 进程，stdio 行分隔 JSON-RPC 2.0
  rpc/                  MeshCall 服务（targeted，instance = 设备 id）
    device-admin-service.ts  aa.v3.DeviceAdmin：ping / close_tunnel_sessions / check_update / rename
    sessions-service.ts      aa.v3.Sessions
    device-service.ts        aa.v3.Device
    terminals-service.ts     aa.v3.Terminals（attach 为 duplex）
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

内置两个预设：

- `claude`：`npx -y @zed-industries/claude-agent-acp`
- `codex`：`codex-acp`

其他任何说 ACP（stdio 上的 JSON-RPC 2.0）的命令都可以通过 `--presets presets.json` 加入：

```json
[{ "id": "gemini", "name": "Gemini CLI", "command": "gemini", "args": ["--experimental-acp"] }]
```

### 数据目录

| 文件 | 内容 |
| --- | --- |
| `identity.json` | 设备 id、设备密钥、控制面地址、设备 X25519 私钥（0600，私钥不离开本机） |
| `settings.json` | 模式、MCP 开关、配对确认、RPC 文件上限、设备名 |
| `paired-clients.json` | 已配对客户端公钥（加密模式的信任名单） |
| `sessions.json` | 会话快照（防抖写入） |
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

`tests/connector-router-e2e.test.ts` 会启动真实的 Go `meshcall-router`（v0.4.0）和一个用 Node 写的 stdio ACP 模拟 Agent，覆盖：控制面直接调用、MCP 开关、普通隧道上的创建/发送/审批/排队/文件读取/终端 attach、`close_tunnel_sessions`、presence 与推送的契约形状、普通 → 加密的安全切换，以及加密模式下的配对（IKpsk2）、陌生客户端被拒、重连（IK）和撤销。Router 二进制按以下顺序查找：`MESHCALL_ROUTER_BINARY`、`../../meshcall/meshcall-router/bin/meshcall-router`、`findRouterBinary()`；都找不到时跳过该测试文件。

## 已知限制

- ACP 没有截断上下文的接口：`rewind` 会重启该会话的 Agent，新的 Agent 不带之前的上下文；Connector 重启后，已有会话的下一条消息也会启动新的 Agent 会话。
- `compact` 只在 Agent 通过 `available_commands_update` 提供 `compact` 命令时可用。
- Router token 过期被拒后会重新获取 token 并重新挂载，期间该 Router 上的隧道会断开，客户端需要重连。
- MeshCall 的契约检查（W002）只把 `idempotent/readOnly/destructive: true` 当作声明；`create`、`send` 等方法确实不幂等，已显式标 `idempotent: false`，启动时仍会打印 5 条 W002 警告。
- 尚未与真实的 `server-v3` 实例和真实的 Claude Code / Codex ACP 适配器联调；兼容性目前由契约 schema 校验和 Router 端到端测试保证。

### 附件

- `aa.v3.Device/save_attachment({ name, base64, mime?, session_id? })`：不超过 `max_rpc_file_bytes`（默认 8 MiB）的附件随 RPC 传来。带 `session_id` 时保存到该对话工作目录下的 `.agents-anywhere/attachments/<对话 id>/`（首次创建时写入内容为 `*` 的 `.gitignore`，不会被提交），这样 Agent 不离开工作区就能读到；目录不存在或不可写时退回数据目录的 `attachments/<对话 id>/`。
- `aa.v3.Device/fetch_drive_file({ file_id, session_id?, name?, mime?, sha256?, file_key? })`：大附件先由客户端传到控制面云盘，设备再用自己的设备凭据换下载链接、下载到同一个附件目录。下载后按云盘记录核对大小和 SHA-256（针对存储的字节）。`ephemeral_key` 文件是 AES-256-GCM：密钥为 `file_key`（32 字节 base64url，只能经端到端加密隧道传来），nonce 为云盘记录的 `encryption_nonce`，对象内容为密文后接 16 字节认证标签，无附加数据。只在接入控制面时可用。
- 删除对话时一并删除它的附件目录。
- 发给 Agent 时，附件作为 `file://` 链接（`resource_link`）；Agent 声明支持图片输入时，不超过 5 MiB 的图片改为内联图片块。
