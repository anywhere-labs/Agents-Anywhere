<!-- tm_board_write · 2026-09-26T17:57:06.644Z · role=implementer · session=20260926-213919 -->
# P5 账号验证 · 服务端与 Web 侧实现报告

任务：实现 OpenCode 插件账号验证的服务端 + Web 部分（设计文档 §5.4 改动清单）。插件侧(P4)与 connector/** 均未触碰。

## 1. core/oauth_clients.py：新增内置 client + 共享 loopback 正则
- 抽出模块级 allows_loopback_redirect(uri) 与 _LOOPBACK_REDIRECT_RE（原 DSH 内联正则）。
- FirstPartyOAuthClient 增加 loopback: bool = False 字段；allows_redirect 据此分派。
- DSH 客户端改为 loopback=True，行为不变（test_plugin_redirect_has_exact_loopback_boundary 全绿）。
- 新增 OPENCODE_PLUGIN_OAUTH_CLIENT（client_id=agents-anywhere-opencode-plugin，loopback=True），加入 FIRST_PARTY_OAUTH_CLIENTS。

## 2. 设备码端点（RFC 8628）
新增核心模块 core/oauth_device.py（域常量 + 短码生成/归一化 + 错误类型）：
- 短码：Crockford 式 32 字母表 0123456789ABCDEFGHJKMNPQRSTVWXYZ（无 I/L/O/U），8 位 → XXXX-XXXX，40bit 熵；normalize_user_code 容忍大小写/缺横线并把 I,L→1、O→0。
- device_code = secrets.token_urlsafe(32)；两者仅存 SHA-256 哈希。
- TTL 600s，轮询间隔 5s，slow_down 递增 5s，单账号 10 次错误 / 900s。

新增表（schema.py + v2_37 migration）：
- oauth_device_codes：device_code_hash(PK) / user_code_hash / client_id / scope / status(pending|approved|denied) / user_id / interval_seconds / expires_at / last_polled_at / approved_at / consumed_at / created_at + user_code_hash 索引。
  · 注：设计文档的 state 按流程状态落地为 status 列（RFC 8628 无 state 参数）。
- oauth_device_code_attempts：user_id(PK) / failed_attempts / window_start（短码防蛮力计数）。

端点（api/oauth.py，均在 /api/v2 前缀下；既有 /oauth/authorize、/oauth/token 语义未改）：
| 端点 | 认证 | 语义 |
|---|---|---|
| POST /oauth/device/code | 否（Form: client_id, scope） | 返回 device_code / user_code / verification_uri(=origin + /#/plugin-device) / verification_uri_complete / expires_in=600 / interval=5；非内置 client → 404 |
| POST /oauth/device/token | 否（Form） | grant_type 必须 = urn:ietf:params:oauth:grant-type:device_code；成功 → OAuthTokenResponse；否则 RFC 8628 形状 {error, error_description}：authorization_pending / slow_down / access_denied / expired_token / invalid_grant |
| POST /oauth/device/lookup | 需登录 | 解析短码，返回 clientName/expiresAt/status（供批准页展示） |
| POST /oauth/device/approve | 需登录 | {userCode, approved} 批准/拒绝；只能由已登录会话执行，绝不凭 user_code 直接发令牌 |
- /.well-known/oauth-authorization-server 追加 device_authorization_endpoint 与 device grant（附加项）。
- 轮询写操作（last_polled_at / interval 递增 / consumed_at）走在不抛异常路径中提交，避免事务回滚丢失。

## 3. web-next
- 新增 #/plugin-device 页 src/components/auth/plugin-device-page.tsx（PluginDeviceFlow）：未登录先走既有 Bootstrap/Register/OAuth/Login 屏；已登录 → 输入短码 → lookup 展示请求设备/当前账号 → 批准 / 拒绝 → 结果页。错误映射 404→invalidCode、429→tooManyAttempts。
- 注册：auth-context.tsx(AuthScreen + hashToScreen + screenToHash)、continuation.ts(flows)、auth-router.tsx(渲染)。
- i18n：messages/zh-CN.json + en.json 新增 auth.pluginDevice（各 19 键，JSON 解析通过）。
- API：features/auth/api.ts 新增 lookupDeviceCode / approveDeviceCode；types.ts 新增 DeviceCodeApprovalResponse。

### 发现的规格缺口（已修，需 lead 确认是否越界）
设计 §5.1 要求 OpenCode 回环流复用 #/plugin-oauth 且 client_id=agents-anywhere-opencode-plugin；但 features/auth/native-oauth.ts 把 plugin 的 client_id 硬编码为 DSH，opencode 会被判为授权链接无效。
最小附加改动：native-oauth.ts 新增 PLUGIN_CLIENT_IDS = [agents-anywhere-dsh-plugin, agents-anywhere-opencode-plugin]，plugin 分支按集合校验；DSH 行为与全部拒绝用例不变（loopback 正则仍严格）。未新增路由。

## 4. admin_dashboard.py：opencode 补齐（四处）
- AGENT_LABELS 加 opencode: OpenCode（位于 claude 与 dsh 之间，对齐 runtime 枚举序）。
- 三处 agent 元组/集合：:321 指标循环、:546 设备 by_user 计数、:677 active session 归属 → 均加 opencode。
- 计数字段：UserDailyFact.opencode_agents、fact_rows 字典、by_user 默认字典各加一项；dashboard_user_daily_facts 加列（schema.py + v2_38 migration）。缺列会让 insert 失败，故为必需。
- DASHBOARD_SNAPSHOT_VERSION 5→6（快照形状变化，旧缓存失效）。

## 5. 迁移
v2_37（设备码两表，含 has_table 幂等守卫）、v2_38（opencode_agents 列，含列存在守卫）；CURRENT_SCHEMA_REVISION=v2_38、CURRENT_SCHEMA_VERSION=2.38。

## 6. 安全红线逐条
- 短码可读（XXXX-XXXX）+ 短有效期(600s) + 单账号 10 次/900s 限流 → 防蛮力；device_code 高熵(32B)。
- 批准仅 current_user 依赖（无 token 401）；令牌只由轮询端点在 approved 后发放。
- 无任何日志语句（grep logger/loguru/print 于 oauth 相关文件：0 命中）；错误响应不回显内部信息。
- device_code / user_code 仅存哈希；code 在发令牌时标记 consumed_at（一次性）；每次 create 顺带删除已过期行。

## 7. 证据
- 服务端单测（新增 tests/test_plugin_device_code.py 8 例：申请→pending→slow_down→lookup→批准→换令牌→重复消费 invalid_grant；拒绝→access_denied；过期→expired_token；错 client/未知码；未登录 401；限流 429；metadata；loopback 边界）。
  · uv run --with tzdata pytest -q tests/test_auth.py tests/test_plugin_device_code.py tests/test_admin_dashboard.py → 71 passed in 38.22s
- migration 实跑（upgrade_database 两次幂等）：revision=v2_38，oauth_device_codes=True，oauth_device_code_attempts=True，opencode_agents=True；日志含 v2_36 -> v2_37、v2_37 -> v2_38。
- 全量：uv run --with tzdata --with psutil pytest -q → 865 passed / 6 failed / 15 errors；其中仅 1 个由本改动引起（test_auth.py::test_oauth_metadata_advertises_authorization_code_pkce 精确断言旧 metadata，已同步更新）。其余为环境/他人改动：
  · test_static_path_safety x15 errors、test_device_data_storage(symlink) → Windows WinError 1314 无 symlink 权限
  · test_protocol_contracts(artifacts) → 检出为 CRLF、生成物为 LF
  · test_redis_infrastructure x2、test_connector_rpc_manager → 无 Redis / connector 租约（另一 implementer 正在改 connector/**）
  · test_admin_dashboard 4 例在本环境因缺 tzdata（ZoneInfo(Asia/Shanghai)）失败，属环境缺失；--with tzdata 下全绿
- Web：无法构建/类型检查 —— web-next/node_modules 不存在、无 yarn；因此也无法读取 AGENTS.md 要求的 node_modules/next/dist/docs/。替代静态验证：两个 messages JSON JSON.parse 通过（各 19 键）；用 npx -p typescript@5.9.2 tsc --noEmit --noResolve 检查 7 个改动文件，TS1xxx 语法错误 0（余下 TS2307/TS2875/TS2339 均为缺 react/next-intl 类型与 isApiError 无法收窄的解析噪声）；node --check test/onboarding-flow.test.mjs 通过。
- Lint：uv run ruff check . --exclude .venv 在本环境（ruff 0.16.9 > pyproject 的 >=0.15.13）对未改动文件即报 108 处，属既存环境差异；本改动新增的仅 6 处 B008（FastAPI Depends 默认参，全仓库既有写法），已把新写 import 块的 I001 用 --select I --fix 清零。

## 8. 文件清单
服务端：core/oauth_device.py(新) · core/oauth_clients.py · core/models.py · api/oauth.py · infra/db/schema.py · infra/db/__init__.py · infra/db/migrations.py · infra/repositories/oauth.py · infra/repositories/store_support.py · services/admin_dashboard.py · migrations/versions/v2_37.py(新) · v2_38.py(新)
测试：tests/test_plugin_device_code.py(新) · tests/test_auth.py · tests/test_admin_dashboard.py · tests/test_database_migrations.py
Web：components/auth/plugin-device-page.tsx(新) · components/auth/auth-context.tsx · components/auth/auth-router.tsx · features/auth/{api.ts,types.ts,continuation.ts,native-oauth.ts} · messages/{zh-CN,en}.json · test/onboarding-flow.test.mjs

## 9. 排除与未做
- 未改 connector/**（git status 中 connector 改动属另一 implementer）；未做插件包(P1/P4)。
- 未改 runtime 枚举（已预置 opencode）。
