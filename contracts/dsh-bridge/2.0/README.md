# DSH Bridge 2.0（MeshCall）

DSH 插件（`dsh-bridge-next`）与 Connector 之间的本机协议。2.0 用 MeshCall 替换 1.0 的手写 JSON-RPC：Connector 进程拥有一个本机 Router，双方在 Router 上注册服务并互相调用。1.0 文档保留只读。

## 拓扑与发现

- Connector 进程（`anywhere-cli rpc`）启动时拉起一个 MeshCall `LocalRouter`：macOS/Linux 用 `~/.agents-anywhere/router/<instanceId>.sock`（路径超过 103 字节时退到系统临时目录），Windows 用命名管道 `agents-anywhere-<instanceId>`。Router 随 Connector 退出；意外退出由 Connector 监督重启，endpoint 与 key 不变。
- Connector 注册 `aa.local.v2.Control`、`aa.local.v2.Logs`、`aa.dsh.v2.Sync`，并在 `<用户主目录>/.agents-anywhere/dsh-bridge/connector.json` 发布rendezvous（0600，原子替换）：

```json
{
  "version": 2,
  "protocol": "meshcall",
  "instanceId": "4f1a…",
  "pid": 12345,
  "endpoint": {"unixPath": "/Users/me/.agents-anywhere/router/4f1a….sock"},
  "key": "mk_dsh-bridge_…"
}
```

- 插件读取该文件，`Mesh(Router(endpoint), token=key)` 连接 Router 并注册 `aa.dsh.v2.Bridge`。`instanceId` 或 `key` 变化时插件断开旧 Mesh、连接新 Router；Connector 退出时按 `instanceId` 匹配后删除文件。
- Connector 每次启动重新生成各角色的 API key；Router 的 auth 文件只在启动时读取。

## 鉴权

| 角色 | register | call |
| --- | --- | --- |
| `connector`（Connector 自身） | `aa.local.v2.Control`、`aa.local.v2.Logs`、`aa.dsh.v2.Sync` | `aa.dsh.v2.Bridge/*` |
| `host`（Desktop / 插件的 Connector 管理器） | — | `aa.local.v2.Control/*`、`aa.local.v2.Logs/*`、`meshcall.router.v1.Registry/*` |
| `dsh-bridge`（插件） | `aa.dsh.v2.Bridge` | `aa.dsh.v2.Sync/*` |

API key 形如 `mk_<id>_<随机 hex>`，Router 按 id 查表并比对 SHA-256。不用临时 token：token 最长 1 小时且到期断开连接。

## `aa.dsh.v2.Bridge`（插件提供）

全部 unary，请求/响应沿用 1.0 的 payload 形状；调用 metadata 携带 `aa-session-namespace`（替代 1.0 `initialize` 里的 `connectorId` / `sessionNamespace`）与 `aa-connector-id`。

| 方法 | 语义 |
| --- | --- |
| `initialize` | 身份、存储、features；校验协议 2.x |
| `ping`、`getRuntimeConfig`、`getRuntimeCapabilities`、`listWorkspaces` | 只读 |
| `listSessions`、`getSessionSnapshot`、`getSessionState`、`getSessionNotices`、`getSessionCapabilities` | 只读，分页游标同 1.0 |
| `listCommands`、`listModels`、`listPermissions`、`listAgentPresets` | 只读 |
| `createAndStartSession`、`startTurn`、`interruptSession`、`updateSelections`、`respondInteraction`、`executeCommand` | 变更 |
| `refreshSync` | 要求重新捕获一个会话 |
| `sync` | server stream：先发 `{kind:"subscribed", projectionVersion, checkpointVersion?}`，调用保持打开期间通过 `Sync.ingestBatch` 回传批次 |

错误以 1.0 的错误名作为 MeshCall 应用错误码（`SESSION_NOT_FOUND`、`INVALID_PARAMS`、`DSH_SERVICE_UNAVAILABLE`、`PERSISTENCE_ERROR`、`UNSUPPORTED_OPERATION` …），`retryable` 放在错误 details 里。传输错误使用 MeshCall 的 `deadline_exceeded` / `unavailable` / `resource_exhausted`。

## `aa.dsh.v2.Sync`（Connector 提供）

| 方法 | 形状 | 说明 |
| --- | --- | --- |
| `ingestBatch` | unary | `{subscriptionId, batchSeq, projectionVersion, operations[]}`；返回即“已 ingest” |
| `loadCheckpoint` | unary | `{subscriptionId, externalSessionId}` → `{checkpoint}` |
| `saveCheckpoint` | unary | `{subscriptionId, externalSessionId, checkpoint}` |
| `deleteCheckpoint` | unary | `{subscriptionId, externalSessionId}` |
| `ingestSnapshot` | 客户端流 | 请求 `{captureId, subscriptionId, sessionId, meta, throughSeq}` + 页流 `{captureId, items[]}` → `{accepted, quarantined, reason?}` |

- 批次按 `batchSeq` 严格递增；乱序或 `subscriptionId` 未知是错误，由插件重新订阅。
- 检查点只在覆盖的历史被 Server 接受之后保存；被隔离的会话不保存检查点。
- 快照页流可取消（调用取消即中止）；`captureId` 让被取消的旧流无法污染下一次捕获。提交被永久拒绝时返回 `accepted:false` 并给出隔离原因 `history_too_large` / `history_rejected`。
- 隔离、退避重捕（30 s 起，超大 5 min 起，上限 30 min）、健康上报（`starting/syncing → running`）、单会话失败隔离与 1.0 相同。
- 不再有上传进度续期：一次 ingest 调用就是一个慢请求，连接由 MeshCall keepalive 维持。

## 操作类型（`operations[]`）

与 1.0 相同：`notifications`（`timeline.itemUpsert`、`session.meta.upsert`、`session.state.updated`、`session.source.updated`、`session.turnEnded`、`session.inventory.begin/complete`、`notice.upsert`、`runtime.capability.updated`、`session.capability.updated`、`catalog.model.update`、`catalog.permission.update`）、`workspace.inventory`（忽略）。`snapshot.*` 与 `checkpoint.*` 不再是操作，改用上表的方法。

## 生成客户端

服务定义是契约的唯一来源；生成的客户端提交进仓库，改动服务后重新生成：

```bash
cd connector
uv run meshcall generate connector.mesh.control:ControlService --language typescript --single-file \
  --output ../dsh-bridge-next/src/host/generated/connector-control.ts
uv run meshcall generate connector.runtimes.dsh.bridge.host:SyncService --language typescript --single-file \
  --output ../dsh-bridge-next/src/host/generated/dsh-sync.ts
uv run meshcall generate connector.mesh.control:ControlService --language typescript --single-file \
  --output ../desktop-workbench/electron/generated/connector-control.ts
uv run meshcall generate connector.mesh.logs:LogsService --language typescript --single-file \
  --output ../desktop-workbench/electron/generated/connector-logs.ts
uv run meshcall generate connector.mesh.logs:LogsService --language typescript --single-file \
  --output ../dsh-bridge-next/src/host/generated/connector-logs.ts
```

Desktop 主进程是 CommonJS，生成文件的 `import type ... from "meshcall"` 需要带
`with { "resolution-mode": "import" }`（重新生成后手工补上，或按同一步骤的脚本处理）。
`aa.dsh.v2.Bridge` 的 Python 客户端由插件的 TS 服务导出契约后生成，生成命令见插件 `TECHNICAL.md`。

日志读写、权限及持久化语义见 [Connector 运行日志服务](logs.md)。

## 兼容

硬切 2.0：旧 Connector 只读 1.0 的 `endpoint.json`，不会读取 rendezvous v2，因此会一直停在“等待 DSH”，用户需要一起升级三端；插件也不再写 1.0 的 endpoint 镜像（`<DSH_HOME>/agents-anywhere/bridge/endpoint.json`）。插件与 Connector 的接口更新按仓库版本规则升 MINOR。
