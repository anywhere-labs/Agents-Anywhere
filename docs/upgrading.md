# 升级到 v2 主线

## 先区分三个版本

本次产品版本为 **2.2.0**；当前源码中的数据库 revision 为 **`v2_48`**，schema version 为 **`2.48`**。各端的 PATCH 版本可以不同，数据库 revision 独立编号，不能用来推断兼容性，见[版本号规则](versioning.md)。

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

   以上命令使用该环境的 `AGENT_SERVER_DB_URL`。当前目标应为 `v2_48`；以后升级时，以待部署源码的 `CURRENT_SCHEMA_REVISION` 为准。
4. 启动同一版本的 Server/Web，检查 `/api/v2/health/ready`，再恢复入口流量和 Connector。验证账号登录、设备连接、会话恢复、消息、审批、文件和终端。
5. 使用 [README 下载表](../README.md#下载与入口)升级客户端。从 2.1.0 起，Desktop（macOS、Windows）和 Android 的「立即更新」会从官网下载最新安装包。2.2.0 的安装包尚未记录，见[发布说明](releases/2.2.0.md)。

Compose 的 `migrate-next` 会在新 Server 前执行迁移，但不会停止另一个 Compose 项目、旧容器或外部写入者。部署者需要先停止旧写入进程。不要把代码分支切换当成数据库迁移。

## 从 v1 部署升级

v1 数据导入只在 2.0.x 提供。仍在 v1 的部署要先检出 2.0.x 的源码，按该版本的本文档完成导入，再升级到 2.2.0。

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

## 会话清单扫描（`v2_48`）

`v2_48` 新增一张记录进行中扫描的小表 `session_inventory_scans`，并给 `sessions` 增加可空列 `source_changed_seq`。这两步都不会重写 `sessions` 表，已有行保持 `NULL`。迁移后，内容没有变化的清单扫描不再改写 `sessions` 行，旧版 Connector 无须升级也能受益。

- 接口字段 `sourceAvailabilityUpdatedAt` 现在表示来源状态最后一次写入的时间，不再随每次扫描刷新。
- `source_scan_token` 列保留到后续版本再删除，以便回滚到上一版 Server；新版 Server 不再读写它。

## 统一目标模式

使用 Goal 时，先升级 Server 数据库至 `v2_47` 和服务，再升级 Connector 及客户端。迁移只新增 Goal 表，旧会话无需回填；旧 Connector 不声明目标能力。详情见 [Goal API 与持久化](api/goals.md)。产品版本未在本次修改。
