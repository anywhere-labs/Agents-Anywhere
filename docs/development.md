# v2 开发指南

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

## 构建安装包

在 `desktop-workbench/` 运行：

```bash
yarn dist:mac   # 在 macOS 构建 Universal DMG
yarn dist:win   # 在 Windows 构建 x64 NSIS 安装包
```

签名、公证、架构选择及缓存重试见 [Desktop Packaging](../desktop-workbench/README.md#packaging)。凭据从环境或安全存储注入，不能提交到源码或文档。Android 的命令和签名边界见 [Android README](../android/README.md)。发布步骤见 [2.0.0 发布说明](releases/2.0.0.md)。
