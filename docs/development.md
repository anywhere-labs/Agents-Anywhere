# v2 开发指南

Server 的控制面通过 MeshCall 调用 Connector，契约见
[connector-control/1.0](../contracts/connector-control/1.0/README.md)。请使用
`cd server && uv run python -m agent_server.main` 或仓库启动脚本，由父进程维护
共享 Router。直接以 ASGI/uvicorn 启动时，应用生命周期为当前 worker 管理 Router；
多 worker/多实例继续使用 Redis 路由，不要求粘性会话。
反向代理需允许 `/api/v2/connector/mesh` WebSocket 升级。使用
`GET /api/v2/health/mesh` 严格检查 Router 健康；运行期 Router 故障时返回503，
`/health/ready` 仍可返回200并以 `checks.mesh=error` 单独报告，以便继续提供 WS 控制。
数据库、Redis、路由订阅、Timeline 和授权订阅故障仍使整体就绪检查返回503。
先升级 Server，再升级 Connector：未声明回退能力的连接固定使用原 WS；
新 Connector 优先 Mesh，仅在确定未分发时回退一次，不等待 Mesh 注册。
直接调用 uvicorn 时配置 `--ws-max-size 67108864`，与 Router、SDK、代理的编码后帧
预算对齐。控制请求在 Redis 中转前检查同一帧预算，超限不分发。旧新传输对照步骤见
[控制传输迁移说明](connector-control-transport.md)。

## 分支与环境

`main` 是 v2 主线，新功能从最新 `main` 创建分支，分支名为 `<type>/<domain>/<topic>`（type 如 `feat`、`fix`、`docs`；domain 缩写为 `fe`、`be`、`con`、`dsk`、`apk`、`ios`、`dsh`、`docs`，多个 domain 用 `+` 连接），如 `feat/con+be/<topic>`。`v2` 保留用于发布过渡，不再把旧 `main` 的 API 和数据库假定套用到当前主线。历史资料见[升级指南](upgrading.md)。

使用 Python 3.12+、uv、Node.js 22、Corepack/Yarn。Docker 源码启动器需要 Docker Compose；Android 需要 JDK 17 与 Android SDK，iOS 需要 Xcode。各子项目独立安装依赖，不在仓库根目录运行一个假设存在的总构建命令。

## Web 与 Server 本地联调

从根目录手动启动：

```bash
./local-up.sh
```

它启动 Docker PostgreSQL/Redis、迁移数据库，再在前台运行 Server 和 Web。默认 Web 为 `http://127.0.0.1:5174`，Server 为 `http://127.0.0.1:8000`，PostgreSQL/Redis 端口为 `55432` / `56379`。日志在 `.local-dev/logs/`。按 Ctrl-C 停止本次启动的服务。

- `--skip-install`：复用依赖。
- `--with-connector`：一起启动 Connector；默认不启动。
- `--reload`：启用 Server 热重载；默认关闭以减少实时连接中断。
- `--access-log`：打印 uvicorn 逐请求访问日志；默认关闭。Server 日志级别默认为 INFO，可用 `LOGURU_LEVEL=DEBUG` 查看调试日志（`desktop-local-up.sh` 同样适用）。
- `--listen`：监听局域网地址；默认只监听回环。
- `--reset-data`：删除本地数据库数据卷，仅在明确不要这些数据时使用。

## Desktop

仅开发 Desktop，默认连接 Cloud：

```bash
cd desktop-workbench
yarn install
yarn dev
```

联调本地 Server 与 Desktop，在根目录手动运行：

```bash
./desktop-local-up.sh
./desktop-local-up.sh down
```

此启动器使用 Server `8000`、Web `5174`（Desktop 开发模式的登录页）和 Desktop `5184`，会释放这三个应用端口的既有监听者，然后像 `local-up.sh` 一样在前台运行 Server、Web 和 Desktop，并带前缀输出日志（同时写入 `.local-dev/logs/`）。按 Ctrl-C 停止本次启动的服务和数据库容器；`down` 用于停止另一个终端里仍在运行的启动器。更多环境变量与生命周期见 [Desktop README](../desktop-workbench/README.md)。

## Headless 检查

以下检查不要求打开 Electron、浏览器或移动模拟器。先在对应子项目安装依赖；只运行与修改有关的检查，不必为文档改动重新构建所有安装包。

```bash
cd server
uv sync
# tests/test_connector_pipeline.py 会导入 Connector 包，把它装进 Server 环境一次即可；
# 临时跳过可加 --ignore=tests/test_connector_pipeline.py
uv pip install --python .venv/bin/python ../connector
uv run ruff check . --exclude .venv
# 测试跑在真实 PostgreSQL 上：用本地 compose 起一个库，并单独建一个名字含 test 的数据库。
# 测试会在每个用例前清空该库的所有表，所以绝不能指向开发库或生产库。
docker compose -f ../docker/docker-compose.local.yml up -d postgres
docker compose -f ../docker/docker-compose.local.yml exec postgres \
  psql -U agents_anywhere -c 'CREATE DATABASE agents_anywhere_test'
export AGENT_SERVER_TEST_DB_URL=postgresql+asyncpg://agents_anywhere:agents_anywhere_dev_password@127.0.0.1:55432/agents_anywhere_test
uv run pytest -q
```

```bash
cd connector
uv sync
uv run ruff check connector tests
uv run pytest -q
```

```bash
# DSH 插件：集成测试会在进程内拉起 Connector 的 DSH 探针和 Server，需要上面同一个测试库变量
cd dsh-bridge-next
corepack yarn install
AGENT_SERVER_TEST_DB_URL=postgresql+asyncpg://agents_anywhere:agents_anywhere_dev_password@127.0.0.1:55432/agents_anywhere_test \
  corepack yarn check
```

```bash
cd web-next
yarn install
yarn test
yarn typecheck
yarn protocol:check
```

```bash
cd desktop-workbench
yarn install
yarn test:main
yarn renderer:typecheck
yarn workspace agents-anywhere-desktop-renderer test
yarn workspace agents-anywhere-desktop-renderer protocol:check
```

Server 测试应使用隔离测试环境，不要把生产数据库 URL 带入测试进程。Headless 检查通过不代表真实安装、OAuth 回调或远程 Runtime 会话已验证；这些按变更影响单独记录。

### CI 入口与缓存

`.github/workflows/ci.yml` 按路径选择 Connector、Server、DSH 插件、Web 和 Desktop
检查。Connector 改动同时触发 Server、插件及 Mesh 探针；Server 改动触发 Server、
插件及 Mesh 探针；契约、工作流和公共 action 的改动触发全部检查。Mesh 作业使用
专用 Redis 7.4，依次核对只读控制契约、连接代次、跨实例/Router 故障恢复和无 Redis 单进程模式，
结果 JSON 作为短期 artifact 保存，不依赖业务数据库。

公共 `setup-yarn` action 仅缓存下载归档，按项目、Node、平台及依赖声明区分，
不缓存 `node_modules` 或 lockfile；缓存命中后仍执行安装，从当前清单解析依赖。
Python 环境在检查前准备一次，Server 中预装当前 Connector，之后以 `--no-sync`
运行检查；DSH 集成探针通过 `UV_NO_SYNC=true` 复用已准备的两个环境。
CI 的一次性 PostgreSQL 使用 tmpfs，减少每个用例清表的磁盘开销；不修改生产数据库
配置。pytest 保留外层硬超时，并输出慢项，Server 另外打印用例名用于定位等待。

DSH 的 PR/push 检查统一在 CI 中执行。独立 `dsh-bridge.yml` 使用当前
`dsh-bridge-next/`，仅负责手动验包和既有 `dsh-bridge-v<包版本>` release 发布：
先完成类型、构建和测试，再用 `npm pack --ignore-scripts` 打包已验证的产物，
发布作业下载同一份归档，不重复安装、构建或触发 `prepack`。手动运行不会发布。

## 构建安装包

在 `desktop-workbench/` 运行：

```bash
yarn dist:mac   # 在 macOS 构建 Universal DMG
yarn dist:win   # 在 Windows 构建 x64 NSIS 安装包
```

签名、公证、架构选择及缓存重试见 [Desktop Packaging](../desktop-workbench/README.md#packaging)。凭据从环境或安全存储注入，不能提交到源码或文档。Android 的命令和签名边界见 [Android README](../android/README.md)。发布步骤见 [2.0.0 发布说明](releases/2.0.0.md)。
