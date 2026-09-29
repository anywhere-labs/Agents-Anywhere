<!-- tm_board_write · 2026-09-26T21:48:29.364Z · role=implementer · session=20260926-213919 -->
# 便携式自建 Agents Anywhere 实例 — 搭建报告

日期: 2026-09-27 (本地) / 2026-09-26T21:44Z
仓库: D:\Github\Agents-Anywhere (只读使用，未修改任何受版本控制文件)
临时根: C:\Users\34296\AppData\Local\Temp\opencode\aa-selfhost\

## 总览

| 阶段 | 内容 | 结果 |
| --- | --- | --- |
| ① | 便携 PostgreSQL 16.4 @55432 | 成功 |
| ② | 便携 Redis @56379 | 成功（首次用 5.0.14.1 失败，换 Redis 8.10.2） |
| ③ | 本仓库 Server @8000（含我们的改动） | 成功，schema 2.38 |
| ④ | Web (web-next) @5174 | 成功，HTTP 200 |
| ⑤ | 真机浏览器验证 client_id 白名单 | **阻塞（本 agent 无 browser 工具）** |

端口探测：8000 / 5174 / 55432 / 56379 **搭建前均空闲** → 采用任务指定的 8000/5174，
**插件的「8000 映射为 5174」规则适用，无需手动改 webOrigin/serverUrl**。

---

## ① 便携 PostgreSQL

- 下载 EnterpriseDB "binaries only" ZIP **16.4-1**（338,727,828 字节），解压到 `pg\pgsql\`。
  下载需加 `--ssl-no-revoke`：本机 Schannel 无法完成吊销检查（`CRYPT_E_NO_REVOCATION_CHECK`），
  **不加该开关会直接连接失败**（GitHub 与 EDB 都受影响）。
- `initdb -D <pgdata> -U postgres -A trust -E UTF8 --locale=C` → 成功。
- 启动方式：**用 `Start-Process postgres.exe` 后台启动（不要用放在会被 shell 超时杀掉的
  进程组里的 `pg_ctl start`）**。第一次前台跑 `pg_ctl start` 时命令超时，整棵进程树被回收，
  PG 随之崩溃（`pg.log`: `startup process was terminated by exception 0xC0000142`）。
- 证据：`psql -h 127.0.0.1 -p 55432 -U postgres -t -A -c "select version()"`
  → `PostgreSQL 16.4, compiled by Visual C++ build 1940, 64-bit`
- 库与角色：`CREATE ROLE agents LOGIN PASSWORD 'password' CREATEDB;` +
  `CREATE DATABASE agents_anywhere OWNER agents;`，验证
  `psql -U agents -d agents_anywhere -c "select current_user, current_database()"` → `agents|agents_anywhere`

## ② 便携 Redis

- **首次尝试失败**：tporadowski/redis **v5.0.14.1**（Windows x64 zip）能起、PING=PONG，
  但 server 启动即崩：`redis.exceptions.ResponseError: unknown command 'HELLO'`。
  原因：`server/pyproject.toml:18` 锁 `redis>=6.0.0`，实际 **redis-py 8.1.0**；
  `Redis.from_url()`（`agent_server/infra/redis_coordinator.py:118`，**未传 protocol**）默认 **RESP3**，
  连接时发 `HELLO 3`；而 Redis 5.0 不认识 HELLO（HELLO 是 Redis 6.0 引入）。
- 修复：改用 **redis-windows/redis-windows release `8.10.2`**（`Redis-8.10.2-Windows-x64-msys2.zip`，
  免安装/免服务/免管理员），解压到 `redis8\`，起在 **56379**。
- 证据：`redis-cli -p 56379 ping` → `PONG`；`redis-cli -p 56379 hello 3` → `version 8.10.2 / proto 3`；
  `info server` → `redis_version:8.10.2`。
- 结论：**Redis 是硬依赖且版本必须 ≥6**（RESP3/HELLO）；只提供 Redis 5 会让 server 在 startup 阶段退出。

## ③ 本仓库 Server（带我们的改动）

- 依赖：`server/.venv` 已存在，`uv sync` → `Audited 66 packages in 31ms`（无需重装）。
- 配置**全部走环境变量**（无配置文件）：
  - `AGENT_SERVER_DB_URL=postgresql+asyncpg://agents:password@127.0.0.1:55432/agents_anywhere`
  - `AGENT_SERVER_DB_BACKEND=postgres`
  - `AGENT_SERVER_REDIS_URL=redis://127.0.0.1:56379/0`
- 迁移：`uv run python -m agent_server.infra.db.migrations upgrade` → 尾部
  `database schema is now 2.38 (v2_38)`。
  - README 说 head 是 `v2_35`，**实际 head 已是 `v2_38`**（README 滞后）。
  - `v2_37` = "Add the RFC 8628 device authorization grant for headless plug-in sign-in"
    —— 正是 OpenCode 插件登录相关的那条迁移。
- 启动（Start-Process 后台；日志 `logs\server.err`）：
  `uv run uvicorn agent_server.app:create_app --factory --host 127.0.0.1 --port 8000`
- 证据：`GET /api/v2/health` → http=200 `{"status":"ok","version":"2.0.0",...}`；
  `GET /api/v2/health/ready` → http=200
  `{"status":"ready","checks":{"database":{"status":"ok","schemaVersion":"2.38"},"redis":{"status":"ok"},"realtime":{"status":"ok"}},...}`

## ④ Web（web-next，含 client_id 白名单改动）

- web-next **确无 lockfile**，用 `corepack yarn install` 解析：Yarn 4.6.0，
  resolution 25s / fetch 18s / link 44s，`826 packages (+816.46 MiB)`，`Done in 1m 29s`，退出码 0。
  - **坑**：install 未结束先起 `yarn dev` 会报
    `Couldn't find the node_modules state file ... (findPackageLocation)`；
    必须等 `.yarn\install-state.gz` 生成后再起 dev。
- 启动：`AGENTS_ANYWHERE_API=http://127.0.0.1:8000 corepack yarn dev`
  （脚本 = `next dev --hostname 127.0.0.1 --port 5174`，日志 `logs\web.out`）。
- 证据：`GET http://127.0.0.1:5174/` → http=200，`<title>Agents Anywhere</title>`，
  `Next.js 16.3.6 (Turbopack) ... Ready in 1146ms`。
- 仓库改动核查：`git status --porcelain -- web-next` → **空**。
  `node_modules`/`yarn.lock`/`.yarn/` 均被 .gitignore 忽略；`.yarnrc.yml` 是**已跟踪且未改动**。
  → 本任务**未对仓库产生任何受版本控制文件的修改**。

## ⑤ 真机浏览器验证（未完成 — 阻塞）

- **阻塞原因**：本 agent 工具面里**既没有 `browser.*` 也没有 `tm_browser`**（只有 opencode/tm_board_write/
  tm_fetch/tm_memory/tm_stats + 文件/Shell）。任务要求的宿主原生浏览器步骤**我无法执行**，
  按规则如实上报，不伪造结果。
- **替代证据（建议据此判断，但仍需补一次真机浏览器确认）**：
  1. 对 `web-next/src/features/auth/native-oauth.ts`（零 import，可独立加载）跑探针：
     - 白名单 = `["agents-anywhere-dsh-plugin","agents-anywhere-opencode-plugin"]`
     - 任务给的**原样 URL**（`code_challenge=abc`、`state=test-state`）→ `readNativeOAuthParams(...) === null`
     - 换成 43 位 challenge + 32 位 state → **返回完整参数对象（接受）**
     - 换成 `agents-anywhere-other-plugin` → `null`
  2. 仓库自带测试：`node --test test/onboarding-flow.test.mjs` → `tests 5 / pass 5 / fail 0`，
     含 “plugin OAuth also accepts the OpenCode plug-in client and rejects others”。
  3. 服务端同样已注册该 client：`server/agent_server/core/oauth_clients.py:54-55`
     `OPENCODE_PLUGIN_OAUTH_CLIENT(client_id="agents-anywhere-opencode-plugin", loopback=True)`。

### ⚠️ 重要：任务里给的那条 URL 会产生**假阴性**
`native-oauth.ts:41` 对 plugin 流要求 `code_challenge` 匹配 `^[A-Za-z0-9_-]{43}$`、
`state` 匹配 `^[A-Za-z0-9_-]{32,128}$`。任务的 `code_challenge=abc`（3 位）与
`state=test-state`（10 位）**必然校验失败**，页面显示「授权链接无效」——**这与 client_id 白名单无关**，
不能据此判定改动失效。

**请用这条修正后的 URL 做真机验证**（整段可粘贴）：
```
http://127.0.0.1:5174/#/plugin-oauth?response_type=code&client_id=agents-anywhere-opencode-plugin&redirect_uri=http://127.0.0.1:59999/oauth/callback&code_challenge=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&code_challenge_method=S256&scope=profile&state=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
```
（challenge = 43 个 `a`，state = 32 个 `b`；redirect 的 `127.0.0.1:59999/oauth/callback` 满足 loopback 规则。）
判定口径不变：出现**登录/注册界面（非「授权链接无效」）** ⇒ 白名单改动生效。
执行 ⑤ 打开的标签页**必须关闭并引用关闭结果**。

---

## 地址与配置（供用户设置 `options.serverUrl`）

| 项 | 值 |
| --- | --- |
| Server | `http://127.0.0.1:8000` |
| Web | `http://127.0.0.1:5174` |
| PostgreSQL | `127.0.0.1:55432`，user `agents` / pass `password` / db `agents_anywhere` |
| Redis | `redis://127.0.0.1:56379/0` |
| 端口映射规则 | **适用**（正是 8000/5174），插件地址推导无需手改 |

## 仍在运行的进程（本次自起）

| 端口 | PID | 进程 | 说明 |
| --- | --- | --- | --- |
| 8000 | 24224 | python (uvicorn worker) | 父进程 `uv` PID 26772 |
| 5174 | 9128 | node (next dev) | 父进程 `cmd` PID 30492 |
| 55432 | 17488 | postgres | |
| 56379 | 18932 | redis-server | Redis 8.10.2 |

关闭方法：
```powershell
$root="C:\Users\34296\AppData\Local\Temp\opencode\aa-selfhost"
Stop-Process -Id 30492,9128 -Force          # web
Stop-Process -Id 26772,24224 -Force         # server
& "$root\pg\pgsql\bin\pg_ctl.exe" -D "$root\pgdata" stop -m fast
& "$root\redis8\Redis-8.10.2-Windows-x64-msys2\redis-cli.exe" -p 56379 shutdown nosave
```
（删掉临时根即彻底清理；未装任何系统服务、未写入 Program Files、未要管理员权限。）

## 首位管理员 / setup token

Server **首次启动**（空库）会在日志打印一次性 setup token，用于在 Web 创建首位管理员。
- 本次 `logs\server.err`：`setup-token: uUP9Ve9yQRa5iDQdhtFL5i2K`，有效期 `2026-09-26T21:59:36Z`
  （约 15 分钟）——**到写报告时大概率已过期**。
- 获取/刷新（**不要替用户建号**）：重启 server 后读日志
  `Select-String -Path "...\logs\server.err" -Pattern "setup-token"`；过期会自动生成新 token。

## 未完成 / 未验证

1. **⑤ 真机浏览器验证未做**（无 browser 工具）——需带 `browser.*` 的角色补做，且**必须用修正后的 URL**。
2. **未创建管理员账号**（按要求留给用户）。
3. 未验证插件端到端换 token，超出本任务范围。
4. README 的 head（v2_35）与实际（v2_38）不一致，属仓库文档滞后，仅供留意。
