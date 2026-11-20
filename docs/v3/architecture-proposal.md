# AA v3 总体架构：控制面、隧道、聚合 RPC 与 MCP

状态：已定稿（待实现）。加密设备的准入与端到端加密见 [e2ee-admission-proposal.md](e2ee-admission-proposal.md)；会话数据模型和 RPC 形状沿用 `v3poc/protocol/`（照搬 Effi Cloud 的 `cloud.v1.Conversations`）。本文所说的 MeshCall 能力以 meshcall `main`（ce14d60）为准，其中隧道、E2E 隧道、可续期 Token 和 Swift / JVM SDK 都在 0.3.0 之后合入，**尚未发版**。

## 1. 已确定的前提

- 后端拆成**控制面**和**隧道**两部分。控制面管设备的元数据、状态、部分控制和隧道的开启，并对外暴露 MCP；隧道承载对话数据和客户端与设备之间的双向 RPC。
- **Server 不保存任何会话数据**。工作设备上的 Connector 是唯一的数据源；客户端可以缓存，设备离线时只读显示缓存。
- 每台设备可以选择**普通模式**或**加密模式**。加密设备只能由物理扫过本机二维码的客户端连接，服务端无法做中间人，也无法通过 MCP 控制它。
- 控制面的接口尽量走 HTTP，可以借用 MeshCall 的 HTTP 端点；隧道尽量用 MeshCall 的隧道和 E2E 机制。
- 普通设备上「对所有在线设备都要调一次」的操作（例如列出对话），由控制面代理并聚合成一个 RPC。

## 2. 组成

```text
                    ┌──────────────── 控制面（Server）────────────────┐
  客户端             │  HTTP：登录 / OAuth / MCP（FastAPI）             │
  Web · Desktop ────▶│  aa.v3.Control：设备、状态、开隧道、聚合 RPC     │──┐
  iOS · Android      │  PostgreSQL：账号、设备、客户端、授权、审计      │  │ 账号凭据
       │             │  Redis：在线状态（带过期）                      │  │（签发 Token / 隧道，
       │             └────────────────────────────────────────────────┘  │  调用普通设备）
       │ mt_ Token / mtun_ 隧道凭据                                      ▼
       └──────────────────────────────▶ MeshCall Router（一个或多个）◀──────── Connector（工作设备）
                                          只转发、校验凭据和 scope        注册 aa.v3.Sessions / Terminals /
                                          加密隧道里只看得到帧头           Device / DeviceAdmin（instance = 设备 id）
```

| 组件 | 职责 | 不做的事 |
| --- | --- | --- |
| 控制面 | 账号和登录；设备注册、元数据、在线状态；签发设备 Token 和客户端隧道；普通设备的聚合 RPC；MCP；推送转发 | 不存会话、消息、文件；不持有任何加密设备的密钥 |
| Router | 路由、鉴权、scope、流控、超时；隧道和 Token 只存在进程内存里 | 不持久化任何东西；加密隧道里看不到内容 |
| Connector | ACP 宿主、会话、终端、文件、git；按设备模式决定接受哪些调用 | 不信任服务端填的身份（加密模式） |
| 客户端 | 经隧道直接调用设备；加密设备的扇出和合并在客户端做 | — |

## 3. 控制面

### 3.1 接口放在哪里

控制面自己也是一个 MeshCall 服务（`aa.v3.Control`），注册到 Router 上，客户端通过 Router 调用它：浏览器走 Router 的 HTTP 映射（`POST /v1/call/aa.v3.Control/<method>`，服务端流为 NDJSON），原生端和 Desktop 走 WebSocket。只有 MeshCall 表达不了的部分留给 FastAPI：登录、OAuth 回调、MCP 端点、健康检查。

这样做的好处：

- 控制面和设备用同一套类型化契约和代码生成（`meshcall` CLI 已能从 Router 导出契约并生成各语言客户端）；
- 状态推送（设备上下线、改名）是普通的服务端流，不用另写 WebSocket；
- 控制面可以起多个实例，由 Router 负载均衡。

**上游前置**：Router 现在只把隧道的 `principal` 告诉服务，普通 Token 调用到达服务时不带调用者身份，控制面无法知道是哪个用户在调。已确定按 MeshCall 服务方式落地：由 MeshCall 上游给 `issue_token` 加一个签发方自定的 `principal`，Router 在路由的每个调用上设置 `meshcall-token-principal`（和隧道的做法一致）。

### 3.2 登录和凭据

| 凭据 | 谁持有 | 怎么来 | 有效期 |
| --- | --- | --- | --- |
| 账号会话（refresh token） | 客户端 | FastAPI 登录（密码 / OAuth） | 长期，可撤销，存数据库 |
| 客户端 Router Token（`mt_`，scope 只含 `aa.v3.Control`） | 客户端 | 控制面用账号会话换 | 数小时，可续期 |
| 设备密钥 | Connector | 设备注册时生成，数据库只存摘要 | 长期，可撤销 |
| 设备 Router Token（`register: true`，`instance_ids: [设备 id]`） | Connector | 控制面用设备密钥换 | 数天，控制面定期续期 |
| 隧道凭据（`mtun_` / `mtun_e2e.`） | 客户端 | `aa.v3.Control/open_tunnel` | 数小时，只限制新连接 |

Router 的 Token 和隧道都只存在单个 Router 进程里，Router 重启就全部失效。所以客户端和 Connector 都必须能在收到 `401` / `4401` 时回到控制面重新领取，这条路径是常规路径，不是异常处理。设备 Token 绑定 `instance_ids`，别人拿不到设备密钥就无法在设备离线时冒充它注册。

### 3.3 设备元数据和状态

控制面数据库只存这些：

- `devices`：id、归属账号、名称、平台、Connector 版本、模式提示（普通 / 加密）、创建时间、最后在线时间；
- `device_credentials`：设备密钥摘要；
- `clients`：客户端安装 id、平台、推送 token；
- `mcp_grants`：MCP 客户端授权；
- `audit`：只记元数据（谁、何时、对哪台设备做了什么操作），不记内容。

加密设备的「模式」对控制面只是提示：客户端以本地记录为准（见准入设计稿第 6 节）。名称对服务端可见，设备注册时提醒用户这一点。

**在线状态**：Connector 启动后对 `aa.v3.Control/presence` 开一条长期的客户端流，定期上报心跳和状态摘要。这条流在就是在线，流断了就是离线；控制面多实例时把在线状态写进 Redis（带过期时间）。状态摘要按模式区分：

| | 普通设备 | 加密设备 |
| --- | --- | --- |
| 在线、Connector 版本、平台 | 上报 | 上报 |
| 可用 Runtime、能力 | 上报 | 不上报 |
| 运行中的会话数、待审批数 | 上报 | 不上报 |

客户端订阅 `aa.v3.Control/watch_devices`（服务端流：先快照，之后每台设备变化时整条替换）。

### 3.4 部分控制

Connector 注册一个和内容无关的管理服务 `aa.v3.DeviceAdmin`，控制面用自己的账号直接定向调用。两种模式都接受，但只放这类方法：

- `ping`：探测延迟和可达性；
- `close_tunnel_sessions(tunnel_id)`：撤销隧道后让设备立即丢弃相关会话；
- `check_update`：提示设备去检查更新，安装包签名由设备自己校验；
- `rename`：只改名称提示。

这些方法不能读取或修改会话内容，不能改变设备模式，不能增删已配对的客户端，也不能推送要执行的代码。加密设备上，这是服务端唯一能直接调用的服务。

### 3.5 开启隧道

`aa.v3.Control/open_tunnel({device_id})`：

1. 检查调用者拥有这台设备、设备在线；
2. 选一个 Router（设备在每个 Router 上都有注册），调用 `TunnelService/open`，参数为 `instance_id` = 设备 id，`principal` = `user:<uid>/client:<cid>`，scope 为 `aa.v3.Sessions`、`aa.v3.Terminals`、`aa.v3.Device` 的全部方法；加密设备另带 E2E 参数；
3. 返回 `{router_url, credential, tunnel_id, expires_at, mode}`。

设备接受或拒绝 offer（加密设备的真正判断在握手时做）。客户端用这个凭据连接 Router 之后，对这台设备的所有单设备操作（`watch`、`send`、`answer`、终端、文件）都走这条隧道。

**普通设备也走隧道**，不经控制面代理。这样单设备操作在两种模式下是同一条代码路径，只差加密与否；控制面也不用承担对话流量。

## 4. 聚合 RPC

### 4.1 普通设备：控制面扇出

`aa.v3.Control/list_sessions({device_ids?, limit_per_device?})` 是服务端流：

1. 控制面找出调用者名下所有在线的普通设备（或请求里指定的那几台）；
2. 并发向每台设备定向调用 `aa.v3.Sessions/list`，每台设备单独设截止时间（建议 3 秒）；
3. 哪台先回就先推哪台的结果，全部结束（或超时）后结束这个流。

每条结果的形状：

```text
DeviceResult<T> = {
  device_id
  status: ok | offline | timeout | error | encrypted
  value?: T            // status = ok 时
  error?: { code, message }
}
```

用流而不是一元调用，是为了让界面先画出快的设备，不被最慢的那台拖住；MCP 和不支持流的调用方可以用一元版 `list_sessions_once`，等全部结束后一起返回。

控制面调用设备时在元数据里带 `aa-on-behalf-of: user:<uid>` 和 `aa-via: client | mcp`。普通设备本来就信任服务端，设备用这两个字段做本机授权和日志，不能当作安全边界。

结果只在控制面内存里经过，不落库，也不缓存。

### 4.2 加密设备：客户端扇出

控制面无法调用加密设备的业务服务。客户端对每台加密设备各开一条隧道，自己并发调用，结果套进同样的 `DeviceResult`。控制面的聚合流里，加密设备以 `status: encrypted` 出现，告诉客户端「这台要你自己去问」。

合并规则写进契约（`contracts/aa-v3/`），Web/Desktop（TS）、iOS（Swift）、Android（Kotlin）各实现一遍并共用测试 fixtures：按 `updated_at` 倒序合并、按设备分组、同一设备的结果整体替换。

### 4.3 聚合的 watch

列表需要实时更新时，`aa.v3.Control/watch_sessions` 让控制面对每台普通设备维持**一条**上游 `watch_list`，同一用户的多个订阅者共用这一条，引用计数归零就关掉。控制面只在内存里保存每台设备的最新列表，用来给新订阅者发快照。

这是控制面上唯一会随在线设备数增长的内存开销，首版可以不做，只提供 `list_sessions` 加客户端定时刷新。

## 5. MCP

### 5.1 端点和授权

- 控制面在 `https://<server>/mcp` 提供 MCP（Streamable HTTP），授权按 MCP 规范走 OAuth 2.1，控制面就是授权服务器，支持动态客户端注册。
- 用户在网页上同意授权时选择 scope：`devices:read`、`sessions:read`、`sessions:write`、`approvals:answer`，以及允许操作哪些设备。
- 授权记录存在 `mcp_grants`，用户可以随时撤销。

### 5.2 能被 MCP 操作的设备

三个条件同时满足：

1. 设备是普通模式；
2. 设备本机打开了「允许外部 Agent 控制」（默认关闭，只能在设备本机或已连接的客户端上修改）；
3. 这台设备在该 MCP 授权的设备范围里。

条件 2 由设备检查 `aa-via: mcp`。对普通设备而言，服务端本来就是可信的，所以这项检查防的是误操作和配置错误，不防恶意服务端。真正防恶意服务端的只有加密模式。加密设备不会出现在 MCP 的任何结果里，即使出现，它也会拒绝调用（准入设计稿第 7 节）。

### 5.3 工具

| 工具 | 实际调用 | scope |
| --- | --- | --- |
| `list_devices` | 控制面设备表 + 在线状态 | `devices:read` |
| `list_sessions` | 第 4.1 节的聚合（一元版） | `sessions:read` |
| `read_session` | 设备 `Sessions/list_messages`，分页，返回文本摘要 | `sessions:read` |
| `create_session` | 设备 `Sessions/create` | `sessions:write` |
| `send_message` | 设备 `Sessions/send`，可选等待这一轮结束（MCP 进度通知） | `sessions:write` |
| `stop_session` | 设备 `Sessions/stop` | `sessions:write` |
| `answer_approval` | 设备 `Sessions/answer` | `approvals:answer` |

`answer_approval` 让外部 Agent 能替用户批准工具调用，风险最高，默认不在授权页勾选。MCP 发起的消息在时间线上标明来源（哪个 MCP 客户端），其他客户端都能看到。

MCP 的调用结果会经过控制面内存，这一点和普通设备的聚合 RPC 一样，只经过、不落库。审计只记工具名、设备、会话 id 和时间。

## 6. Connector 侧

- 实例 id 就是设备 id，注册到控制面给出的所有 Router 上，服务以 `targeted: true` 注册。
- 普通模式：接受普通隧道，也接受控制面账号的直接定向调用（聚合和 MCP）。
- 加密模式：业务服务只接受已完成双向认证的 E2E 会话（依赖 MeshCall 上游的新挂载选项）；`aa.v3.DeviceAdmin` 仍接受控制面的直接调用。
- 模式切换按准入设计稿第 7 节：先停掉旧入口和现有连接，再开放新入口。
- 断线和凭据失效（`401` / `4401`）时，用设备密钥找控制面重新领 Token 后重连。

## 7. Router 部署

- Go Router 放在 TLS 反向代理后面（Router 自己不终结 TLS；nginx 需关闭请求和响应缓冲）。
- auth 文件只放一个账号：控制面的签发账号，权限包括 `AuthService` 的 Token 签发 / 续期 / 撤销、`TunnelService/*`、对设备服务的调用（聚合和 MCP 用）。不开放 `anonymous`。设备和客户端的凭据全部由控制面签发，不写进 auth 文件。
- 高可用：起多个互不通信的 Router。设备注册到每一个；控制面在每个 Router 上分别给设备签 Token；隧道开在某一个 Router 上，客户端连那一个。
- 重启的代价：Router 一重启，连在它上面的设备和客户端都要回控制面重新领凭据。控制面的签发接口要限流，客户端和 Connector 重试要带随机退避。
- 容量：单个 Router 能承受多少连接和流还没测，上线前要压测。Router 之间互联（peering）还在分支上，本设计不依赖它。

## 8. 需要 MeshCall 上游做的（除准入设计稿第 8 节之外）

1. `issue_token` 支持签发方自定的 `principal`，Router 在调用上设置 `meshcall-token-principal`，服务通过 `ctx` 读到（第 3.1 节）。
2. 发版：隧道、E2E、可续期 Token、Swift / JVM SDK 都需要进入一个正式版本，AA 才能固定依赖。

## 9. 和 v2 的关系

v3 是架构变更（`3.0.0`）。v2 的 Timeline 存储、`/api/v2` 实时通道和 Connector 的 v2 上报路径在 v3 中都不再存在，数据迁移和停服窗口另写文档。本文不讨论 v2 兼容。

## 10. 已确认的决策与后续专项

已定稿的决策（2026-11-20）：

1. **控制面接口形式**：注册为 MeshCall 服务 `aa.v3.Control`，由 MeshCall 上游补齐 `issue_token` 的自定义 `principal` 透传。
2. **普通设备的单设备操作**：统一走 MeshCall 隧道，与加密设备复用同一条客户端调用路径，控制面不承接对话流量。
3. **聚合 `watch`（第 4.3 节）**：首版不做，先提供流式 `list_sessions` 加客户端刷新，后续按需演进。
4. **MCP 审批工具**：保留 `answer_approval`，授权页默认不勾选。
5. **加密设备元数据**：仅上报在线状态、Connector 版本、平台和设备名称（注册时提示用户名称对服务端可见），不上报可用 Runtime、能力和会话数。
6. **`DeviceAdmin` 方法清单**：固定为 `ping`、`close_tunnel_sessions`、`check_update`、`rename` 四项。

后续另写专项文档：

- **推送通知**：加密设备的通知内容如何用客户端公钥加密后经服务端转发，单独成稿，不阻塞主架构和 MeshCall 上游开工。
