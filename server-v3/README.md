# Agents Anywhere v3 轻控制面（`server-v3`）

Agents Anywhere v3 的轻控制面后端，实现定稿架构文档中定义的 `aa.v3.Control` MeshCall 服务与 FastAPI HTTP 端点（登录、OAuth、MCP Streamable HTTP 与健康检查），**不保存任何对话内容、消息正文、附件或设备级设置**。

## 相关文档

- 总体架构（控制面、隧道、聚合 RPC 与 MCP）：[docs/v3/architecture-proposal.md](../docs/v3/architecture-proposal.md)
- 加密设备准入与端到端加密：[docs/v3/e2ee-admission-proposal.md](../docs/v3/e2ee-admission-proposal.md)
- 随身助手（Pi Lite）与限额大文件云盘：[docs/v3/assistant-and-files-proposal.md](../docs/v3/assistant-and-files-proposal.md)
- 跨端契约（1.0）：[contracts/aa-v3/1.0/README.md](../contracts/aa-v3/1.0/README.md)
- 2.x → 3.0 数据清理迁移与短停服指南：[docs/v3/migration-3.0.md](../docs/v3/migration-3.0.md)

## 已实现功能

- **账号、认证双模式与权益（FastAPI）**：
  - 支持 `AA_CONTROL_AUTH_MODE=oidc|local`（默认 `local`）：
    - **`oidc` 模式**（对接 `anywhere-auth` 统一认证中心或任意标准第三方 OIDC，如 Keycloak / Auth0 / Authentik）：通过 OIDC Discovery 自动发现与本地缓存 JWKS（支持 RS/ES/PS/EdDSA 非对称验签、密钥轮换热刷新与未知 `kid` 冷却防洪），本地零网络开销验签 Bearer JWT 获取全局 `sub` 并 JIT 同步本地影子用户（自动保留 2.x 迁移用户的 `users.id == sub`）；完整解析 `plan`、`entitlements`（通用扁平权益字典，如 `aa.max_devices`、`aa.drive_quota_mb`、`aa.drive_ttl_days`）与 `active_context`（个人/组织多身份上下文），在 `/devices/register` 执行 `aa.max_devices` 配额校验并在 `/auth/me` 返回生效权益；同时关闭本地账密登录/注册端点；
    - **`local` 模式**（单机开源自部署兜底）：保留内置密码登录与首次管理员注册（100% 兼容 2.x `pbkdf2_sha256` 密码摘要）、Refresh Token 轮换与撤销、可选外部 OAuth 登录回调；两种模式均支持通过 `AA_CONTROL_DEFAULT_ENTITLEMENTS_JSON` 配置默认权益基线；
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
  - Redis 队列 + 指数退避重试与死信队列；可插拔 `PushProvider` 接口；
  - **APNs 发送**（iOS）：HTTP/2 Provider API + `.p8` Token 认证（ES256 JWT 缓存、50 分钟内自动重签），支持 `sandbox` / `production`，按事件类型设置 `apns-push-type`、`apns-priority`、`apns-expiration` 与 `apns-collapse-id`；
  - **FCM HTTP v1 发送**（Android）：服务账号 JWT Bearer 换取 OAuth2 Access Token 并缓存，调用 `projects/<id>/messages:send`；
  - 平台响应分类：token 失效（APNs 410 / `Unregistered` / `BadDeviceToken`，FCM `UNREGISTERED` / token 字段 `INVALID_ARGUMENT`）自动清除该客户端 `push_token`；429 / 5xx / 网络错误按指数退避重试（尊重 `Retry-After`）；其他 4xx 直接进死信队列；日志不记录 token 与通知内容；
  - 未配置的平台（以及 `desktop` / `web`）保持只记日志不投递，启动日志与 `/readyz` 的 `push` 字段会显示 `configured` / `disabled`；客户端载荷字段见[跨端契约](../contracts/aa-v3/1.0/README.md#推送通知载荷apns--fcm)。
- **MCP（`/mcp` Streamable HTTP）**：
  - OAuth 2.1 发现元数据、RFC 7591 动态客户端注册、PKCE S256 授权码、授权预览（`approvals:answer` 默认不勾选、加密设备不可选）、授权查询与撤销；
  - 浏览器授权：配置 `AA_CONTROL_WEB_ORIGIN` 后，元数据里的 `authorization_endpoint` 指向 Web 的 `/oauth/authorize` 授权页；不带 `Authorization` 头访问控制面 `/oauth/authorize`（浏览器跳转）会 302 到该页面并原样保留查询参数，带 Bearer 的调用仍返回 JSON 预览 / 批准结果；未配置时 Claude、Cursor 等外部 MCP 客户端无法在浏览器里完成授权；
  - 7 个工具：`list_devices`、`list_sessions`、`read_session`、`create_session`、`send_message`、`stop_session`、`answer_approval`，严格过滤加密设备，透传 `aa-via: mcp`，审计日志只记元数据不存对话内容。
- **限额大文件云盘与对象存储中转（`/drive/*`、`/admin/drive/policies/*`）**：
  - 纯 Python 异步 S3 SigV4 预签名直传/下载（兼容 AWS S3、Cloudflare R2、MinIO、阿里云 OSS / 七牛云 Kodo 等 S3 兼容存储，支持内网 `AA_CONTROL_S3_ENDPOINT` 与客户端直连 `AA_CONTROL_S3_PUBLIC_ENDPOINT` 分离，流量不经控制面）；
  - 上传预签名强制签名 `Content-Length` 并在 `/complete` 校验 `HEAD` 字节数，防止绕过配额；
  - 默认 RPC 直传阈值 8 MiB（与 `connector-v3` 对齐），默认总配额 512 MiB、单文件上限 100 MiB、默认过期 7 天（上限 30 天）；配额与 TTL 按「管理员单账号策略覆盖 > OIDC/默认权益声明（`aa.drive_quota_mb`、`aa.drive_ttl_days`、`aa.drive_max_file_mb`）> 服务默认值」三层生效；
  - 双模式鉴权（用户 Bearer JWT 与 Connector `X-AA-Device-Id` / `X-AA-Device-Secret` 均可上传下载，且 Connector 自动继承用户 Redis 缓存的 OIDC 权益）；
  - 支持普通文件、助手云端 VFS（`assistant_vfs`，按 `vfs_path` 覆写并自动回收旧版本、`account_dek` 端侧加密剥离明文文件名）与加密设备大文件单次密钥中转（`ephemeral_key`，服务端绝不接收或存储 `file_key`）；内置后台定时清理过期文件、超时未完成预占和已删除文件的对象。
  - **文件系统（路径与文件夹）**：每个文件有规范化的绝对路径（如 `/报告/2026/q3.pdf`，同一账号下未删除的文件路径唯一），文件夹是显式记录（空文件夹也存在，根目录 `/` 隐含）；没有指定位置的上传放进 `/Transfers/`（重名加 ` (1)` 后缀），Orches 云端工作区的文件镜像为 `/Orches/<vfs_path>`（只由 Orches 同步写入，云盘接口只能列出、下载和删除），加密文件不因路径泄露名称（以文件 id 命名）。接口：`GET /drive/entries`（列出文件夹的直接子项，每个文件带到期时间）、`POST /drive/folders`、`PATCH /drive/files/{id}` 与 `PATCH /drive/folders/{id}`（重命名 / 移动，文件夹整棵子树跟着改，冲突返回 409 `drive_path_conflict`）、`DELETE /drive/folders/{id}`（递归软删除，对象当场尽量删除，余下交给清理任务）、`GET /drive/resolve?path=…|ref=drive:/…`；`POST /drive/uploads` 可用 `path` / `folder` / `on_conflict` 指定位置。文本引用格式为 `drive:/路径/文件名`（`aa_control/core/drive.py` 的 `format_drive_ref` / `parse_drive_ref`）。规则、错误码与引用格式见 [assistant-and-files-proposal.md](../docs/v3/assistant-and-files-proposal.md) 6.1–6.3。
- **随身助手整包同步、KEK/DEK 密钥信封与 Tokens Anywhere 托管 Key 复用（`/assistant/*`）**：
  - **对话级整包同步**：`GET /assistant/conversations`（仅返回列表元数据，按更新时间倒序）、`GET /assistant/conversations/{id}`、`PUT /assistant/conversations/{id}`（默认单条上限 20 MiB 返回 413、单账号保留最新 100 条自动淘汰旧对话）、`DELETE /assistant/conversations/{id}`；服务端不做新旧裁决，原样存储并通过 Redis Pub/Sub（`GET /assistant/events` SSE 流）向同账号其他在线端实时广播变更（按用户隔离）；
  - **账号级任意密码 KEK/DEK 密钥信封（`/assistant/encryption`、`/assistant/encryption/reset`）**：保存版本化 KDF（`pbkdf2-sha256` / `argon2id`）、`salt` 与 `AES-256-GCM` 包裹的 `wrapped_dek`，服务端永远接触不到用户密码与明文 DEK；改密码使用 `expected_version` 乐观锁递增 `key_version` 且保持 `dek_epoch` 不变（无需重加密历史对话）；开启加密后拒绝明文对话上传并校验 `dek_epoch`；忘密码重置要求显式 `confirm_wipe=true`，原子清空旧密文对话与 `account_dek` 云盘 VFS 文件并递增 `dek_epoch`；
  - **Tokens Anywhere 单账号托管 Key 加密复用（`/assistant/tokens`）**：每个账号仅存一份经服务端密钥 Fernet 加密的托管 Key 与 refresh token；首端连接写入、并发后续端自动复用已有 Key（返回 `kept: true` 供客户端撤销多余授权）；每 30 天在 Redis 分布式锁保护下自动续期 refresh token（`invalid_grant` 自动清除）；断开支持 `?key_hash=` 条件清理并尽力调用 Tokens RFC 7009 `/api/v1/oauth/revoke` 撤销授权；**严格仅允许本人一等登录会话访问，拒绝 MCP OAuth Token 与第三方 OIDC 应用**（响应均带 `Cache-Control: no-store`）。
- **3.0 数据库迁移（`migrations/versions/v3_0.py` … `v3_3.py`）**：
  - `v3_0` 支持空库全新初始化与 2.x 原地升级（保留 `users` / `oauth_accounts`，清理旧会话表）；`v3_1` 新增 `drive_files` 与 `drive_user_policies`；`v3_2` 新增 `assistant_conversations`、`assistant_key_envelopes` 与 `assistant_tokens_connections`；`v3_3` 给 `drive_files` 加 `path` / `parent_path` / `on_conflict`、新增 `drive_folders`，并为已有文件回填路径（`transfer` → `/Transfers/<filename>`，重名加后缀；`assistant_vfs` → `/Orches/<vfs_path>`）。

## 目录分层

| 目录 | 职责 | 依赖约束 |
| --- | --- | --- |
| `aa_control/core/` | 配置、契约模型、密码与凭据原语、错误定义 | 不依赖 FastAPI、SQLAlchemy、Redis、MeshCall 或外层模块 |
| `aa_control/services/` | 用例编排（认证、设备、隧道、扇出、推送、MCP） | 不依赖 FastAPI / Starlette / 传输层 |
| `aa_control/infra/` | PostgreSQL 仓储、Redis 协调与重试队列、MeshCall Router 池、Push Worker 与 APNs / FCM 发送器 | 依赖 `core` |
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
| `AA_CONTROL_WEB_ORIGIN` | 可选：`web-v3` 的对外地址；设置后 MCP OAuth 的 `authorization_endpoint` 指向 `<Web 地址>/oauth/authorize` 授权页，浏览器访问控制面 `/oauth/authorize` 时 302 跳转过去（外部 MCP 客户端需要） | `https://app.aa.example.com` |
| `AA_CONTROL_ROUTER_URL` | 单个 MeshCall Router WS 地址（多实例用 `AA_CONTROL_ROUTERS_JSON`） | `ws://127.0.0.1:8765` |
| `AA_CONTROL_ROUTER_PUBLIC_URL` | 返回给客户端连接的 Router 公网地址 | `wss://router.example.com` |
| `AA_CONTROL_ROUTER_USERNAME` / `AA_CONTROL_ROUTER_PASSWORD` | Router `auth.json` 中控制面账号凭据 | `control` / `...` |
| `AA_CONTROL_AUTH_MODE` | 认证模式：`local`（默认内置账密）或 `oidc`（外部 OIDC/JWKS） | `local` / `oidc` |
| `AA_CONTROL_OIDC_ISSUER` | `oidc` 模式必填：认证中心 Issuer URL（自动发现 `/.well-known/openid-configuration`） | `https://auth.anywhere.dev` |
| `AA_CONTROL_OIDC_CLIENT_ID` | `oidc` 模式客户端 ID（写入 `/auth/config` 并作为默认 `aud`） | `aa-v3` |
| `AA_CONTROL_OIDC_AUDIENCE` | 可选：允许的 JWT `aud`（逗号分隔，未设时回退到 `CLIENT_ID`） | `aa-v3` |
| `AA_CONTROL_OIDC_JWKS_URI` | 可选：显式覆盖 JWKS URL（默认从 Discovery 获取） | `https://auth.anywhere.dev/.well-known/jwks.json` |
| `AA_CONTROL_OIDC_SCOPES` | 可选：暴露给客户端请求的 OIDC Scope | `openid profile email offline_access entitlements` |
| `AA_CONTROL_OIDC_ENTITLEMENTS_CLAIM` | 可选：自定义第三方 OIDC 权益声明键名（默认 `entitlements`） | `entitlements` |
| `AA_CONTROL_OIDC_ADMIN_ROLES` | 可选：映射为管理员的角色名列表（逗号分隔，默认 `admin`） | `admin` |
| `AA_CONTROL_DEFAULT_ENTITLEMENTS_JSON` | 可选：默认权益基线 JSON（第三方 OIDC 无权益声明或 `local` 模式时生效） | `{"aa.max_devices": 10}` |
| `AA_CONTROL_S3_ENDPOINT` / `AA_CONTROL_S3_BUCKET` | 云盘对象存储 S3 Endpoint 与 Bucket（两者均配置后启用云盘） | `http://127.0.0.1:9000` / `aa-drive` |
| `AA_CONTROL_S3_ACCESS_KEY_ID` / `AA_CONTROL_S3_SECRET_ACCESS_KEY` | S3 凭据 | — |
| `AA_CONTROL_S3_PUBLIC_ENDPOINT` | 可选：返回给客户端/Connector 预签名直连的公网 S3 地址 | `https://files.example.com` |
| `AA_CONTROL_S3_REGION` / `AA_CONTROL_S3_PATH_STYLE` | 可选：S3 Region（默认 `us-east-1`）与 Path-Style 开关（默认 `true`） | `auto` / `true` |
| `AA_CONTROL_DRIVE_DEFAULT_QUOTA_MB` / `AA_CONTROL_DRIVE_MAX_FILE_MB` | 可选：云盘默认账号配额（默认 `512`，`-1` 不限）与单文件上限（默认 `100`） | `512` / `100` |
| `AA_CONTROL_DRIVE_DEFAULT_TTL_DAYS` / `AA_CONTROL_DRIVE_MAX_TTL_DAYS` | 可选：云盘文件默认过期天数（默认 `7`）与最大可调天数（默认 `30`） | `7` / `30` |
| `AA_CONTROL_DRIVE_RPC_MAX_BYTES` | 可选：向客户端通告的 RPC 直传文件大小阈值（默认 8 MiB） | `8388608` |
| `AA_CONTROL_ASSISTANT_MAX_BYTES` / `AA_CONTROL_ASSISTANT_MAX_CONVERSATIONS` | 可选：助手单条对话体积上限（默认 20 MiB）与单账号保留条数上限（默认 `100`） | `20971520` / `100` |
| `AA_CONTROL_ASSISTANT_ALLOWED_TOKENS_CLIENT_IDS` | 可选：OIDC 模式下允许读取 Tokens Anywhere 托管 Key 的一等客户端 ID（逗号分隔，默认回退到 `AA_CONTROL_OIDC_CLIENT_ID`） | `aa-v3` |
| `AA_CONTROL_TOKENS_URL` / `AA_CONTROL_TOKENS_CLIENT_ID` | 可选：Tokens Anywhere 站点地址（默认 `https://tokens-anywhere.com`）与 OAuth Client ID（默认 `agents-anywhere`） | `https://tokens-anywhere.com` / `agents-anywhere` |
| `AA_CONTROL_TOKENS_REFRESH_INTERVAL_DAYS` / `AA_CONTROL_TOKENS_ENCRYPTION_SECRET` | 可选：Tokens refresh token 自动续期周期（默认 `30` 天）与独立加密密钥（默认从 `AA_CONTROL_SECRET` 派生） | `30` / — |
| `AA_CONTROL_APNS_KEY_PATH` / `AA_CONTROL_APNS_KEY` | APNs `.p8` 认证密钥文件路径，或直接填 PEM 内容（单行可用 `\n` 转义，二选一）；与下面三项同时配置后启用 iOS 推送 | `/run/secrets/AuthKey_ABC123.p8` |
| `AA_CONTROL_APNS_KEY_ID` / `AA_CONTROL_APNS_TEAM_ID` | `.p8` 密钥的 Key ID 与 Apple Developer Team ID | `ABC123DEFG` / `TEAM123456` |
| `AA_CONTROL_APNS_BUNDLE_ID` | iOS App Bundle ID（`apns-topic`） | `dev.anywhere.agents` |
| `AA_CONTROL_APNS_ENVIRONMENT` | 可选：`production`（默认）或 `sandbox`（开发版/调试证书安装的 App）；填错会让 APNs 返回 `BadDeviceToken` 并清除 token | `production` |
| `AA_CONTROL_FCM_CREDENTIALS_PATH` / `AA_CONTROL_FCM_CREDENTIALS_JSON` | Google 服务账号 JSON 文件路径，或直接填 JSON 内容（二选一）；配置后启用 Android 推送 | `/run/secrets/fcm-sa.json` |
| `AA_CONTROL_FCM_PROJECT_ID` | 可选：Firebase 项目 ID（默认取服务账号里的 `project_id`） | `aa-prod` |
| `AA_CONTROL_APNS_TIMEOUT` / `AA_CONTROL_FCM_TIMEOUT` | 可选：单次推送请求超时秒数（默认 `10`） | `10` |
| `AA_CONTROL_PUSH_MAX_ATTEMPTS` / `AA_CONTROL_PUSH_BASE_BACKOFF` | 可选：推送最大尝试次数（默认 `5`）与指数退避基数秒（默认 `5`） | `5` / `5` |
| `AA_CONTROL_REGISTRATION_OPEN` | `local` 模式：是否开放自助注册（首账号始终为 admin） | `true` / `false` |
| `AA_CONTROL_SETUP_TOKEN` | `local` 模式可选：限制首次管理员注册所需的一次性 token | — |

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
