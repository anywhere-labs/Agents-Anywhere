# Agent Server

Agents Anywhere 的 FastAPI 后端。服务器负责认证、用户、连接器、持久化的会话元数据
与 Timeline、文件元数据、交互路由、终端代理，以及 Connector RPC 分发。

## 目录结构

```text
agent_server/
  api/          FastAPI HTTP/WebSocket 传输层与错误映射
  core/         与 API 无关的领域值、模型与校验
  infra/        PostgreSQL/Redis/文件仓库与运行时 broker
  services/     用例、应用错误与依赖端口
  app.py        FastAPI 应用工厂与本地 uvicorn 启动辅助
tests/          后端测试
pyproject.toml  服务器依赖
run.sh          基于 PostgreSQL 的本地开发辅助脚本
```

## 运行

安装依赖：

```bash
uv sync
```

PostgreSQL 是 v2 的运行时数据库。先准备好 PostgreSQL 与 Redis，再从本目录启动后端：

```bash
AGENT_SERVER_DB_URL=postgresql+asyncpg://agents:password@127.0.0.1:5432/agents_anywhere \
  uv run python -m agent_server.infra.db.migrations upgrade

AGENT_SERVER_DB_URL=postgresql+asyncpg://agents:password@127.0.0.1:5432/agents_anywhere \
AGENT_SERVER_REDIS_URL=redis://127.0.0.1:6379/0 \
  uv run uvicorn agent_server.app:create_app --factory --host 127.0.0.1 --port 8000
```

SQLite 不是受支持的服务器运行时后端。它仅作为一次性 v1 旧数据导入工具的只读来源
格式，以及隔离的迁移测试用途保留。

服务器要求数据库处于精确的 Alembic schema 版本，启动过程中不会修改生产数据库。
`upgrade` 会为未版本化的 v1 数据库建立指纹、归档需要的旧数据，并把所有修订应用
到当前 schema（`v2_35`）。查看已安装的修订版本：

```bash
uv run python -m agent_server.infra.db.migrations current --verbose
```

在一个一次性的空 PostgreSQL 数据库上演练 v1 SQLite 迁移：

```bash
uv run python -m agent_server.infra.db.migrations rehearse-v1 \
  --source-sqlite /path/to/v1.sqlite3 \
  --target-url postgresql+asyncpg://agents:password@127.0.0.1:5432/agents_rehearsal \
  --report migration-report.json
```

源库以只读方式打开，并通过 SQLite 的 backup API 复制；升级只针对副本。PostgreSQL
目标库中不能有任何产品数据行；工具在单个事务里导入，并按行数与 SHA-256 校验每张表。
仅存在于旧版的行与旧版 JSON 列保留在 `legacy_import_archive` 中；被取代的源表和列
由 `v2_3` 移除。

### v2.24 上线与降级边界

不要让 `v2.23`（或更早）与 `v2.24` 的写入进程同时写同一个数据库。先停止所有旧的
Server 以及其他可能写会话或 Timeline 数据的进程，把数据库从 `v2_24` 迁移到当前
head（`v2_35`），然后再启动新写入进程。PostgreSQL advisory 锁会串行化迁移进程，
但不会隔离已经在运行的应用写入进程。

这次 PostgreSQL 迁移会把相关 sequence 列从 `int4` 扩到 `int8`。这些类型变更可能
持有较强的表锁，并依据 PostgreSQL 版本与表/索引形态重写存储。请先在生产规模的
副本上演练迁移、确认锁与耗时特征、做好备份，并安排合适的维护窗口。

降级前必须停止所有写入进程。一旦某个会话存在活跃且未消费的 lease
（`seq_allocated_high <> seq`），降级通常会拒绝执行；sequence 值超出有符号 32 位
范围时同样拒绝。正常的 `v2.24` 流量可能立即产生这种 lease 状态，因此不要把原地
schema 降级当作写入进程重启后的回滚手段。

在空数据库上首次启动时会打印一个 bootstrap token。用这个 token 在 Web 界面创建
第一个管理员用户。

健康检查：

```bash
curl http://127.0.0.1:8000/api/v2/health
curl http://127.0.0.1:8000/api/v2/health/ready
```

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `AGENT_SERVER_WORKERS` | 通过 `uv run python -m agent_server.main` 或服务器 Docker 镜像启动时的 Uvicorn worker 数量。默认 `1`。大于 1 需要 Redis，且不允许 `AGENT_SERVER_TIMELINE_SINGLE_INSTANCE`。 |
| `AGENT_SERVER_EVENT_WORKERS` | **每个 Uvicorn worker** 用于大型出站会话事件的计算子进程数。默认 `2`；`0` 表示关闭卸载。 |
| `AGENT_SERVER_EVENT_THRESHOLD_BYTES` | 发送到计算子进程的最小 UTF-8 envelope 尺寸。默认 `262144`（256 KiB）。更小的事件使用共享的内联准备路径。 |
| `AGENT_SERVER_EVENT_QUEUE_ITEMS` | 每个 Uvicorn worker 允许排队的大型事件任务数上限（含等待与运行中）。默认 `32`。 |
| `AGENT_SERVER_EVENT_QUEUE_BYTES` | 每个 Uvicorn worker 允许排队的大型事件输入字节数上限。默认 `33554432`（32 MiB）。这不是进程总内存限制。 |
| `AGENT_SERVER_HOST` / `AGENT_SERVER_PORT` | `agent_server.main` 的绑定地址/端口。默认 `127.0.0.1:8000`；Docker 镜像将 host 设为 `0.0.0.0`。 |
| `AGENT_SERVER_DB_URL` | 必需的 PostgreSQL SQLAlchemy URL，使用 `postgresql+asyncpg` scheme。 |
| `AGENT_SERVER_DB_BACKEND` | 可选的后端断言。运行时设置时必须为 `postgres`。 |
| `AGENT_SERVER_DB_POOL_SIZE` | PostgreSQL 基础连接池大小。默认 `10`。 |
| `AGENT_SERVER_DB_MAX_OVERFLOW` | 每实例的 PostgreSQL 溢出连接数。默认 `20`。 |
| `AGENT_SERVER_DB_POOL_TIMEOUT` | 从 PostgreSQL 连接池获取连接的等待秒数。默认 `30`。 |
| `AGENT_SERVER_DB_POOL_RECYCLE` | PostgreSQL 连接回收间隔（秒）。默认 `1800`。 |
| `AGENT_SERVER_MIGRATION_LOCK_TIMEOUT` | 迁移进程等待 PostgreSQL advisory 锁的秒数。默认 `120`。 |
| `AGENT_SERVER_REDIS_URL` | Redis URL，用于生产/分布式的 Connector 在线状态、RPC 路由、失效通知、单次 WebSocket ticket、分布式锁，以及 Timeline 实时序列器/写缓冲。未设置时只有单进程开发回退可用。 |
| `AGENT_SERVER_REDIS_PREFIX` | Redis key/频道前缀。默认 `agents-anywhere`。 |
| `AGENT_SERVER_REDIS_CONNECT_TIMEOUT` | Redis 连接超时（秒）。默认 `5`。 |
| `AGENT_SERVER_REDIS_HEALTH_CHECK_INTERVAL` | Redis 连接健康检查间隔（秒）。默认 `30`。 |
| `AGENT_SERVER_TIMELINE_REVISION_LEASE_SIZE` | 每个 Redis sequence lease 从 PostgreSQL 预留的 Timeline revision 数量。默认 `4096`。更大的 lease 减少数据库写入，但 Redis 状态丢失后会留下更大的未用 sequence 空洞。 |
| `AGENT_SERVER_INSTANCE_ID` | 可选的服务器实例 ID，用于 Connector RPC 路由。多 worker 时会追加进程 ID，避免 worker 争抢同一条 RPC 路由。未设置时生成随机 ID。 |
| `AGENT_SERVER_FILES_BACKEND` | 文件存储后端。`local` 或 `s3`。默认 `local`。 |
| `AGENT_SERVER_FILES_LOCAL_ROOT` | 本地附件/文件根目录。默认位于数据库文件旁边。 |
| `AGENT_SERVER_FILES_S3_BUCKET` | `AGENT_SERVER_FILES_BACKEND=s3` 时的 S3 bucket 名称。 |
| `AGENT_SERVER_FILES_S3_PREFIX` | 可选的 S3 key 前缀。 |
| `AGENT_SERVER_FILES_S3_ACCESS_KEY` | S3 access key。 |
| `AGENT_SERVER_FILES_S3_SECRET_KEY` | S3 secret key。 |
| `AGENT_SERVER_FILES_S3_REGION` | S3 region。默认 `us-east-1`。 |
| `AGENT_SERVER_FILES_S3_ENDPOINT_URL` | 可选的 S3 兼容端点 URL。 |
| `AGENT_SERVER_FILES_S3_VIRTUAL_HOST_STYLE` | 设为 `true` 时使用 virtual-host 风格的 S3 URL。 |
| `AGENT_SERVER_SECRET` | 用于签名认证 token 的密钥。本地开发之外必须设置。 |
| `AGENT_SERVER_SETUP_TOKEN_TTL` | 首次运行 setup token 的有效期（秒）。 |
| `AGENT_SERVER_PUBLIC_ORIGIN` | 反向代理头或 `returnTo` 不可用时，用于 OAuth 回调 URL 的公开 Web origin。示例：`https://agents.example.com`。 |
| `AGENT_SERVER_CORS_ORIGINS` | 逗号分隔的显式 CORS origins。 |
| `AGENT_SERVER_CORS_ORIGIN_REGEX` | CORS origin 正则。默认匹配本地 `localhost` / `127.0.0.1` 端口。 |
| `AGENT_SERVER_STATIC_DIR` | 前端构建产物目录。设置后 `/` 返回 `index.html`，`/assets` 提供静态资源。 |

缓冲区刷写之后，PostgreSQL 是 Timeline 条目的持久事实来源。刷写之前，分布式部署
把已接受的 Timeline upsert 与实时 sequence head 保留在 Redis。sequence head 只在
从 PostgreSQL 持久租借的 revision 区间内前进，因此 Redis 丢失可能废弃一个区间，
但不会复用已分配过的 sequence 号。

Compose 的 Redis 服务关闭了 RDB 快照、开启 `appendfsync everysec` 的 AOF、把
`/data` 持久化到命名卷，并使用 `noeviction`。待刷写的 Timeline 与序列器 key 刻意
不设 TTL，绝不能被静默淘汰；短生命周期的协调 key 仍使用 TTL，且可以重建。在一条
已接受的 upsert 刷入 PostgreSQL 之前（或最近一次 AOF 落盘之前）发生 Redis/进程
故障，仍可能丢失那条未刷写的 upsert；带围栏的手动持久读取会先刷写待写的 Timeline
再读。

生产 Redis ACL 必须允许 `INFO server`。当前的高频 Timeline upsert 路径每次 upsert
都会通过该命令读取 `run_id`，并在为一次已接受变更分配 revision 后重新读取，因此
请与 Redis 服务提供方一起验证 ACL 权限和由此产生的 `INFO` 调用频率。

在 AOF `everysec` 下，最近一个尚未 fsync 的区间可能在 Redis 或主机故障中丢失。
未设置 `AGENT_SERVER_REDIS_URL` 时，本地回退把每条已接受但未刷写的 Timeline
payload 只保存在 Server 进程内存中，进程崩溃会丢失自上次刷写以来接受的所有
payload（通常最多一个配置的刷写间隔）。PostgreSQL 仍会防止 revision 复用，但被
废弃的 revision 会成为空洞，且无法重建丢失的 payload。此回退只用于单进程开发，
不是生产持久化模式。

分层边界、状态所有权与数据库版本规则见 `../docs/server-architecture.md`。

## 多 worker 部署

实测的 8 CPU 起步配置使用 `docker/docker-compose.8cpu.yml`：四个 Uvicorn worker
各带一个计算子进程，PostgreSQL 连接总上限 32，允许排队的事件输入 64 MiB。
运行时状态投影通过 Redis 共享，并为 Dashboard 列表一次性批量拉取。可重建的
运行时状态条目 24 小时过期；已接受的 Timeline 写入保留各自独立、不过期的持久化
规则。并发的后台状态刷新共享一个可续期的 Redis lease，避免每个 worker 各自要求
运行时重放同一个会话。

测试过的负载、队列/恢复行为与部署上限见[会话链路性能报告](../docs/performance/session-pipeline.md)。

## 主要 API 区域

所有产品 API、SSE 与 WebSocket 端点都挂在 `/api/v2` namespace 下。

- `/api/v2/auth/*`：bootstrap、注册、登录、当前用户、头像、修改密码。
- `/api/v2/admin/*`：实例设置、运行时 schema、用户管理、服务信息。
- `/api/v2/connectors/*`：连接器生命周期、偏好设置、运行时能力、基于 Connector RPC 的文件列表。
- `/api/v2/connector/*`：连接器认证、ingest、文件传输与 WebSocket RPC。
- `/api/v2/pairing/*`：浏览器配对流程，用于连接器登录/认领。
- `/api/v2/agents/*`：运行时模型目录、权限目录与配置 schema。
- `/api/v2/sessions/*`：会话生命周期、运行时设置、事件、接管、消息、交互回应、中断、同步、文件系统、shell、终端与上传。

Web 与 Connector 的 namespace 说明见 `../docs/api/namespace.md`。

## Web 前端

当前 Web 控制台位于 `../web-next`，作为 Next.js 应用运行。开发时先在
`127.0.0.1:8000` 启动 FastAPI 服务器，再启动 Next：

```bash
cd ../web-next
AGENTS_ANYWHERE_API=http://127.0.0.1:8000 yarn dev
```

仓库内置的生产 Dockerfile 会把 `web-next` 导出为静态文件，并由 FastAPI 通过
`AGENT_SERVER_STATIC_DIR=/app/web-static` 提供服务。API、WebSocket 与 Web 路径
共用同一个 origin。受支持的 Compose 部署见 [Docker](../docker/README.md)，迁移
顺序与备份要求见[升级指南](../docs/upgrading.md)。

手动准备的静态导出可以这样提供服务：

```bash
AGENT_SERVER_STATIC_DIR=/path/to/web-next/out \
  uv run uvicorn agent_server.app:create_app --factory --host 127.0.0.1 --port 8000
```

## 验证

```bash
uv run ruff check . --exclude .venv
uv run pytest -q
```

## 客户端版本检查

`GET /api/v2/health` 与 `/api/v2/health/live` 返回与服务器应用版本一致的
`version`。Desktop 和 Android 把已安装版本与该值比较，并使用各自配置中的固定下载
地址。`/client-releases/check` 与 `/admin/client-releases` API 以及发布管理页已
下线。

发布表的下线在 `v2_32` 引入。已有部署必须在重启前应用完整的当前迁移链至
`v2_35`：

```bash
uv run python -m agent_server.infra.db.migrations upgrade
```

迁移会把旧的发布表归档为 `_deprecated_app_releases`；历史发布数据保留，但不再有
运行时发布 API。
