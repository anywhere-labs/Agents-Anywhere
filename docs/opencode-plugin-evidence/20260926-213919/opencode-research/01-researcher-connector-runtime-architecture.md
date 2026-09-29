<!-- tm_board_write · 2026-09-26T13:48:50.122Z · role=researcher · session=20260926-213919 -->
# Connector Runtime 架构调研 — 为 OpenCode 插件接入做准备

调研范围：connector\connector\runtime_protocol\（契约层）、runtimes\（三种实现）、dsh-bridge\ 与 dsh-bridge-next\（DSH 桥接）、server\ 与 web-next\（注册点）、docs\。只读，未改任何文件。

## 1. 契约层（runtime_protocol\）

### RuntimeProvider（Connector → Runtime 的工厂与生命周期）
文件：connector\connector\runtime_protocol\provider.py
- 抽象属性（必须实现）：`runtime_type: str`（provider.py:36-38）、`display_name: str`（provider.py:40-43）。
- 可选属性：`description`、`implementation_type`（如 "local-service"）、`recommended`、`recommendation_rank`、`instance_policy`（"single"|"multiple"，默认 single，provider.py:61-67）、`max_instances`。
- 方法（默认抛 RuntimeUnsupportedError）：`discover() -> RuntimeTypeDescriptor`（provider.py:69）、`get_config_schema() -> RuntimeConfigSchema`（72）、`validate_config(values) -> RuntimeConfig`（75-79）、`create_runtime(config, host) -> AgentRuntime`（81-86）、`stop_runtime(runtime)`（88-89，默认调 runtime.stop()）、`resource_claims(config)`（91-95）、`session_source_key(config)`（97-98）。
- 语义：Provider 负责「发现、配置校验、创建实例」；运行中的 AgentRuntime 只读暴露有效配置（类 docstring，provider.py:23-27）。

### AgentRuntime（运行时实例契约）
文件：connector\connector\runtime_protocol\protocol.py
- 唯一抽象成员：`identity -> RuntimeIdentity`（protocol.py:38-40）。`start()/stop()` 默认空实现（43-47）——**契约不要求 Provider/Connector spawn 任何进程**。
- 同步模式：`sync_mode`（"polling"|"events"，protocol.py:29-32）、`resynchronize()`（34-36）。
- 读路径：`get_config`（49）、`get_runtime_capabilities`（52-58）、`list_model_catalog`（60-65）、`list_permission_catalog`（67-72）、`list_sessions(limit, cursor, force)`（74-80）、`list_complete_session_inventory`（82-87）、`get_session_snapshot`（95-101）、`sync_session_timeline`（103-114，返回 True 表示 runtime 自己发布过）、`prepare_session_timeline_sync`（116-122）、`get_session_state`（124-129）、`get_session_notices`（131-136）、`get_session_capabilities`（138-152）、`list_commands`/`list_runtime_commands`/`execute_command`（205-228）。
- 写路径：`create_and_start_session`（154-165）、`start_turn`（167-178）、`steer_turn`（180-188）、`interrupt_session`（190-195）、`update_session_selections`（197-203）、`respond_interaction`（230-237）。

### RuntimeHostClient（Runtime → Connector 回调）
文件：connector\connector\runtime_protocol\host.py
- 标识：`connector_id`（host.py:38-40）、`session_namespace`（42-46，默认 connector_id）、`runtime_kv`（27-29）。
- 会话事实推送：`session_meta_upsert`（48-58）、`session_state_update`（60-71）、`session_source_update`（73-77）、`session_turn_ended`（79-88）。
- 目录/能力推送：`runtime_capabilities_update`（90-94）、`session_capabilities_update`（96-100）、`model_catalog_update`（102-106）、`permission_catalog_update`（108-112）。
- Timeline：`timeline_sync(items, complete)`（114-123）、`timeline_item_upsert`（125-129）。
- 通知/健康：`notice_upsert`（131-135）、`runtime_error`（137-146）、`runtime_health_update`（148-160）、`publish_runtime_notifications`（31-35，直接走 Connector ingest 管道）。
- 附件与同步游标：`attachment_download(session_id, file_id)`（162-167）、`sync_state_read/write/delete`（169-186）。

### 数据模型（models.py）
- `RuntimeStatus`：idle/waiting/pending/running/stopping/waiting_approval/blocked/error/disconnected（models.py:7-17）。
- 能力常量（models.py:34-43）：session.send_message、session.interrupt、session.steer、session.interaction.approval、runtime.attachment、runtime.config、catalog.model、catalog.permission、catalog.effort、session.commands。
- 能力声明与协商：`RuntimeCapability`（capability_id + scope "runtime"|"session" + supported/available/allowed + unavailable_reason，models.py:139-152）打包成 `RuntimeCapabilitySet`（155-163）；runtime 级经 `get_runtime_capabilities` + host.runtime_capabilities_update 发布，session 级经 `get_session_capabilities`。Connector 侧把 provider 布尔能力映射为 capability id（connector\connector\server\capabilities.py:13-23）。
- 其余：`RuntimeIdentity`（46-52）、`RuntimeConfig`（55-63）、`RuntimeConfigSchema`（66-73）、`SessionMeta`（183-193）、`SessionState`（196-206）、`RuntimeAttachment`（233-239）、`RuntimeAttachmentContent`（242-248）、`RuntimeTimelineItem`（251-264：id/session_id/type/status/order_seq/content_hash/role/turn_id/content/source/revision）、`RuntimeTimelineSnapshot`（267-275）、`SessionNotice`（284-301：type notification|interaction、actions、response_required、blocking）、`RuntimeOperationResult`（304-310）。

## 2. 三种现有实现对比

| 维度 | Codex | Claude | DSH |
|---|---|---|---|
| 集成模式 | 进程内 Python SDK（openai-codex 包） | 进程内 Python SDK（claude-agent-sdk） | attach 外部 bridge（loopback TCP） |
| 谁启动 Agent 进程 | SDK 内部管理 codex app-server 子进程 | ClaudeSDKClient spawn Claude Code CLI 子进程 | 用户启动 DSH + 插件，Connector 只连接 |
| implementation_type | （未声明） | （未声明） | "local-service"（dsh\provider.py:68-69） |
| instance_policy | single（codex\provider.py:67-68） | single（claude\provider.py:49-50） | single（继承默认） |
| 崩溃恢复 | SDK/adapter 内部 | SDK/adapter 内部 | restart loop 每 5s 重读 endpoint.json（dsh\runtime.py:504-524） |

证据：
- Codex：sdk\client.py:762-768 `_load_codex_sdk` import `openai_codex`；timeline\accumulator.py:7 `from openai_codex.generated.v2_all import Thread`；client.py:313 提到 "Codex app-server"；sdk\binary.py:76 用 subprocess 辅助发现二进制。
- Claude：discovery.py:19 `importlib.import_module("claude_agent_sdk")`；sdk\client.py:51-57 `ClaudeSDKClient(options)`；build_sdk_options 支持 cli_path/resume/cwd/env（sdk\client.py:60-98）——SDK 自己 spawn Claude Code CLI。
- DSH：runtime.py:39 类 docstring「Protocol adapter; all DSH reads and timeline projection belong to the plugin」。

## 3. DSH 桥接模式（OpenCode 插件方案最接近的先例）★

**结论：DSH 已经是「桥接组件存在于 Agent 侧、由用户自行启动」的形态，且是仓库内被完整验证的 attach 模式。**

### 3.1 Bridge（Agent 侧，DSH 插件内）
代码：dsh-bridge-next\src\host\dsh-runtime\（旧版在 dsh-bridge\src\）。
- 插件是 DSH 进程内 Service，注入原生能力：`static inject = ['sessions', 'sessionQuery', 'workspaceRegistry']`（index.ts:20）——会话数据直接来自 DSH 原生 API。
- `RuntimeServer`（server.ts:21）：`node:net` TCP server 监听 **127.0.0.1 随机端口**（server.ts:64 `listen(0, '127.0.0.1')`）。
- 端点文件：`<DSH_HOME>/agents-anywhere/bridge/endpoint.json`（index.ts:37），内容 `{version:1, host:'127.0.0.1', port, token, pid}`（server.ts:13, 60-69）；token = randomBytes(32) base64url。原子发布：临时文件 + `link()`（server.ts:73-79）；OS 级 lease（acquireManagerLock，server.ts:47）防双 bridge，崩溃自动释放。
- 关闭时校验 token+pid 一致才删 endpoint 文件（server.ts:103-105）。

### 3.2 发现与通信协议
- Connector 侧 `discovery.load_endpoint`（dsh\discovery.py:123-140）读 endpoint.json，强校验：必须 127.0.0.1、port 1-65535、token 非空、pid>0。
- `discover()` 不触碰 bridge（discovery.py:41-55 注释明确「discovery must not touch the DSH bridge」——设备列表只回答支持哪些类型）；可达性属于 `probe()`（58-120）：建 BridgeClient → initialize → ping → 拉取 runtime.getCapabilities / catalog.listAgentPresets。
- 传输：**裸 TCP + 换行分隔 JSON-RPC 2.0 帧**（client.py:202-216 json+\n；server.ts:126-129），帧上限 8 MiB（client.py:12, server.ts:12）。不是 WebSocket。
- 握手：`initialize {authToken, protocolVersion:"1.0", runtime:"dsh", connectorId, sessionNamespace, clientInfo}`（client.py:98-112）；服务端校验 identity.runtime=="dsh" 与 protocol 主版本（client.py:119-129）。
- **方向限制：Connector 拒绝 bridge 发来的请求**（client.py:290-303 回 METHOD_NOT_FOUND "Connector does not accept bridge requests"）——协议是纯「Connector 请求 / bridge 应答 + bridge 单向通知」。

### 3.3 RPC 方法面（bridge 实现：dsh-bridge-next\src\host\dsh-runtime\router.ts:53-175）
initialize/ping；runtime.getCapabilities/getConfig、runtime.sync.subscribe/ack/unsubscribe/refresh；session.list/getSnapshot/getState/getNotices/getCapabilities；session.createAndStart/startTurn/interrupt/updateSelections/respondInteraction；catalog.listModels/listPermissions/listAgentPresets；workspace.list。

### 3.4 通知与 timeline 同步（sync cursor 机制）
- bridge → Connector 通知：`runtime.capabilities.update`、`timeline.item.upsert`、`runtime.sync.batch`、`runtime.error`（dsh\runtime.py:454-471 分发）。
- `SyncRelay`（dsh\bridge\sync.py:47-）重组 bridge 的分页批次：`snapshot.begin/items/commit/abort`（全量快照，commit 时经 host.publish_runtime_notifications 发 session.meta.upsert + timeline.sync complete）、`notifications`（增量）、`workspace.inventory`（忽略）。
- **检查点（sync cursor）**：`checkpoint.load/save/delete` 操作经 host.sync_state_read/write/delete 持久化到 Connector 侧（sync.py:99-118，key = `dsh/sync/checkpoints/<externalSessionId>`）；检查点含 version/projectionVersion/throughSeq/historyHash(64 hex)/settled（sync.py:35-44）。重连时先重放至已提交检查点并校验历史前缀指纹，匹配则只上传后续变化（dsh-bridge-next\README.md:46）。
- 传输页 ACK 不推进 Connector 持久状态；历史相关通知要等服务端 ingestion 成功（sync.py:48-53 类 docstring、_DURABLE_NOTIFICATIONS sync.py:28-32）。

### 3.5 审批与远程输入
- bridge 上报 `SessionNotice`（type=interaction，actions 列表，response_required）；Connector 经 `get_session_notices` 拉取或收 notice_upsert。
- 远程应答：`respond_interaction(session_id, notice_id, action_id, input_data)`（protocol.py:230-237）→ bridge `session.respondInteraction`（dsh\runtime.py:286-298；router.ts:169）。

### 3.6 生命周期倒置的完整形态（dsh-bridge-next）
- 插件甚至 **spawn Connector 本身**：`SourceConnector`（host\connector\process.ts:65，注释「Owns only the child it spawns; DSH Agent operations are served by the plugin runtime」）用 uv 启动 connector 子进程，stdio JSON-RPC 通信（process.ts:1-27）。
- 即进程树：DSH → 插件 → Connector 子进程；Connector 内的 DshRuntime 再连回插件的 loopback bridge。Connector 也可独立运行（AA Desktop / CLI），此时只是连不上 bridge 进入等待重连。
- 崩溃恢复：DshRuntime.`_handle_exit` 上报 runtime_error + health_update("error") 并 `_schedule_restart`（runtime.py:473-498）；restart loop 每 5s（快速退避若干次）重读 endpoint.json 重连（runtime.py:504-524）——DSH 换端口重启也能追上。

## 4. 数据流清单（契约接口 → file:line）

| 数据项 | AgentRuntime 侧（Connector→Runtime） | HostClient 侧（Runtime→Connector） |
|---|---|---|
| 会话列表 | list_sessions protocol.py:74-80；list_complete_session_inventory :82-87 | session_meta_upsert host.py:48-58 |
| 消息/timeline 同步 | get_session_snapshot :95-101；sync_session_timeline :103-114；prepare_session_timeline_sync :116-122 | timeline_sync host.py:114-123；timeline_item_upsert :125-129；publish_runtime_notifications :31-35 |
| sync cursor | resynchronize protocol.py:34-36 | sync_state_read/write/delete host.py:169-186（DSH 检查点 sync.py:99-118） |
| 输入请求/审批远程应答 | get_session_notices protocol.py:131-136；respond_interaction :230-237 | notice_upsert host.py:131-135 |
| 发送用户消息/新建会话 | create_and_start_session protocol.py:154-165 | session_turn_ended host.py:79-88 |
| 继续会话 | start_turn :167-178；steer_turn :180-188 | — |
| 打断 | interrupt_session :190-195 | — |
| Runtime 配置（模型/权限） | get_config :49-50；update_session_selections :197-203；list_model_catalog :60-65；list_permission_catalog :67-72 | model_catalog_update host.py:102-106；permission_catalog_update :108-112 |
| 附件/文件 | RuntimeAttachment models.py:233-239（DSH: staged_attachments dsh\runtime.py:338-341） | attachment_download host.py:162-167 |
| 能力协商 | get_runtime_capabilities protocol.py:52-58；get_session_capabilities :138-152 | runtime/session_capabilities_update host.py:90-100 |
| 健康与错误 | — | runtime_error host.py:137-146；runtime_health_update :148-160 |

## 5. 注册点（新增 OpenCode Runtime 需要动的文件）

Connector 侧：
- connector\connector\runtimes\providers.py:9-10 —— `default_runtime_providers()` 加入 `OpenCodeProvider()`（唯一真正的注册表）。
- connector\connector\runtimes\opencode\ —— 新建 provider.py / runtime.py / discovery.py 等（仿 dsh 目录结构）。
- connector\connector\server\protocol.py:15 —— `RuntimeName = Literal["codex","claude","opencode","acp","dsh"]` **已含 "opencode"**，无需改。
- connector\connector\server\capabilities.py:5-11 —— KNOWN_RUNTIME_CAPABILITY_IDS **已含 "opencode"**，无需改。

服务端（server\）：
- server\agent_server\core\runtime_identity.py:23 —— KNOWN_RUNTIME_TYPES **已含 "opencode"**。
- server\agent_server\core\models.py:22-23 —— _PROTOCOL_1_RUNTIME_NAMES **已含 "opencode"**。
- server\agent_server\services\admin_dashboard.py:75 —— runtime 显示名映射（"codex":"Codex"...），需补 "opencode"。

前端（web-next\，粗略）：
- web-next\src\generated\protocol\v1\*.ts —— Runtime union **已含 "opencode"**（生成代码）。
- 显示名/图标/设置表单等 UI 层按需补（未深挖）。

结论：**协议枚举在 server/web-next/connector 三处都已预置 "opencode"（和 "acp"），新增 runtime 的实际代码工作集中在 Connector 侧的 provider+runtime 实现，服务端与前端几乎零改动。**

## 6. 相关文档

- docs\runtime-protocol\README.md:38-44 —— 分层图明确把 **OpenCode、ACP 列为 planned adapters**（"Runtime adapters: Codex / Claude / OpenCode / ACP"）。
- docs\runtime-protocol\connector-to-runtime.md —— 契约草案；:79-96 明确 RuntimeConfig 由服务端持久持有并下发，Connector 不得本地保存 runtime 配置或自行重启。
- docs\runtime-protocol\runtime-host-client.md、runtime-instances-v2-rewrite.md、connector-structure.md。
- dsh-bridge-next\README.md（架构总览）、RUNTIME_SYNC_PLAN.md（同步分工）、RUNTIME_READS.md（读取路径）。
- dsh-bridge\README.md —— 旧版 bridge（dsh-aa-gateway），同样 loopback JSON-RPC。

## 7. 与「OpenCode 由用户自己启动、插件反向注册到 Connector」的冲突分析 ★

**核心结论：Connector 不必 spawn Runtime 进程，attach 到已运行的外部进程是被 DSH 完整验证过的一等公民模式。**
- `RuntimeProvider.create_runtime` 只构造 adapter 对象（provider.py:81-86）；`AgentRuntime.start()` 默认空实现（protocol.py:43-44）——契约层面没有任何「必须 spawn」的要求。
- DshRuntime.start() 只连接已有 bridge，连不上就上报 health 并进入 restart loop 等待（dsh\runtime.py:80-97, 504-524）。
- RuntimeSupervisor.start()（supervisor.py:226-295）管理的是 adapter 实例生命周期（validate_config → create_runtime → runtime.start()），不是进程生命周期。

需要注意的契约约束（非冲突，但设计时要处理）：
1. **配置主权在服务端**：RuntimeConfig 由 Server 持久持有并经 RPC 下发，Provider 负责校验（docs\runtime-protocol\connector-to-runtime.md:85-96）。OpenCode 插件若自管配置，可仿 DSH：config schema 极简（如只留 endpoint 路径/超时），运行时能力经 getCapabilities 动态上报；DSH bridge 的 runtime.getConfig 甚至返回 readOnly 标记（router.ts:133）。
2. **discover() 不得触碰 bridge**（dsh\discovery.py:41-55）：设备列表只回答「支持哪些类型」；可达性探测放 probe/validate_config。OpenCode Provider 的 discover() 应只报 available=True。
3. **协议方向是单向的**：Connector 拒绝 bridge→Connector 的 RPC 请求（client.py:290-303）。OpenCode 插件不能反向调用 Connector API；若插件需要 Connector 侧信息（如配对状态），DSH next 的解法是插件自己 spawn Connector 并用 stdio RPC（process.ts:65）——OpenCode 插件方案里 Connector 通常已由用户/AA Desktop 运行，插件只需提供 loopback server。
4. **instance_policy 默认 single**：若 OpenCode 允许多实例（多个 opencode 进程/多个项目），需声明 "multiple" 并实现 resource_claims/session_source_key 隔离（DSH 用 dsh_bridge_endpoint 作为 source key，dsh\provider.py:240-246）。
5. **崩溃恢复责任在 Runtime adapter**：需要实现 exit handler → runtime_error + health_update + 重连循环（dsh\runtime.py:473-524 是完整模板）。
6. **timeline 投影归插件**：DSH 模式里 timeline 归一化（RuntimeTimelineItem）在 bridge 侧完成，Connector 侧 DshRuntime 只做 DTO 转换（runtime.py:39 docstring）。OpenCode 插件应在插件内把 OpenCode 消息/工具调用投影为 RuntimeTimelineItem，而不是让 Connector 解析 OpenCode 原生格式。

## 8. 给 OpenCode 插件方案的直接建议

1. 集成形态完全可复制 DSH 模式：OpenCode 插件（TS，运行在 OpenCode 进程内）起 loopback TCP server + 原子发布 endpoint.json（如 <~/.opencode>/agents-anywhere/bridge/endpoint.json，含 token/pid）；Connector 侧新增 runtimes\opencode\（provider + runtime + bridge client），协议用换行分隔 JSON-RPC 2.0，方法面直接抄 DSH 的（session.list/getSnapshot/getState/getNotices/createAndStart/startTurn/interrupt/respondInteraction + runtime.getCapabilities + catalog.*）。
2. OpenCode 插件能拿到什么数据是下一步调研重点：OpenCode 的 plugin API 是否暴露会话列表、消息流、输入请求（permission）钩子——这决定 bridge 的实现成本。建议下一步调研 sst/opencode 的 plugin API（plugins 目录、@opencode-ai/plugin 包）。
3. 服务端/前端枚举已预置 "opencode"，无需协议改动；admin_dashboard 显示名映射需补一行。
