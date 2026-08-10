# 服务端和数据迁移

本文说明从 `main` 到 v2 的 Server 契约和持久化状态迁移。

## 状态归属

v2 把持久化产品状态和实时 runtime 事实分开：

| 状态 | 归属方 | 存储位置 |
| --- | --- | --- |
| 用户、connectors、session metadata、timeline、file metadata、import archive | Server | PostgreSQL |
| Runtime state、selections、notices、catalogs、实际 runtime capabilities | Active runtime，通过 Connector 投影出来 | 实时读取和推送；不是权威数据库状态 |
| Connector presence、路由后的 RPC、失效通知、WebSocket tickets、locks | Server 协调层 | Redis，生命周期有限 |
| Connector runtime 进程、sync cursors、本地 credentials | Connector | 本地进程和原子 JSON 文件 |

Redis 是可丢弃的协调状态。不要开启 Redis persistence 来替代 PostgreSQL 备份。

## 环境变量变化

| `main` 配置 | v2 配置 | 说明 |
| --- | --- | --- |
| `AGENT_SERVER_DB=/path/agent-server.sqlite3` | `AGENT_SERVER_DB_URL=postgresql+asyncpg://...` | v2 runtime 会拒绝 SQLite。 |
| 无 | `AGENT_SERVER_DB_BACKEND=postgres` | Docker image 使用的可选断言。 |
| 无 | `AGENT_SERVER_REDIS_URL=redis://...` | 分布式生产协调必需。 |
| 进程本地默认值 | `AGENT_SERVER_INSTANCE_ID` 和 Redis prefix/timeouts | 显式配置时要使用唯一 instance id。 |
| SQLite 旁边的本地文件目录 | `AGENT_SERVER_FILES_BACKEND=local|s3` 加后端配置 | 文件 payload 要和数据库行分开迁移。 |

Server origin 仍然是配置里的 public origin。客户端不要把 `/api/v2` 放进 `AGENTS_ANYWHERE_API`、`NEXT_PUBLIC_AGENTS_ANYWHERE_API` 或 Connector `serverUrl`；URL helper 会追加 namespace。

## 数据库 revision 链

当前 Server 要求精确的 Alembic revision `v2_7`，并报告产品 schema version `2.7`。

| Revision | 迁移目的 |
| --- | --- |
| `v1_legacy` | 为最后一个受支持的无版本 v1 布局打 fingerprint 和 stamp。 |
| `v2_0` | 创建严格的 v2 schema，迁移 device runtimes，添加 selection columns，并把 `waiting_approval`/`error` session 映射为 `blocked`。 |
| `v2_1` | 为 Connector presence 添加 Server instance 和 connection fencing 字段。 |
| `v2_2` | 迁移 runtime settings 和 selections，并把 legacy rows 归档到 `legacy_import_archive`。 |
| `v2_3` | 在归档和转换后移除 approvals 以及 legacy catalog/settings 表。 |
| `v2_4` | 把 protocol capability 和 catalog revision 扩到 PostgreSQL `BIGINT`。 |
| `v2_5` | 引入中间持久化 `session_states` 投影。 |
| `v2_6` | 移除 `session_states`；runtime state 和 selections 变成实时 runtime 事实。 |
| `v2_7` | 移除持久化 notices；runtime notices 变成实时 runtime 事实。 |

v2.3、v2.6 和 v2.7 迁移故意只支持向前。不要把数据库 downgrade 当成回滚方案。

## 导入 v1 SQLite 数据库

导入工具会以只读方式打开原始 SQLite 文件，通过 SQLite backup API 复制一份，只升级这份副本，创建或升级目标 PostgreSQL schema，在一个事务里完成导入，并逐表比较 row count 和 SHA-256 digest。

### 演练

先创建一个空的一次性 PostgreSQL 数据库，然后从 `server/` 运行：

```bash
uv run python -m agent_server.infra.db.migrations rehearse-v1 \
  --source-sqlite /backup/agent-server.sqlite3 \
  --target-url postgresql+asyncpg://agents:password@db/agents_rehearsal \
  --report migration-report.json
```

目标数据库不能包含任何产品数据行。把报告和发布产物放在一起保存；安排正式切换前，必须调查每一个失败项。

### 最终导入

停止所有 v1 writer 后，对一个新建的空生产目标库运行同一条已经验证过的命令，并保存单独的报告：

```bash
uv run python -m agent_server.infra.db.migrations rehearse-v1 \
  --source-sqlite /backup/final-agent-server.sqlite3 \
  --target-url postgresql+asyncpg://agents:password@db/agents_production \
  --report final-migration-report.json
```

虽然命令名里有 `rehearse-v1`，但这个操作会写入目标数据库。永远不要把它指向一个已经有数据的数据库。

如果是全新的空 v2 安装，可以跳过 legacy import，运行：

```bash
AGENT_SERVER_DB_URL=postgresql+asyncpg://agents:password@db/agents_production \
  uv run python -m agent_server.infra.db.migrations upgrade
```

启动 Server 前先验证：

```bash
AGENT_SERVER_DB_URL=postgresql+asyncpg://agents:password@db/agents_production \
  uv run python -m agent_server.infra.db.migrations current --verbose
```

预期输出里应该包含 `schemaVersion=2.7 revision=v2_7`。

## API 命名空间

所有产品 HTTP、SSE 和 WebSocket endpoint 都迁到 `/api/v2` 下：

| `main` | v2 |
| --- | --- |
| `/health` | `/api/v2/health` |
| `/auth/*` | `/api/v2/auth/*` |
| `/oauth/*` | `/api/v2/oauth/*` |
| `/connectors/*` | `/api/v2/connectors/*` |
| `/connector/*` | `/api/v2/connector/*` |
| `/pairing/*` | `/api/v2/pairing/*` |
| `/sessions/*` | `/api/v2/sessions/*` |

使用 [API namespace](../../api/namespace.md) 中描述的共享 namespace helpers。不要在每个 call site 手动拼接 `/api/v2`。

## 会话 API 迁移

`main` 里合并在一起的 session API，在 v2 里按归属拆开。重要替换如下：

| `main` 路由 | v2 路由 |
| --- | --- |
| `PATCH /sessions/{id}` | `PATCH /api/v2/sessions/{id}/meta` |
| `POST /sessions/{id}/read` | `POST /api/v2/sessions/read`，body 是直接的 id array |
| `POST /sessions/bulk-archive` | `POST /api/v2/sessions/archive` 或 `/unarchive`，body 是直接的 id array |
| `GET /sessions/{id}/state` | 按归属改用 `/api/v2/sessions/{id}/meta`、`/timeline`、`/runtime/state` 或 `/snapshot` |
| `GET/PATCH /sessions/{id}/runtime-settings` | Runtime config routes 加 `/api/v2/sessions/{id}/runtime/selections` |
| `POST /sessions/{id}/messages` | `POST /api/v2/sessions/{id}/runtime/messages` |
| `POST /sessions/{id}/interrupt` | `POST /api/v2/sessions/{id}/runtime/interrupt` |
| `POST /approvals/{id}/resolve` | `POST /api/v2/sessions/{id}/runtime/notices/{noticeId}/respond` |
| 前端构造的 commands | `GET/POST /api/v2/sessions/{id}/runtime/commands` |
| 新建空 session 并发送第一条消息 | `POST /api/v2/sessions/create-and-start` |

Message payload 只携带 content、attachments 和 `clientMessageId`。它们不携带一次性的 model 或 permission 字段。已有 session 发送消息前，selection 变化要先通过 `PATCH /runtime/selections`。runtime 是最终校验方。

完整 route inventory 见 [Session API current gap](../../api/session-api-current-gap.md)，客户端行为见 [客户端](./clients.md)。

## 启动和 readiness

v2 Server 在正常启动时不会修改生产 schema。先启动专门的 migrator，再启动 Server。Readiness 必须返回 HTTP 200：

```bash
curl --fail http://127.0.0.1:8000/api/v2/health/ready
```

确认：

- database status 是 `ok`，schema version 是 `2.7`；
- 分布式部署中 Redis status 是 `ok`；
- Server instance id 存在；
- 陈旧或无版本数据库会返回 503，而不是继续服务流量。

还要迁移 file-storage payload，并验证 attachment 下载。数据库导入只迁移 metadata，不迁移外部或本地文件字节。
