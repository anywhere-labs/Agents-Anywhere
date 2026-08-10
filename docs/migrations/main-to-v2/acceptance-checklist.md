# v2 迁移验收 Checklist

每个必需项都必须为 release candidate 提供证据。只有写清 owner 和原因时，才能把某一项标记为不适用。

## 基线和 artifacts

- [ ] 已记录 `main` source commit、v2 source commit、images 和 client builds。
- [ ] 总览中的 baseline commits 之后，已经刷新过 release diff。
- [ ] 迁移报告不包含 secret values。
- [ ] 已在演练中恢复过 v1 SQLite、文件存储、Connector 数据和部署配置备份。

## 数据和基础设施

- [ ] 一次性 v1-to-v2 导入已完成，table row counts 和 SHA-256 digests 匹配。
- [ ] 最终 PostgreSQL 目标库在导入前是新建且为空。
- [ ] 最终迁移报告已保留。
- [ ] Database revision 精确为 `v2_7`，schema version 为 `2.7`。
- [ ] File payload 数量和代表性下载结果与迁移后的 metadata 匹配。
- [ ] Redis persistence 已禁用，并且 Redis 被视为临时协调层。
- [ ] PostgreSQL 和 file-storage backup/restore 流程已测试。
- [ ] `/api/v2/health/ready` 返回 200，database 和 Redis checks 都是 `ok`。
- [ ] Server 指向陈旧 schema 启动时，会按预期 readiness/startup 失败。

## 服务端 API

- [ ] 所有产品 HTTP、SSE 和 WebSocket routes 都使用 `/api/v2`。
- [ ] 配置中的 Server URLs 仍然只是 origin，不包含 `/api/v2`。
- [ ] Session create-and-start 会把第一批 runtime events 绑定到已分配的 platform session id。
- [ ] 已有 session 的 messages 不包含 model/permission 字段。
- [ ] Model/permission 变化使用 runtime selections。
- [ ] Commands 失败时不会 fallback 成普通 message。
- [ ] Runtime notices 通过 session runtime notice route 响应。
- [ ] Snapshot 只用于初始 hydration 或显式恢复。
- [ ] Dashboard 和 session WebSocket tickets 都是 single-use 且有 scope。

## 连接器和运行时

- [ ] 已备份的 legacy Connector directory 按文档迁移到了 `~/.agents-anywhere`。
- [ ] 已接受废弃 SQLite sync state 被移除，并且 resync 成功。
- [ ] 如果有 override，Connector config 使用 `statePath`/`AGENT_CONNECTOR_STATE_FILE`。
- [ ] Connector auth、ingest、WebSocket、attachment、transfer 和 relay URL 都使用 v2 helpers。
- [ ] Codex 通过官方 SDK 路径运行，没有 active app-server/IPC fallback。
- [ ] Claude 会报告真实的 supported/unsupported capabilities。
- [ ] 没有 active code import `connector/_reference`。
- [ ] Connector 重启后，runtime state、catalogs、notices、commands 和 capabilities 能恢复。
- [ ] 每个支持的 OS 上都验证过 headless Connector 启动和关闭。

## 运行时覆盖决策

- [ ] 生产 runtime inventory 只包含 v2-supported providers；或者每个 unsupported dependency 都有已批准的迁移方案或 blocker。
- [ ] Gemini ACP 依赖已解决。
- [ ] Cursor ACP 依赖已解决。
- [ ] Grok Build ACP 依赖已解决。
- [ ] CodeBuddy ACP 依赖已解决。

## 网页端

- [ ] `yarn typecheck` 通过。
- [ ] `yarn protocol:check` 通过，并且没有 stale generated files。
- [ ] Dashboard 使用带 ticket 的 WebSocket snapshots，而不是正常列表轮询。
- [ ] Session UI 使用 live runtime state 和 effective capabilities 来决定 actions。
- [ ] Selector reads 是 live 的，command filtering 在客户端本地完成。
- [ ] Optimistic messages 通过 `clientMessageId` 对齐，不产生重复项。
- [ ] Text、attachment-only、reasoning、tool、file-change、compact 和 error timeline items 都能渲染。

## Android

- [ ] 已移除的 session routes（`/{id}`、`/state`、`/runtime-settings`、`/messages`、`/interrupt`、`/bulk-archive`）没有 call sites。
- [ ] 已移除的 runtime-management routes（`runtime-capabilities`、`agents/*/settings`）没有 call sites。
- [ ] HTTP、SSE、WebSocket、attachment 和 terminal URLs 都只应用一次 v2 namespace。
- [ ] Session live state、capabilities、notices、commands 和 recovery 已做 integration test。

## iOS

- [ ] 已移除的 session routes（`/{id}`、`/{id}/read`、`/state`、`/runtime-settings`、`/messages`、`/interrupt`）没有 call sites。
- [ ] 已移除的 runtime-management/config routes 没有 call sites。
- [ ] HTTP、SSE、attachment 和 direct URLs 都只应用一次 v2 namespace。
- [ ] Session live state、capabilities、notices、commands 和 recovery 已做 integration test。

## 切换和回滚

- [ ] Maintenance/write-freeze 流程有 owner，并且持续时间已测试。
- [ ] Server/Web 一起 cut over，Connector 分批升级。
- [ ] Monitoring 覆盖 removed-route traffic、Connector reconnects、Redis、database pools、recovery loops 和 attachment failures。
- [ ] Rollback decision point 和 owner 已记录。
- [ ] v1 stack 在 rollback window 内仍然可运行。
- [ ] 所有人都理解 rollback 是回到 v1 backups，不是 downgrade v2 database。
- [ ] Cutover window 内 v2 接受的任何写入，都有明确 reconciliation plan。
