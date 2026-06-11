# Agents Anywhere

Agents Anywhere 是一个通过浏览器运行本地 Agent Runtime 的 Web 工作台。
后端负责 HTTP API 和状态存储，Connector 跑在用户自己的机器或远程主机上，
前端提供登录、设备配对、Session 管理、Runtime 设置、文件访问、终端访问、
审批处理和时间线查看。

[English](README.md) · **简体中文**

## 包结构

```text
server/      FastAPI 后端，支持 SQLite/PostgreSQL 存储和 Connector RPC broker
connector/   本地守护进程和 CLI，集成 Codex / Claude runtime
web/         React + Vite 前端
docker/      开发、生产和 PostgreSQL compose 部署文件
docs/        共享参考文档
```

各包的详细文档：

- [Server](server/README.md)
- [Connector](connector/README.md)
- [Web](web/README.md)
- [Docker](docker/README.md)

## 快速开始

如果想从干净 checkout 快速启动完整应用，优先使用 Docker。

开发容器会构建后端和 Web 开发镜像，在容器内启动 FastAPI 和 Vite，并只暴露
Vite 端口：

```bash
docker build -f docker/Dockerfile.dev -t agents-anywhere:dev . \
  && docker run --rm -it \
    --name agents-anywhere-dev \
    -p 5173:5173 \
    -v agents-anywhere-dev-data:/data \
    agents-anywhere:dev
```

打开 `http://127.0.0.1:5173`。

生产风格容器会构建前端静态资源，由 FastAPI 托管这些资源，运行数据持久化到
`/data`，并只暴露后端端口：

```bash
docker build -f docker/Dockerfile -t agents-anywhere:latest . \
  && docker run --rm -it \
    --name agents-anywhere \
    -p 8000:8000 \
    -v agents-anywhere-data:/data \
    -e AGENT_SERVER_SECRET=change-me-before-production \
    agents-anywhere:latest
```

打开 `http://127.0.0.1:8000`。

使用 PostgreSQL 的生产风格 compose：

```bash
POSTGRES_PASSWORD=change-me \
AGENT_SERVER_SECRET=change-me-too \
docker compose -f docker/docker-compose.postgres.yml up --build
```

空数据库首次启动时，服务日志会输出 bootstrap token。使用该 token 在 Web UI
中创建第一个管理员用户。

## 当前功能

- 首次启动初始化、登录、注册控制、用户管理和头像上传。
- Connector 创建、浏览器配对、token 交换、心跳、重连和在线/离线状态。
- Codex 和 Claude 的 Runtime 发现，以及按设备配置 Agent 设置。
- Session 创建、列表、更新、归档、置顶、已读状态、接管、消息、打断、同步、
  审批和时间线轮询/SSE。
- Connector RPC 支持本地文件浏览、文件读写、上传、下载、一次性 shell 命令、
  shell task 和交互式终端。
- Web dashboard 支持 Sessions、Devices、Workspaces、Runtime settings、
  Team/Admin 管理和 Session 详情页。

## 本地开发

启动后端：

```bash
cd server
uv sync
AGENT_SERVER_DB=agent-server.sqlite3 \
  uv run uvicorn agent_server.app:create_app --factory --host 127.0.0.1 --port 8000
```

另开一个终端启动前端：

```bash
cd web
yarn install
yarn dev
```

Vite 开发服务器默认把 API 和 WebSocket 路由代理到
`http://127.0.0.1:8000`。如需修改后端地址：

```bash
cd web
AGENTS_ANYWHERE_API=http://127.0.0.1:8000 yarn dev
```

从 UI 创建或配对 Connector，然后在目标机器上启动本地 Connector：

```bash
cd connector
uv sync
uv run agent-connector start \
  --server-url http://127.0.0.1:8000 \
  --connector-id conn_xxx \
  --connector-token cxt_xxx
```

也可以先保存 Connector 配置，再用已保存配置启动：

```bash
cd connector
uv run agent-connector configure \
  --server-url http://127.0.0.1:8000 \
  --connector-id conn_xxx \
  --connector-token cxt_xxx

uv run agent-connector start
```

或者在目标机器上发起配对流程：

```bash
cd connector
uv sync
uv run agent-connector login --server-url http://127.0.0.1:8000
```

命令会输出 pairing code。在 Web UI 的配对窗口中输入该 code，Connector 会保存
配置并启动；如只想保存配置不启动，可加 `--no-start`。

如果 `codex` 或 `claude` 不在 `PATH` 中，可以在 UI 中配置 Runtime 路径，或在
启动 Connector 前设置：

```bash
CODEX_BIN=/path/to/codex
CLAUDE_BIN=/path/to/claude
```

## 验证

```bash
cd server
uv run ruff check . --exclude .venv
uv run pytest -q

cd ../connector
uv run ruff check connector tests
uv run pytest -q

cd ../web
yarn build
```

## 部署

Docker 部署文件在 [docker/](docker/README.md)。生产镜像会构建前端，并由
FastAPI 后端托管；数据库和文件数据持久化在 `/data`。compose 文件会启动
PostgreSQL，并为上传文件和附件使用单独的持久化 volume。

## 注意事项

- 默认不会自动启动本地开发服务器。
- Runtime 控制通过 Connector 执行，所以文件、shell 和终端功能使用的是
  Connector 所在机器的本地权限。
- 前端生成的配对命令会使用当前浏览器 origin 作为 server URL。
- 本地数据库、虚拟环境、构建产物、参考缓存和 Runtime 文件存储已被 Git 忽略。

## 开源许可

[MIT](LICENSE)
