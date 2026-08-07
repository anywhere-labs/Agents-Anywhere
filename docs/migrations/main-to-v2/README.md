# main 到 v2 迁移

状态：这是一份基于当前 v2 开发基线和实际代码编写的迁移指南。

这份指南说明如何把一个部署环境及其客户端，从 `main` 迁移到新的 v2 架构。它不是 changelog，也不会把只有目标文档、但还没有代码实现的内容当成已实现行为。

## 对比基线

这份指南最初审计时对比的是：

| 角色 | 分支 | 审计时的提交 |
| --- | --- | --- |
| 现有部署 | `main` | `73fc99e97efe305ba2fc8caf5c4f4f22f4cc9bf7` |
| v2 实现 | `v2-connector-refactor` | `a9f0b121249eff5d022fc04aec16723929ce7f29` |

发布前需要刷新两个分支的最新 HEAD，并重新跑一遍验收 checklist。上面的提交只说明这份指南写作时依据了哪些事实，它们不是 release tag。

## 迁移文档

1. [Server 和数据](./server-and-data.md)：说明 API namespace、PostgreSQL schema 链、v1 SQLite 导入、Redis 归属，以及 session API 变化。
2. [Connector 和 runtimes](./connector-and-runtimes.md)：说明新的 runtime 协议、本地状态迁移、支持的 provider，以及被移除的 adapter。
3. [客户端](./clients.md)：说明 Web、Android、iOS、实时连接和 payload 迁移。
4. [部署](./deployment.md)：给出有顺序的演练、切换和回滚流程。
5. [验收 checklist](./acceptance-checklist.md)：定义发布门槛。

## 破坏性变化总览

| 范围 | `main` | v2 | 必须做的事 |
| --- | --- | --- | --- |
| 产品 API | 例如 `/sessions` 这样的根路径 | `/api/v2/*` | 升级所有 HTTP、SSE 和 WebSocket URL 构造逻辑。配置里的 Server URL 仍然只保留 origin。 |
| Server 数据库 | 通过 `AGENT_SERVER_DB` 选择 SQLite | 通过 `AGENT_SERVER_DB_URL` 选择 PostgreSQL | 先演练，再把验证过的 v1 数据导入到一个空 PostgreSQL 数据库。 |
| Schema 生命周期 | Server 启动时初始化 SQLite | 显式 Alembic 链，必须精确到 revision `v2_7` | 启动 Server 前先运行 migrator；不要依赖启动时自动改 schema。 |
| 分布式协调 | 进程内 presence 和 RPC | Redis 负责 lease、Pub/Sub、ticket、lock 和 relay | 准备 Redis，但不要把它当持久化存储。 |
| Connector runtime API | dict 形态的 `Adapter` 和 `notification_sink` | `RuntimeProvider`、`AgentRuntime` 和 `RuntimeHostClient` | 把 runtime 集成迁到 typed、双向协议。 |
| Codex | CLI/app-server 和偏 IPC 的 adapter | 官方 `openai-codex` SDK 路径 | 移除 app-server/IPC 相关配置假设。 |
| Runtime 支持 | Codex、Claude 和内置 ACP manifests | 原生 Codex 和 Claude providers | ACP 形态的 Gemini、Cursor、Grok Build、CodeBuddy 在实现 v2 provider 前都视为不可用。 |
| Connector 本地数据 | `~/.agent-server`、SQLite sync state | `~/.agents-anywhere`、原子 JSON sync state | 第一次启动 v2 前备份旧目录；让一次性迁移自动执行。 |
| Session 读取 | 合并的 `/state` 响应 | `meta`、`timeline`、`runtime/*` 和恢复快照 | 按数据归属边界更新客户端。 |
| Session 动作 | `/messages`、`/interrupt`、approval resolve 路由 | `/runtime/messages`、`/runtime/interrupt`、`/runtime/notices/*` | 替换旧 action endpoint 和 payload。 |
| 实时连接 | Dashboard SSE 加轮询；session SSE | 带 ticket 的 dashboard/session WebSocket，加显式恢复 | 使用 ticket，处理按 scope 划分的事件；只在初始化 hydration 或必须恢复时拉取 snapshot。 |
| 回滚 | 复用同一个 SQLite 部署 | v2 schema 只向前 | 保留 v1 stack 和 SQLite 备份，用 blue/green 方式回滚。永远不要让 `main` 指向 v2 数据库。 |

## 兼容性策略

不支持把 `main` 和 v2 混在一起长期运行。

- `main` 客户端不会自动加 `/api/v2`，所以不能使用 v2 Server。
- 只加 `/api/v2` 不够，因为多个 session 和 runtime 路由的形状变了，或者已经被移除。
- v2 Connector 需要 v2 connector endpoints 和 runtime RPC methods。
- v2 Web 客户端是当前 v2 session API 的参考客户端。
- Android 和 iOS 目前虽然加了 v2 namespace，但仍然包含旧的 session 和 runtime-management 调用。客户端迁移 checklist 完成前，它们还不能作为 release-compatible 客户端发布。
- `main` 上可用的 ACP runtimes，在当前 v2 基线里没有 active provider。

## 推荐顺序

1. 盘点 `main` 数据库、文件、Connector 数据、runtime 使用情况，以及所有已经部署的客户端版本。
2. 备份 v1 SQLite 文件、文件存储、Connector 数据目录和部署配置。
3. 在一次性数据库上演练 SQLite 到 PostgreSQL 的导入，并保留生成的验证报告。
4. 在 staging 环境一起验证 v2 Server、Web 和 Connector。
5. 解决验收 checklist 中所有 blocked item，特别是移动端 session API 和任何 ACP runtime 依赖。
6. 停止 v1 写入，把最终数据导入新的空 PostgreSQL 数据库，然后一次性部署 v2 Server 和 Web。
7. 升级 Connectors，验证实时 runtime discovery，然后再发布兼容客户端。

在回滚窗口关闭前，不要移除 v1 环境。
