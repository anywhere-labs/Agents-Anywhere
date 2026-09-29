<!-- tm_board_write · 2026-09-26T17:10:58.422Z · role=architect · session=20260926-213919 -->
# OpenCode V2 接入 — 集成设计（integration-design）
Read file .git/opencode-team/20260926-213919/opencode-design/01-architect-integration-des…提示: 先聚合再决定是否取原文（tm_fetch 分段取回）
> 阶段：设计（不写实现代码，不改仓库）。证据分档：【已实证】= 本仓库代码/官方文档内核验；【设计假设】= 需验证，见 §8.3。
> 关键实证来源：Connector 契约 \`connector\connector\runtime_protocol\{provider,protocol,host}.py\`；DSH 范式 \`connector\connector\runtimes\dsh\*\`、\`dsh-bridge-next\README.md\`；服务端 \`server\agent_server\core\{runtime_identity,models,oauth_clients}.py\`、\`api\oauth.py\`、\`web-next\src\components\auth\*\`。
只要摘要就到此为止；需要具体行请用 mode:"lines" 分段取，不要为了看一眼把全文读回来。
---

## 1. 总体架构

### 1.1 组件与职责边界

| 组件 | 位置 | 持有凭据 | 连谁 | 生命周期 |
|---|---|---|---|---|
| OpenCode 服务端插件 | OpenCode server 进程内（\`@opencode/plugin\`） | 内存中 OAuth 访问令牌（短期）；磁盘账号/设备凭据 | ctx(server client) 进程内；127.0.0.1 TCP 监听；spawn Connector | 随 service 进程；热重载重放 hooks |
| OpenCode TUI 插件 | CLI/TUI 进程（\`@opencode/plugin/tui\`） | 无（只读落盘凭据） | 服务端插件经 \`ctx.rpc\` / 本进程 loopback | 随 TUI；热重载重放 |
| Bridge Hub（进程级单例） | 服务端插件内，\`globalThis[Symbol.for('agents-anywhere.opencode.hub')]\` | endpoint token（32B，内存） | Connector 反向不连（协议单向：Connector 主动连 Hub） | 与 service 进程同生；dispose 释放端点 |
| AA Connector（Python） | 插件用 uv spawn（\`connector/connector\`） | 设备层 connector-id + token（\`cxt_\`） | AA Server（WSS）；主动连各 bridge endpoint | **全局唯一**（OS lease 互斥），跨 service 复用 |
| AA Server | 云端 | 账号/设备/终点评级数据 | — | — |

**凭据三层分离（红线）**：账号层=OAuth 访问令牌；设备层=connector-id + connector token（服务端签发，可 \`/revoke\` 轮换）；本地桥接层=32B endpoint token（只在本机 loopback 有效，永不外发）。三层互不替代。

### 1.2 架构图

\`\`\`mermaid
flowchart LR
  subgraph SVC["OpenCode service 进程 (opencode-cli.exe serve, :49374)"]
    A["location A 插件实例"] --> HUB["Bridge Hub (进程级单例)"]
    B["location B 插件实例"] --> HUB
    HUB --> REG["endpoints/&lt;pid&gt;-&lt;port&gt;.json (原子发布, 32B token)"]
    HUB -- "TCP 127.0.0.1:port · NDJSON JSON-RPC 2.0" --- CONN
  end
  subgraph TUI["OpenCode CLI/TUI 进程"]
    T["@opencode/plugin/tui: /aa 命令·toast·attention·dialog·QR"]
  end
  T -. "ctx.rpc / loopback" .-> HUB
  CONN["AA Connector (Python, 全局唯一 OS lease)"] -- "attach 全部活端点 → 每 location 一个 runtime instance" --> HUB
  CONN <--> SRV["AA Server (OAuth / connectors / ingest)"]
  SRV <--> WEB["Web / Desktop / Mobile (复用凭据, 二维码, 设备审批)"]
  PLG["服务端插件"] -- "uv spawn + stdio JSON-RPC (引导闭环)" --> CONN
\`\`\`

**谁连谁**：Connector 是唯一出站方（连 Server + 连各 bridge）；bridge/插件从不主动连 Connector（协议单向，与 DSH 一致，\`dsh/.../client.py:290-303\` Connector 拒绝 bridge 反向请求）。插件 spawn Connector，但 Connector 的对外连接由自己建立。

---

## 2. Bridge 协议规格

### 2.1 端点注册表目录与文件格式

目录：\`~/.agents-anywhere/opencode-bridge/endpoints/\`（Windows 同 \`%USERPROFILE%\`；遵循 \`connector/paths.py:7\` 的 \`.agents-anywhere\` 约定）。文件名 \`<servicePid>-<port>.json\`，字段：

\`\`\`json
{
  "version": 1,
  "runtime": "opencode",
  "protocolVersion": "1.0",
  "bridgeId": "<uuid4>",
  "host": "127.0.0.1",
  "port": 49375,
  "token": "<base64url, 32 随机字节>",
  "pid": 12345,
  "serviceVersion": "2.0.16",
  "locations": ["/abs/proj/a", "/abs/proj/b"],
  "startedAt": "2026-09-27T00:00:00Z"
}
\`\`\`

- **原子发布**：写 \`*.tmp\` → \`fsync\` → \`os.replace\`（对齐 DSH \`endpoint.json\` 原子发布，\`dsh-bridge-next\README.md:155,160\`）。POSIX 权限 \`0600\`；Windows 依赖用户目录 ACL。
- **进程级单例**：一个 service 进程只有一个 Hub/一个端点文件；多 location 实例把自身注册进 Hub 的 \`locations\` 集合（用户实测：单 \`serve\` 进程服务全部 location）。
- **存活校验**：Connector 侧以 **握手成功** 为权威（DSH 明确 Windows \`os.kill(pid,0)\`≠进程探测，\`dsh/discovery.py:70-78\`）；\`pid\` 仅作诊断与去重。启动/扫描时清理握手失败的残留文件（避免 DSH 的 pid 复用误判事故，\`dsh-bridge-next\VERIFICATION.md:19\`）。
- **发现语义**：\`discover()\` 只报告“支持 opencode 类型”，不触碰注册表；\`probe()\` 才读注册表并握手（对齐 \`dsh/discovery.py:41-55\`）。

### 2.2 握手与鉴权

连接 \`127.0.0.1:<port>\`，首帧 **必须** 是 \`initialize\`，携带 \`authToken\`=\`token\`、\`protocolVersion\`、\`runtime:"opencode"\`、\`connectorId\`、\`sessionNamespace\`、\`clientInfo\`。Hub 校验：token 恒定时间比较；\`identity.runtime=="opencode"\`；协议主版本==1。失败立即断链。帧=换行分隔 JSON（NDJSON），单帧上限 8 MiB（对齐 \`dsh/bridge/client.py:12\`）。Connector 拒绝一切 bridge 发起的请求（返回 \`-32601\`），仅接受通知。

### 2.3 JSON-RPC 方法表（对齐 DSH，标注 V2 差异）

| 方向 | method | params | V2 差异 / 备注 |
|---|---|---|---|
| C→B | initialize | authToken, protocolVersion, runtime, connectorId, sessionNamespace, clientInfo | identity.runtime 必须 \`opencode\` |
| C→B | ping | — | 健康探测 |
| C→B | runtime.getCapabilities | — | 能力集（scope=runtime） |
| C→B | catalog.listModels | {} | 映射 V2 \`model\` 域【假设：域/字段名】 |
| C→B | catalog.listPermissions | {} | 映射 V2 \`permission\` 域 |
| C→B | catalog.listAgents | {} | **差异**：DSH 为 \`catalog.listAgentPresets\`；V2 域名为 agent |
| C→B | session.list | {limit,cursor} | **差异**：server ctx 无 session.list → 由 Hub 自持注册表 ∪ TUI \`session.list\`（见 §2.4） |
| C→B | session.getSnapshot | {sessionId,limit} | 返回 **插件侧已投影** 的规范 timeline（投影归插件，\`dsh\README\` 同约束） |
| C→B | session.getState | {sessionId} | 9 态 RuntimeStatus |
| C→B | session.getNotices | {sessionId} | interaction 通知 |
| C→B | session.createAndStart | {sessionId,cwd,content,selections,attachments,clientMessageId} | ctx.session.create + prompt |
| C→B | session.startTurn | {sessionId,content,selections,attachments} | ctx.session.prompt |
| C→B | session.steerTurn | {sessionId,content} | **差异**：V2 ctx 无原生 steer → 未探测到即 capability=false |
| C→B | session.interrupt | {sessionId,reason} | ctx.session.interrupt |
| C→B | session.updateSelections | {sessionId,selections} | switchModel/switchAgent |
| C→B | session.respondInteraction | {sessionId,noticeId,actionId,inputData} | ctx.permission.reply / form.reply（§6） |
| C→B | runtime.sync.subscribe | {sessionId,fromSeq?} | 触发 \`sync.batch\` 通知流 |
| C→B | runtime.sync.ack | {sessionId,throughSeq} | 检查点推进 |
| B→C | sync.batch (通知) | {sessionId, phase:begin\\|items\\|commit\\|notifications, ...} | 分页重组，§2.5 |
| B→C | runtime.error (通知) | {data:{code,retryable}} | 崩溃上报，码白名单校验（对齐 \`dsh/bridge/client.py:283-289\`） |

### 2.4 两条数据通道的分工（V2 关键差异）

- **服务端 ctx**：有 session/prompt/create/interrupt/permission/event.subscribe，**无 session.list**。
- **TUI 数据层**：有 \`session.list/get/status/cost/hierarchy\`、\`message.list\`、\`permission.list\`、\`form.reply\`。
- **分工**：Hub 维护**自持会话注册表**（由 \`event.subscribe\` 增量填充 + 启动时经 \`ctx.rpc\` 向 TUI 插件拉一次 \`session.list\` 做对账）；\`session.list\` RPC 由 Hub 注册表回答。timeline 的**投影与分页**全在插件侧完成，Connector 只解码规范项（\`dsh/bridge/models.py:180-232\` 同形，runtime 校验放宽为 opencode）。

### 2.5 OpenCode 事件 → AA timeline 投影映射表

| OpenCode 源 | AA type | status | role | 说明 |
|---|---|---|---|---|
| 用户 prompt / message.created | message | done | user | \`event.subscribe\` |
| assistant 文本增量 | message | inProgress → done | assistant | 累加，落 \`contentHash\`（\`timeline_content_hash\`） |
| 推理/思维片段 | message | done | assistant | metadata.reasoning=true（若 V2 暴露） |
| tool execute.before / after hook | tool | running → done\\|failed | tool | 工具名/参数/结果；**用 hook 而非事件**保证可靠 |
| permission evaluate hook / 请求事件 | —（不进 timeline） | — | — | → SessionNotice(type=interaction)，§6 |
| 会话开始/结束事件 | turn.start / turn.end | — | — | marker，turn_id 关联 |
| 会话 idle / error / abort | turn.end | done / failed / cancelled | — | 结束态 |

> 事件枚举名/字段为【设计假设】，P0 spike 逐项核对（§8.3-A1）。

### 2.6 检查点与重连语义

- 检查点键：\`opencode/<runtime_id>/<session_id>\`，值 \`{throughSeq, historyHash, updatedAt}\`，经 \`host.sync_state_write/read/delete\`（\`host.py:169-186\`）持久化。
- 重连：先 \`runtime.sync.subscribe{fromSeq=throughSeq}\`；Hub 回放并校验前缀 \`historyHash\`；一致 → 增量续推；不一致 → 发 \`phase:begin\` 全量快照重建。
- 断链：\`exit_handler\` 上报 \`runtime_error\` + \`runtime_health_update\`，5s 后重读注册表重连（对齐 DSH 恢复循环，\`dsh/.../provider_config.py:41-51\` 参数化 maxRestartAttempts/backoff）。
提示: 先聚合再决定是否取原文（tm_fetch 分段取回）
---
取全文：tm_fetch { ref:"tm://runs/r-20260926-211547-d3213f/steps/s0375/result", access_token:"54a7c94586d240d8402073d4ada5a74a2d0281e6128a92daa2b9c7030af47ffe", mode:"structure" | "lines" }（过期 1791033349749 · 2026-10-03 13:15）
## 3. Connector 侧 \`connector\connector\runtimes\opencode\\\` 模块划分
[Output truncated. Continue reading with offset: 132]
按 DSH 目录镜像，依赖方向严格向下；**不 import dsh**。

| 文件 | 职责 | 依赖方向 |
|---|---|---|
| \`provider.py\` | \`OpenCodeProvider(RuntimeProvider)\`：\`runtime_type="opencode"\`、\`display_name="OpenCode"\`、\`implementation_type="local-service"\`、\`instance_policy="multiple"\`（\`provider.py:62\`）；discover=仅类型；probe=扫注册表+握手；config schema；create_runtime；resource_claims=\`{"kind":"opencode_bridge_registry", key=canonical(registryDir)}\`；session_source_key=\`{"kind":"opencode_service", key=canonical(registryDir)}\`（**不得含 pid/port/token**，\`instance_models.py:297-311\`） | → discovery, runtime |
| \`provider_config.py\` | 配置 schema/默认值（registryDir、startupTimeoutMs、requestTimeoutMs、maxRestartAttempts、restartBackoffMs、locations 白名单可选） | → connector.runtime_protocol |
| \`discovery.py\` | 扫 \`endpoints/*.json\` → 校验(loopback+token+pid+version) → 握手探活 → \`OpenCodeDiscovery{endpoints:[BridgeEndpoint+location...], available, configured, reason}\`；清理 stale | → bridge/client |
| \`bridge/client.py\` | loopback NDJSON JSON-RPC 2.0 客户端：initialize(authToken)、request/notify/close、通知派发、exit_handler；拒绝反向请求 | → discovery(Endpoint DTO) |
| \`bridge/models.py\` | 规范项解码（capability/session_meta/state/timeline_item/notice/commands），runtime 校验放宽为 opencode | → runtime_protocol |
| \`sync.py\` | \`SyncRelay\`：begin/items/commit/notifications 分页重组 → \`host.timeline_sync/timeline_item_upsert/notice_upsert\`；检查点读写；重连重放校验 | → bridge/client, host |
| \`runtime.py\` | \`OpenCodeRuntime(AgentRuntime)\`：\`identity\`(runtime=opencode, runtime_id=实例ID)；attach-only \`start()/stop()\`（**不 spawn**——Connector 由插件 spawn）；**每 location 一个实例**，绑定 (servicePid, location)；其余读/写方法经 bridge 转发 | → sync, bridge/models, discovery |
| \`attachments.py\`（可选） | 附件下载经 \`host.attachment_download\` | → runtime_protocol |

**注册**：仅在 \`connector\connector\runtimes\providers.py:9-10\` 加 \`OpenCodeProvider()\`（唯一注册表）。

**重构建议**：DSH 的 \`BridgeClient\`（\`dsh/bridge/client.py\`）与 OpenCode 需求几乎同构 → 抽取共享 \`connector\runtime_protocol\loophole_client.py\`（loopback NDJSON JSON-RPC 基类），DSH/OpenCode 各自薄封装。否则复制 336 行 + 漂移风险。此为可选，不阻塞 P2。

---

## 4. OpenCode 插件侧包结构

npm 包 \`@agents-anywhere/opencode-plugin\`，**一个包两个入口**（对齐本机 quota 先例：同时出现在 \`opencode.json\` plugins 与 \`cli.json\`）：
[Output truncated. Continue reading with offset: 155]
\`\`\`
package.json   exports: { ".": server entry, "./tui": tui entry }, engines.opencode >=2, dependencies: {} (零运行时依赖)
src/
  shared/protocol.ts        规范项类型 + contentHash + 方法名常量（与 Connector 契约同源）
  shared/endpoint-store.ts  原子发布/摘除 endpoints/<pid>-<port>.json；目录扫描清理
  shared/credentials.ts     ~/.agents-anywhere/opencode-plugin/ 读写(0600,原子)；reuse-first 探测
  shared/cohabitation.ts    共存清单 + 降级日志
  shared/logger.ts          脱敏；绝不记录 token/code
  server/index.ts           export default Plugin.define({ id:"agents-anywhere-opencode", async setup(ctx){...} })
  server/bridge-hub.ts      进程级单例：globalThis Symbol 收养/新建；refcount dispose
  server/registry.ts        端点发布 + OS lease
  server/projector.ts       OpenCode 事件 → 规范 timeline
  server/rpc.ts             Rpc.define + ctx.rpc.register（供 TUI/HTTP 调用）
  server/connector-supervisor.ts  uv spawn + stdio JSON-RPC + 崩溃恢复（决策2）
  server/session-registry.ts     event 增量 ∪ TUI 对账
  tui/index.ts              /aa 命令(context.keymap.layer) + toast(context.ui.toast.show) + attention.notify + dialog + QR 面板(JSX + usePlugin())
\`\`\`

### 4.1 与未知第三方插件共存的防御设计（必须写死）

1. **绝不抛错出链**：hook 链顺序执行且共享 output，任一插件抛错整链中断 → 所有 hook 回调 \`try/catch\` 兜底返回中性值；\`setup()\` 整体 try/catch，失败落 disabled hub（no-op）并记录，不影响宿主。
2. **幂等 + 可重入**：\`setup()\` 先查 \`globalThis[Symbol.for('agents-anywhere.opencode.hub')]\`；活则“收养”返回适配器，不新建、不重复 spawn Connector、不重发注册。热重载重放 hooks 时靠此原子性。
3. **能力探测 fail-soft**：所需 ctx 域/hook 缺失 → 该能力置 false 并降级（如 permission hook 不存在则不提供远端审批），不阻断其它功能。
4. **绝不写共享配置**：不写 \`opencode.json(c)\`、\`cli.json\`；只写 \`~/.agents-anywhere/\` 下自有目录。
5. **审批 hook 中立**：\`permission.hook("evaluate")\` 在 AA 无意见时返回 undefined（不改 effect），**绝不自动 allow、绝不持久 always**（§6）。
6. **零运行时依赖**：仅 Node 内建，避免与其他插件依赖冲突。
7. **事件全自捕获**：\`event.subscribe\` 异步迭代器回调各自 try/catch，异常不外溢。
8. **共存清单**：启动时读合并后配置 + 宿主日志 \`entrypoint=\` + CLI 通道，列出并存插件并自记录；只观测、不抢占。dispose 全清（撤端点、关监听、清定时器），但仍存活的 Connector 由全局 lease 管理、不因插件卸载被误杀。

### 4.2 双入口装载与热重载

- 服务端入口：合并后的 \`opencode.json(c)\` \`plugins\` 数组（全局→项目→\`.opencode/\`）加一行；TUI 入口：\`cli.json\` 加一行。用户只做 \`opencode plugin add\` 或配置加一行（非侵入）。
- 热重载重放 hooks：**登录态/凭据/注册表全在磁盘**（§5），不在插件内存；**OAuth 进行中**写 \`~/.agents-anywhere/opencode-plugin/pending-flow.json\`（state、verifier、redirectUri、deadline），重载后 \`/aa login\` 可续或安全重启，绝不留监听残留。
- Connector 是独立 OS 进程，插件重载不影响其在线；Hub 收养保证不重复 spawn。

---

## 5. 账号验证接口级设计

### 5.1 流程（复用优先）

1. 读 \`~/.agents-anywhere/opencode-plugin/\`：有效账号+绑定 → 直接 spawn Connector，零登录。
2. **本机复用**：若 \`~/.agents-anywhere/connector-runtime.json\` 存在活 Connector 且绑定匹配 → 复用 connector_id/token（对齐 DSH \`README:164,172\`）。
3. **回环 OAuth**：
   - 插件绑 \`127.0.0.1:0\`，生成 \`verifier\`、S256 \`challenge\`、\`state\`(32B)。
   - 授权 URL = \`\${webOrigin}/#/plugin-oauth?response_type=code&client_id=agents-anywhere-opencode-plugin&redirect_uri=http://127.0.0.1:<port>/oauth/callback&code_challenge=<S256>&code_challenge_method=S256&scope=profile&state=<state>\`。
   - Web \`PluginOAuthFlow\`（已存在，\`web-next\src\components\auth\mobile-oauth-page.tsx:43\`、\`auth-router.tsx:34\`）承接 → 服务端 \`POST /oauth/authorize\`（\`api/oauth.py:65-82\`，需登录态）→ 302 回 loopback → 插件 **恒定时间** 校验 state、**一次性** 消费 code、断链前从导航移除 code（对齐 DSH \`loopback.ts:74-81\`）。
   - 令牌交换 \`POST /oauth/token\`（\`api/oauth.py:123-152\`，含 \`code_verifier\`）。
   - 错误处理：state 不符→本机 400 并中止重开；callback 已消费→409；token 400→透传原因；超时→关闭监听。
4. **设备注册或复用**：\`GET /connectors/{id}\` 恢复（按共享记录匹配），无匹配 \`POST /connectors\` 新建；轮换用 \`POST /connectors/{id}/revoke\`（对齐 DSH \`account/api.ts:61-110\`）。
5. 凭据原子落盘 0600。
6. spawn Connector（uv + stdio JSON-RPC，传 settings/凭据路径），Connector claim OS lease 后 attach 全部端点。
7. 发布 endpoint 文件。

[Output truncated. Continue reading with offset: 210]

\`/aa login --headless\`：TUI 显示 \`verification_uri\` + \`user_code\`（\`context.ui.toast\` + \`attention.notify\`，可选 QR）。用户在任意设备浏览器打开 Web 设备页 → 输入短码 → 用已登录会话批准。插件按 \`interval\` 轮询令牌端点。**跨机时 loopback 回调不可达，故必须走设备码，不能只用回环 OAuth。**

### 5.3 凭据存储位置与退出

- \`~/.agents-anywhere/opencode-plugin/settings.json\`（仅 apiBaseUrl）
- \`.../account.json\`（服务端、账号ID、访问令牌）
- \`.../bindings/<serverKey>/<accountId>.json\`（connector_id + connector token）
- \`.../pending-flow.json\`（进行中 OAuth，非凭据）
- 与服务端/前端/CLI 同构 DSH 布局（\`dsh-bridge-next\README:160\`），保证与 Desktop/DSH 复用语义一致。
- **退出登录：先 \`POST /connectors/{id}/revoke\` 撤销设备凭据 → 再删本地 binding/account → 停 Connector**（顺序不可逆）。

### 5.4 服务端改动清单（最小）

| 位置 | 改动 | 依据 |
|---|---|---|
| \`core/oauth_clients.py\` | 新增 \`OPENCODE_PLUGIN_OAUTH_CLIENT\`（client_id=\`agents-anywhere-opencode-plugin\`），loopback 正则与 DSH 同（建议把该正则提为共享函数，两家复用） | \`oauth_clients.py:13-19,34-38\` |
| \`api/oauth.py\` + repo + migration | **新增**设备码端点 \`POST /oauth/device/code\`、\`POST /oauth/device/token\`（grant_type=urn:ietf:params:oauth:grant-type:device_code）；存 device_code/user_code/state/expiry | 现无 device_code（全库 grep 无匹配） |
| \`web-next\` | 回环流**复用** \`#/plugin-oauth\`（无需新路由）；新增 \`#/plugin-device\` 设备码输入/批准页 | \`continuation.ts:2\` 已有 plugin-oauth |
| \`services/admin_dashboard.py\` | **更正**：不止 \`:75\` 一行——\`AGENT_LABELS\`(74-78) + 三处 \`("codex","claude","dsh")\`(321,546,677) + \`dsh_agents\` 计数字段需并列加 opencode | 与“仅一行”不符，实现时按四处改 |
| 枚举 | 已预置 \`opencode\`：\`runtime_identity.py:23\`、\`models.py:22-23\`、\`connector/server/protocol.py:15\`、\`capabilities.py:9\`、web/desktop generated | 无需改 |

---

## 6. 审批远程代答设计

**链路**：\`ctx.permission\` 产生待批请求 → Hub 转 \`SessionNotice(type="interaction", interactionType="permission", blocking, actions)\` → \`session.getNotices\` 推 Connector → \`notice_upsert\` → 手机/Web 展示（工具名+原因+“允许一次”/“拒绝”）→ 用户作答 → \`session.respondInteraction{noticeId,actionId}\` → Hub → \`permission.reply\`；原生客户端作答/取消后 AA 通知自动关闭。
[Output truncated. Continue reading with offset: 238]
**安全方案**：
- **设备身份**：通知绑定 connector device id；服务端只路由给该 connector 归属用户；作答必须来自认证用户。
- **本地确认**：高风险动作（写文件、越 cwd 执行）标记 \`requires_local_confirmation\`，仅允许 TUI 本地 dialog 确认，拒绝纯远端代答。
- **审计**：每次远端作答记录 {noticeId, userId, actionId, ts, source=remote} 到 Connector 日志 + AA 事件。
- **绝不 always**：actions 仅 \`allow_once\`/\`deny\`；远端请求 \`always\` 返回 \`unsupported_action\`；**从不**经远端改写持久权限规则。
- **抢答检测**：reply 先到先得 → Hub 以 noticeId 记录首个作答；已答/已取消再答返回 \`already_answered\` 并关闭通知；不重试、不级联。

---

## 7. 四个开放问题裁决

| # | 问题 | 裁决 | 理由（证据） |
|---|---|---|---|
| 1 | OAuth 客户端 + Web 引导路由的服务端改动边界 | 回环流：**仅加 1 个 OAuth client**（\`oauth_clients.py\`），复用现有 \`/oauth/authorize\`、\`/oauth/token\` 与 Web \`#/plugin-oauth\`，**无新路由**。无头流：另加设备码端点对 + \`#/plugin-device\` | \`api/oauth.py\` 已通用；\`web-next\` plugin-oauth 已存在且非 DSH 专属 |
| 2 | 凭据落盘位置 | \`~/.agents-anywhere/opencode-plugin/\`（磁盘，0600，原子），**不用 ctx.storage 存密钥** | ctx.storage 为 OpenCode 内部、Connector/Desktop 不可见 → 破坏复用优先；DSH/Connector 均用 \`~/.agents-anywhere\`（\`paths.py:7\`、\`README:160\`）。ctx.storage 仅存非机密 UI 偏好的可选缓存 |
| 3 | 短码兜底是否需新增服务端轮询端点 | **需要**：\`/oauth/device/code\` + \`/oauth/device/token\`（+ Web 设备页）。回环 OAuth 跨机不可达 | 全库无 device_code；跨机时 127.0.0.1 回调指向浏览器本机 |
| 4 | 双入口装载与热重载登录态 | 一包两入口，分别入 \`opencode.json plugins\` 与 \`cli.json\`；状态全落盘；Hub 经 globalThis Symbol 收养；进行中 OAuth 落 \`pending-flow.json\`；dispose 清监听/端点但**不杀**全局 Connector | 热重载重放 hooks（需幂等）；Connector 独立进程 + OS lease |

---

## 8. 实施计划 / 风险 / 未决假设

### 8.1 分阶段（每阶段独立验收）

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 spike | 装 \`@opencode/plugin\` v2，核对 ctx 域/事件名/hook 重放/双入口装载/与 quota+team-mode+alibabatokenplan 共存 | 输出事件清单与重载无错日志 |
| P1 Hub（服务端插件） | 端点注册表 + 单例 + 只读 RPC(ping/getCapabilities/session.list/getSnapshot) + 投影 | Connector 手动 attach，会话可见 |
| P2 Connector \`opencode/\` | provider+discovery+client+runtime+sync，注册 | AA 列出 OpenCode 会话，timeline 同步，重连正确 |
| P3 写路径 | createAndStart/startTurn/interrupt/respondInteraction + 审批 | 完整一轮往返 |
| P4 账号 | 回环 OAuth + 复用 + spawn Connector | 新机一条命令接入 |
| P5 无头 | 设备码端点 + Web 设备页 + TUI 短码/二维码 | SSH 流程可完成 |
| P6 加固 | 共存清单、热重载 soak、\`engines\` 门、审计 | 长稳 + 版本门触发降级 |

### 8.2 风险

[Output truncated. Continue reading with offset: 275]
|---|---|---|
| API/版本漂移（宿主 2.0.16 vs npm 2.0.18） | 钩子/域变更致失败 | \`engines\` 门 + 能力探测 fail-soft |
| server ctx 无 \`session.list\` | 会话列表不全 | Hub 自持注册表 + TUI 对账 |
| 事件枚举不确定 | 投影错/漏 | P0 逐项核对 |
| steer 可能不支持 | 能力缺失 | 探测→capability=false |
| 热重载双发布/双 spawn | 端点冲突 | globalThis 收养 + lease + refcount |
| Windows pid 复用 | 误判存活 | 以握手为准，非 pid（DSH 事故教训） |
| hook 链抛错中断整链 | 影响其他插件 | 全 try/catch + 中性返回值 |
| 审批被抢答/always 持久化 | 越权 | 设备身份 + 本地确认 + 审计 + 禁 always + 首答锁定 |
| 设备码新增服务端面 | 排期 | 独立 P5 |

### 8.3 未决假设清单（含验证方法）

| # | 假设 | 置信 | 验证方法 |
|---|---|---|---|
| A1 | V2 事件枚举名与字段（message/tool/turn/permission） | 中 | P0 订阅 \`event.subscribe\` 打印实测 |
| A2 | \`permission.reply\` 签名与 \`hook("evaluate")\` 返回值语义 | 中 | P0 读类型定义 + 实测 |
| A3 | \`ctx.rpc.register\` 可作为 TUI↔服务端数据通道 | 高 | P0 实测注册与调用 |
| A4 | 热重载重放 hooks 且提供 dispose | 中 | P0 触发 watched 重载观察 |
| A5 | 一个 service 进程内多 location 各初始化插件实例 | 高 | 用户已实测 |
| A6 | ctx.storage 不适合跨工具共享密钥 | 高 | 文档 + 复用语义推演 |
| A7 | \`session.list\`/成本/层级仅在 TUI 可用 | 高 | 官方文档 + 类型定义 |
| A8 | 32B endpoint token + 原子发布足以对齐 DSH 安全边界 | 高 | 复用 DSH 已验证实现 |
| A9 | \`instance_policy="multiple"\` 语义可承载“每 location 一实例” | 高 | 契约 \`instance_models.py:16,210-216\` |

---

### 附：本设计的“已实证”锚点

- Connector 契约：\`provider.py:35-97\`、\`protocol.py:26-237\`、\`host.py:20-186\`、\`instance_models.py:153-326\`。
- DSH 范式：\`runtimes/dsh/provider.py\`（local-service/instance/source key）、\`discovery.py:41-140\`（discover/probe/load_endpoint/loopback 校验）、\`bridge/client.py\`（NDJSON/initialize/reject 反向请求）、\`dsh-bridge-next\README.md:155-178\`（lease/凭据/复用/OAuth）。
- 服务端：\`core/runtime_identity.py:23\`、\`core/models.py:22-23\`、\`core/oauth_clients.py:34-43\`、\`api/oauth.py:26-152\`、\`web-next/src/components/auth/{auth-router,mobile-oauth-page,continuation}.tsx\`。
- 注册点：\`runtimes/providers.py:9-10\`；显示名待补：\`services/admin_dashboard.py:74-78,321,546,677\`。
