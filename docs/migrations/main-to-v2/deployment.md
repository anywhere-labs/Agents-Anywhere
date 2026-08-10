# 部署和切换

使用 blue/green 迁移。v2 数据库链只支持向前，而且 v2 Connector 会执行会改动本地目录的迁移，所以原地 rollback 不是安全默认方案。

## 1. 盘点

修改任何东西之前先记录：

- 已部署的 `main` commit/image 和每个客户端版本；
- 从 `AGENT_SERVER_DB` 得到的 v1 SQLite 路径，以及它的文件大小/hash；
- 本地或 S3 file-storage 配置和 object 数量；
- Server secret、public origin、CORS、OAuth 和 setup configuration 的配置项名称；
- Connector ids、versions、hosts、config paths 和本地 data directories；
- 每个 Connector 的 active runtimes，特别是 ACP-backed runtimes；
- 当前 session/timeline/user/connector row counts；
- 可用 maintenance window 和 rollback decision owner。

不要在迁移报告里记录 secret values。

## 2. 备份 v1

最终备份前，先停止或静默写入。分别保留：

1. SQLite 数据库；
2. file-storage payloads；
3. 每个 Connector 的 `~/.agent-server` 目录，或显式 config/data path；
4. 部署配置和镜像引用。

依赖 SQLite 备份前，先验证它能正常打开。在 rollback window 内，保持 v1 Server 和客户端 artifacts 可运行。

## 3. 演练

准备一次性的 PostgreSQL 17 和 Redis 8 实例。把数据导入到空的演练数据库：

```bash
cd server
uv sync
uv run python -m agent_server.infra.db.migrations rehearse-v1 \
  --source-sqlite /backup/agent-server.sqlite3 \
  --target-url postgresql+asyncpg://agents:password@db/agents_rehearsal \
  --report migration-report.json
```

把 v2 Server 和 Web 部署到演练数据库上，然后至少升级一个一次性或已备份的 Connector host。完成验收 checklist。

如果生产依赖 ACP runtime、未迁移的移动端客户端，或者还没有复制并验证的 file backend，那么演练就不完整。

## 4. 准备 v2 基础设施

仓库里的 Compose 部署定义了预期顺序：

```bash
docker compose -f docker/docker-compose.postgres.yml up --build
```

它会依次启动 PostgreSQL、非持久化 Redis、一次性 migrator，然后启动 Server。托管基础设施也要保持同样顺序：

1. PostgreSQL ready；
2. Redis ready；
3. migration job 成功；
4. Server 启动并通过 readiness；
5. Web/client traffic 启用。

必需的 Server 变量包括：

```text
AGENT_SERVER_DB_URL
AGENT_SERVER_REDIS_URL
AGENT_SERVER_SECRET
```

为目标环境设置 pool、migration lock、file backend、public origin 和 CORS 变量。release record 里只记录变量名和状态，永远不要记录 secret values。

## 5. 最终数据切换

1. 禁用 v1 写入，并停止所有 v1 Server instances。
2. 生成并标识最终 SQLite 和 file-storage backups。
3. 创建一个新的空生产 PostgreSQL 数据库。
4. 对这个空目标库运行已经验证过的 `rehearse-v1` 导入命令，并保存最终报告。
5. 复制并验证 file-storage payloads。
6. 确认 `schemaVersion=2.7 revision=v2_7`。
7. 启动 v2 Server，并要求 `/api/v2/health/ready` 返回 200。
8. 启动匹配的 v2 Web 部署。

不要让 `main` 指向 PostgreSQL 目标库，也不要让 v2 Server 指向旧 SQLite 文件。

## 6. Connector 切换

按受控批次升级 Connectors：

1. 停止旧 Connector。
2. 确认它的 legacy directory backup 存在。
3. 安装 v2 package，并启动一次。
4. 检查迁移后的 `~/.agents-anywhere` 目录。
5. 确认 authentication 和 `/api/v2/connector/ws` connectivity。
6. 运行 discovery，并激活预期的 native runtimes。
7. 验证一个已有 session sync，以及一个新的 create-and-start flow。
8. 根据 declared capabilities 验证 attachments、interrupt、selections、notices 和 commands。

如果某个 Connector 必须提供 ACP runtime，在 v2 provider 存在或 workload 已迁走之前，不要升级它。

## 7. 客户端切换

只启用通过 [客户端迁移](./clients.md) 的客户端。v2 Web 客户端应该和 Server 一起部署。移动端分发要单独 gate，直到它的 removed-route inventory 为空。

监控：

- `/api/v2` 下的 HTTP 404/405/422 数量；
- Connector authentication/reconnect loops；
- Redis availability 和 ticket/RPC routing errors；
- database pool saturation 和 migration/readiness failures；
- session refetch loops、duplicate timeline items 和 optimistic-message leaks；
- runtime discovery/capability mismatches；
- attachment metadata 和 payload failures。

## 回滚

回滚是把流量切回保留下来的 v1 环境，不是 downgrade v2 数据库。

1. 停止 v2 写入。
2. 记录 v2 database 和 file-storage 状态用于诊断；不要销毁它。
3. 把用户流量切回切换时停止的 v1 Server、SQLite database、file store、Web、Connectors 和兼容客户端。
4. 如果第一次 v2 启动移动或删除了本地文件，从备份恢复 Connector legacy directories。
5. 后续重试前，处理切换窗口内 v2 已接受写入的对账问题。当前没有自动反向复制到 v1 的机制。

如果业务要求回滚时零 accepted-write loss，就让 v2 保持在只读验证阶段，直到做出发布决定。当前迁移工具链不提供双向复制。
