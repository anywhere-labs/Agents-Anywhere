# Agents Anywhere v3 轻控制面（`server-v3`）

Agents Anywhere v3 的轻控制面后端，实现定稿架构文档中定义的 `aa.v3.Control` MeshCall 服务与 FastAPI HTTP 端点（登录、OAuth、MCP Streamable HTTP 与健康检查），**不保存任何对话内容、消息正文、附件或设备级设置**。

## 相关文档

- 总体架构（控制面、隧道、聚合 RPC 与 MCP）：[docs/v3/architecture-proposal.md](../docs/v3/architecture-proposal.md)
- 加密设备准入与端到端加密：[docs/v3/e2ee-admission-proposal.md](../docs/v3/e2ee-admission-proposal.md)
- 跨端契约（1.0）：[contracts/aa-v3/1.0/README.md](../contracts/aa-v3/1.0/README.md)
- 2.x → 3.0 数据清理迁移与短停服指南：[docs/v3/migration-3.0.md](../docs/v3/migration-3.0.md)

## 已实现功能

- **账号与凭据（FastAPI）**：
  - 密码登录与首次管理员注册（100% 兼容 2.x `pbkdf2_sha256` 密码摘要）、Refresh Token 轮换与撤销、可选外部 OAuth 登录回调；
  - 客户端换取 Router `mt_` Token（签发 `principal = user:<uid>/client:<cid>`，scope 仅限 `aa.v3.Control/*`）；
  - 设备注册与换取设备 Router `mt_` Token（仅存设备密钥 SHA-256 摘要，签发 `register: true` + `instance_ids: [device_id]` 与 `principal = device:<did>`）；
  - Redis 限流保护（抵御 Router 重启重连风暴）。
- **控制面 RPC（MeshCall `aa.v3.Control`）**：
  - 借助 `meshcall v0.4.0` 的 `meshcall-token-principal` 识别客户端/设备身份，同时支持 WebSocket 与 Router HTTP 映射（`/v1/call/aa.v3.Control/<method>`）；
  - 设备元数据管理、Connector 长连接 `presence` 心跳流（Redis TTL）、跨实例 `watch_devices` 实时流（Redis Pub/Sub）；加密设备强制剥离 `summary`；
  - `open_tunnel` / `revoke_tunnel` 双模式隧道准入（加密设备强制要求 `e2e_key`，绝不降级为明文隧道）；
  - 普通设备聚合扇出 `list_sessions`（服务端流先回先推，独立超时）与 `list_sessions_once`（一元版），加密设备返回 `status: encrypted` 占位；
  - 固定 4 项 `aa.v3.DeviceAdmin` 代理（`ping`、`close_tunnel_sessions`、`check_update`、`rename`）。
- **推送通知管线**：
  - `clients` 表登记移动端/桌面端 `push_token`；
  - **加密设备强制无正文推送**（服务端彻底剥离 `title`、`body`、`session_id`，只发通用提醒）；
  - Redis 队列 + 指数退避重试与死信队列；可插拔 `PushProvider` 接口（真实 APNs / FCM 发货客户端在 T513 联调补齐）。
- **MCP（`/mcp` Streamable HTTP）**：
  - OAuth 2.1 发现元数据、RFC 7591 动态客户端注册、PKCE S256 授权码、授权预览（`approvals:answer` 默认不勾选、加密设备不可选）、授权查询与撤销；
  - 7 个工具：`list_devices`、`list_sessions`、`read_session`、`create_session`、`send_message`、`stop_session`、`answer_approval`，严格过滤加密设备，透传 `aa-via: mcp`，审计日志只记元数据不存对话内容。
- **3.0 数据库迁移（`migrations/versions/v3_0.py`）**：
  - 支持空库全新初始化，也支持从 2.x PostgreSQL 原地升级：仅保留 `users` 和 `oauth_accounts`，清理其余全部 2.x 旧表（含会话、时间线、`instance_settings` 等）。

## 目录分层

| 目录 | 职责 | 依赖约束 |
| --- | --- | --- |
| `aa_control/core/` | 配置、契约模型、密码与凭据原语、错误定义 | 不依赖 FastAPI、SQLAlchemy、Redis、MeshCall 或外层模块 |
| `aa_control/services/` | 用例编排（认证、设备、隧道、扇出、推送、MCP） | 不依赖 FastAPI / Starlette / 传输层 |
| `aa_control/infra/` | PostgreSQL 仓储、Redis 协调与重试队列、MeshCall Router 池、Push Worker | 依赖 `core` |
| `aa_control/rpc/` | MeshCall `aa.v3.Control` 服务宿主（含 WorkerLoop→主事件循环桥接） | 依赖 `core`、`services` |
| `aa_control/api/` | FastAPI HTTP 路由（登录/OAuth/设备注册/MCP/健康检查） | 依赖 `core`、`services` |

## 如何运行

### 1. 环境准备

依赖 **PostgreSQL 17+**、**Redis 7/8+**（单一实现，无无-Redis 模式）以及一个或多个 **`meshcall-router` v0.4.0+** 实例。

主要环境变量：

| 变量 | 说明 | 示例 |
| --- | --- | --- |
| `AA_CONTROL_DB_URL` | PostgreSQL 连接串 | `postgresql+asyncpg://agents_anywhere:pass@127.0.0.1:55432/agents_anywhere` |
| `AA_CONTROL_REDIS_URL` | Redis 连接串 | `redis://127.0.0.1:56379/0` |
| `AA_CONTROL_SECRET` | JWT 与签名密钥（生产至少 32 字符） | `change-me-in-production` |
| `AA_CONTROL_PUBLIC_ORIGIN` | 对外可访问地址（OAuth/MCP 元数据） | `https://aa.example.com` |
| `AA_CONTROL_ROUTER_URL` | 单个 MeshCall Router WS 地址（多实例用 `AA_CONTROL_ROUTERS_JSON`） | `ws://127.0.0.1:8765` |
| `AA_CONTROL_ROUTER_PUBLIC_URL` | 返回给客户端连接的 Router 公网地址 | `wss://router.example.com` |
| `AA_CONTROL_ROUTER_USERNAME` / `AA_CONTROL_ROUTER_PASSWORD` | Router `auth.json` 中控制面账号凭据 | `control` / `...` |
| `AA_CONTROL_REGISTRATION_OPEN` | 是否开放自助注册（首账号始终为 admin） | `true` / `false` |
| `AA_CONTROL_SETUP_TOKEN` | 可选：限制首次管理员注册所需的一次性 token | — |

### 2. 数据库迁移与启动

```bash
cd server-v3
uv sync
uv run alembic upgrade head
uv run python -m aa_control.main
```

### 3. 本地验证与测试

```bash
cd server-v3
uv run ruff check aa_control migrations tests
uv run pytest -v
```

指定真实 PostgreSQL（库名必须含 `test`，测试会清空表）与真实 Redis 运行全套集成测试：

```bash
AA_CONTROL_TEST_DB_URL="postgresql+asyncpg://postgres:postgres@127.0.0.1:55432/aa_control_test" \
AA_CONTROL_TEST_REDIS_URL="redis://127.0.0.1:56379/1" \
uv run pytest -v
```

如果本机或 `MESHCALL_ROUTER_BINARY` 环境变量指向 `meshcall-router` v0.4.0 可执行文件，`tests/test_meshcall_router_e2e.py` 会自动拉起真实 Router 进程验证 HTTP/WS `meshcall-token-principal`、`presence` 流、普通设备扇出和 `Noise_IK`/`Noise_IKpsk2` E2E 隧道。

## 注意事项

- `server-v3/` 当前与 2.x 的 `server/` 并行存放，互不干扰；待 3.0 正式切换时再将旧 `server/` 归档到 `_deprecated/`。
- `meshcall-py` 的 `RpcServer` 在独立后台线程的 `WorkerLoop` 上执行处理器，`ControlRpcService` 已内置主事件循环桥接，确保 `asyncpg`、`redis.asyncio` 与 `MeshCallRouterPool` 始终在同一事件循环内运行。
- 本阶段不提交 `uv.lock`（仓库统一忽略 lockfile）。
