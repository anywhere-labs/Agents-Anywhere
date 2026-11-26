# Agents Anywhere 2.x → 3.0 数据清理迁移与短停服方案

> **已停用（2026-11-26）**：旧 v3 实现，已移入 `_deprecated/`，不参与构建与 CI。v3 按 [新版全栈架构](../../v3/next-architecture-proposal.md) 干净重写；需要复用某个模块时把它移回新项目并按新架构改写。

本文面向部署者，说明从 Agents Anywhere 2.x（`server/`，`v2_56`）升级到 3.0 轻控制面（`server-v3/`，`v3_0`）时的停服窗口、数据去留与回滚步骤。

## 1. 数据变化一览

Agents Anywhere 3.0 中，Server 变为纯轻控制面，**不再保存任何会话、消息、附件、项目、终端、用量统计、模型配置或全局实例设置**（单设备设置改由隧道 RPC `aa.v3.Device` 管理，控制面服务配置改由环境变量提供）。

| 类别 | 处理方式 |
| --- | --- |
| `users`（账号、邮箱、`pbkdf2_sha256` 密码摘要、角色） | **完整保留**，3.0 可直接用原密码登录 |
| `oauth_accounts`（外部 OAuth 账号绑定） | **完整保留** |
| `sessions`、`timeline_items`、`projects`、`session_shares`、Goal/Planning/Queue、附件预览令牌 | **永久删除**（对话唯一数据源为工作设备本机） |
| `connectors`、`device_runtimes`、`pairing_codes` 等 2.x 设备表 | **永久删除**（3.0 需由新 Connector 重新注册设备） |
| `usage_*`、`model_*`、`channel_*`、`tokens_links*`、`instance_settings` | **永久删除** |
| 新建表：`refresh_tokens`、`devices`、`device_credentials`、`clients`、`mcp_oauth_clients`、`mcp_auth_codes`、`mcp_grants`、`audit_logs` | **自动创建** |

> [!WARNING]
> `v3_0` 迁移会删除全部 2.x 历史会话与配置表且**不可逆（`downgrade()` 会主动拒绝）**。执行迁移前**必须**完成数据库全量备份。

## 2. 短停服窗口操作步骤（预计 3～5 分钟）

1. **通知用户并停止 2.x 服务**
   - 停止所有 2.x `agent-server` 实例与后台 worker，确认不再有写入连接。
2. **全量备份 PostgreSQL**
   ```bash
   pg_dump --format=custom --file=aa-v2-backup-$(date +%Y%m%d%H%M%S).dump "$AA_CONTROL_DB_URL_SYNC"
   ```
3. **部署并启动 MeshCall Router（v0.4.0+）**
   - Router 放在 TLS 反向代理之后（关闭 nginx 请求/响应缓冲）；
   - `auth.json` 仅配置控制面账号（具备 `aa.v3.*` 与 `meshcall.router.v1.{AuthService,TunnelService,Registry}/*` 权限），**不要开启 `anonymous`**。
4. **执行 3.0 数据库迁移**
   ```bash
   cd server-v3
   AA_CONTROL_DB_URL="postgresql+asyncpg://..." uv run alembic upgrade head
   ```
   - 迁移会在单个事务内删除旧表、保留 `users` 与 `oauth_accounts` 并创建 3.0 新表。
5. **清空旧 Redis 键并启动 `server-v3`**
   - 2.x 的 Redis 键（Timeline 写入缓冲、旧连接租约）在 3.0 中不再使用；启动前可 `FLUSHDB` 对应逻辑库；
   - 配置 `AA_CONTROL_DB_URL`、`AA_CONTROL_REDIS_URL`、`AA_CONTROL_SECRET`、`AA_CONTROL_ROUTER_*` 等环境变量后启动 `server-v3`；
   - 访问 `GET /readyz` 确认 `postgres`、`redis`、`meshcall_routers` 三项均为 `true`。
6. **恢复客户端与设备接入**
   - 用户使用原账号密码或原 OAuth 账号登录 3.0 客户端；
   - 工作设备升级到 v3 Connector 后重新注册设备（如需端到端加密，扫码完成本机配对）。

## 3. 回滚方案

如需回滚到 2.x：

1. 停止 `server-v3` 与 MeshCall Router；
2. 使用步骤 2 备份的 `.dump` 文件执行 `pg_restore --clean --if-exists` 恢复 PostgreSQL；
3. 重新启动 2.x `server/` 镜像。
