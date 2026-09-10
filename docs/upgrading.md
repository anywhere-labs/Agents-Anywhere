# 升级到 v2 主线

## 先区分三个版本

本次产品与客户端版本为 **2.0.0**；当前源码中的数据库 revision 为 **`v2_35`**，schema version 为 **`2.35`**；Connector 包仍有独立版本号。不要用这些数字互相推断兼容性。

`main` 现在承载 v2。本文所说的 **v1 / 旧主线** 指主线切换前的实现，源代码提交为 `6c47e419`，不再指当前 `main`。早期 [main-to-v2 文档](migrations/main-to-v2/README.md)保留作历史参考。

## 已经运行 v2 的部署

1. 记录当前镜像或提交、环境配置、客户端版本和数据库 revision。备份 PostgreSQL、文件存储及 Connector 配置；保留原镜像。
2. 在隔离环境演练迁移。所有旧 Server 和外部数据库写入进程都停止后，才执行生产迁移。
3. 使用准备部署的同一份源码或镜像执行迁移：

   ```bash
   cd server
   uv sync
   uv run python -m agent_server.infra.db.migrations current --verbose
   uv run python -m agent_server.infra.db.migrations upgrade
   uv run python -m agent_server.infra.db.migrations current --verbose
   ```

   以上命令使用该环境的 `AGENT_SERVER_DB_URL`。当前目标应为 `v2_35`；以后升级时，以待部署源码的 `CURRENT_SCHEMA_REVISION` 为准。
4. 启动同一版本的 Server/Web，检查 `/api/v2/health/ready`，再恢复入口流量和 Connector。验证账号登录、设备连接、会话恢复、消息、审批、文件和终端。
5. 使用 [2.0.0 下载入口](../README.md#下载与入口)升级客户端。当前安装包没有可用的应用内下载地址，需手动分发。

Compose 的 `migrate-next` 会在新 Server 前执行迁移，但不会停止另一个 Compose 项目、旧容器或外部写入者。部署者需要先停止旧写入进程。不要把代码分支切换当成数据库迁移。

## 从 v1 SQLite 部署迁移

v2 Server 运行时使用 PostgreSQL。SQLite 仅作为旧数据导入源和隔离测试工具，不是 v2 的生产数据库选项。

1. 盘点旧版数据库、文件存储、账号、Connector 数据目录和 Runtime。旧版 ACP adapters 没有被重新引入当前 providers；依赖它们的机器应先确定迁移方案。
2. 停止 v1 写入，备份 SQLite、文件数据和部署配置。首次运行 v2 Connector 前备份 `~/.agent-server` 或自己的配置目录。
3. 先向独立、空的 PostgreSQL 目标演练导入：

   ```bash
   cd server
   uv sync
   uv run python -m agent_server.infra.db.migrations rehearse-v1 \
     --source-sqlite /backup/agent-server.sqlite3 \
     --target-url postgresql+asyncpg://agents:password@db/agents_rehearsal \
     --report migration-report.json
   ```

   工具只读打开源文件，升级它的副本，导入并核对行数和 SHA-256。保留报告；文件 payload 需要另外复制和验证。正式导入同样需要空目标，并在停止旧写入后的最终备份上执行。
4. 完成 v2 schema 升级、文件后端配置和 Redis 配置，再一起切换 Server、Web、Connector 与客户端。
5. 检查旧账号的邮箱登录迁移。[邮箱账号与昵称](migrations/main-to-v2/email-accounts.md)说明旧用户名登录停止支持的边界，不能假定数据库升级后所有账号无需处理即可登录。

旧版客户端不能仅通过补上 `/api/v2` 就获得兼容性：Session、Runtime 和实时恢复契约也发生了变化。

## Redis 与备份

当前 Compose 使用 Redis AOF、`appendfsync everysec`、持久化卷和 `noeviction`。Redis 中存在尚未刷入 PostgreSQL 的 Timeline 数据，因此不能再按早期文档把它当成可随意清空的临时协调层。Redis ACL 还需要允许 `INFO server`。

AOF 每秒同步仍存在最后未同步区间的数据丢失窗口。完整的 Timeline 刷写与 revision lease 语义见 [Server README](../server/README.md)；部署前结合实际数据量安排维护窗口。

## 回滚

保留旧应用、数据库和文件存储的配套备份。若新版已写入，直接换回旧二进制不等于安全回滚；默认采用停止流量并恢复旧环境的方式。不要让旧版 Server 连接迁移后的数据库，也不要让不同 schema 预期的写入者同时运行。恢复旧备份会失去切换后的新数据，需先明确如何保留这些数据。

## 升级验收

- 目标 revision 与待部署源码一致，readiness 成功。
- PostgreSQL、文件存储、Connector 配置的备份和恢复已经演练。
- 实际使用的 Runtime 能发现、启动、恢复会话，并报告可用能力。
- 登录、设备连接、消息和审批、文件与终端在所用客户端可用。
- 原有账号的邮箱绑定与登录流程确认可用。
- 部署记录保留提交、镜像、安装包和验证结果，不包含凭据。

这是运维验收清单；源码主线合并和安装包发布并不证明某个生产实例已经完成上述迁移。
