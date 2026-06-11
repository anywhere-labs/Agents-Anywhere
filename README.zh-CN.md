# Agents Anywhere

[English](README.md) · **简体中文**

Agents Anywhere 是一个 Web 工作区，用于通过浏览器运行本地 Agent 运行时。后端作为 HTTP 事实来源，连接器（Connector）运行在用户计算机或远程主机上，前端提供身份验证、设备配对、会话管理、运行时设置、文件系统访问、终端访问、权限批准以及时间线审查等功能。

## 代码包

```text
server/      FastAPI 后端，SQLite/PostgreSQL 存储，连接器 RPC 消息代理
connector/   本地守护进程和 CLI，用于集成 Codex / Claude 运行时
web/         React + Vite 前端
docker/      开发、生产及 PostgreSQL docker-compose 部署文件
docs/        仅作共享参考笔记之用
```

特定包的文档存放在对应目录中：

- [Server](server/README.md)
- [Connector](connector/README.md)
- [Web](web/README.md)
- [Docker](docker/README.md)

## 快速开始

当你希望从干净的代码库以最快速度启动完整应用时，请使用 Docker。

**开发容器**：构建后端 + Web 开发镜像，在容器内启动 FastAPI，启动 Vite（代理指向该后端），并仅对外暴露 Vite 端口。

```bash
docker build -f docker/Dockerfile.dev -t agents-anywhere:dev . \
  && docker run --rm -it \
    --name agents-anywhere-dev \
    -p 5173:5173 \
    -v agents-anywhere-dev-data:/data \
    agents-anywhere:dev
```

打开 `http://127.0.0.1:5173`。

**生产风格容器**：构建前端，通过 FastAPI 提供编译后的静态资源服务，在 `/data` 下持久化运行时数据，并仅暴露后端端口。

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

**基于 PostgreSQL 的生产风格 compose**：

```bash
POSTGRES_PASSWORD=change-me \
AGENT_SERVER_SECRET=change-me-too \
docker compose -f docker/docker-compose.postgres.yml up --build
```

首次在空数据库上启动时会记录一个 bootstrap token。在 Web UI 中使用该 token 来创建第一个管理员用户。

## 当前特性

- 首次运行引导、登录、注册控制、用户管理及头像上传。
- 连接器（Connector）创建、基于浏览器的配对、Token 交换、心跳、重连及在线/离线状态管理。
- 运行时发现及针对单设备的 Codex 和 Claude Agent 设置。
- 会话（Session）的创建/列表/更新，归档/置顶/已读状态，接管，消息，中断，同步，权限批准以及时间线轮询/SSE。
- 连接器 RPC，支持本地文件系统浏览、文件读写、上传、下载、单次 shell 命令执行、shell 任务及交互式终端。
- 网页控制台，用于管理会话、设备、工作区、运行时设置、团队/管理员管理以及会话详情。

## 本地开发

启动后端：

```bash
cd server
uv sync
AGENT_SERVER_DB=agent-server.sqlite3 \
  uv run uvicorn agent_server.app:create_app --factory --host 127.0.0.1 --port 8000
```

在另一个终端启动 Web 应用：

```bash
cd web
yarn install
yarn dev
```

默认情况下，Vite 开发服务器将 API 和 WebSocket 路由代理到 `http://127.0.0.1:8000`。需要时可覆盖后端目标地址：

```bash
cd web
AGENTS_ANYWHERE_API=http://127.0.0.1:8000 yarn dev
```

从 UI 创建或配对连接器，然后启动本地连接器：

```bash
cd connector
uv sync
uv run agent-connector start \
  --server-url http://127.0.0.1:8000 \
  --connector-id conn_xxx \
  --connector-token cxt_xxx
```

对于已保存的连接器配置：

```bash
cd connector
uv run agent-connector configure \
  --server-url http://127.0.0.1:8000 \
  --connector-id conn_xxx \
  --connector-token cxt_xxx

uv run agent-connector start
```

如果 `codex` 或 `claude` 不在环境变量 `PATH` 中，请从 UI 配置运行时路径，或在启动连接器前设置 `CODEX_BIN=/path/to/codex` / `CLAUDE_BIN=/path/to/claude`。

## 验证与测试

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

Docker 部署文件位于 [docker/](docker/README.md)。生产镜像构建前端，由 FastAPI 后端提供服务，并将数据库/文件持久化在 `/data` 下。compose 文件运行 PostgreSQL 作为服务器数据库，并为上传文件/附件提供独立的持久化存储卷。

## 注意事项

- 默认情况下，不会自动启动本地开发服务器。
- 运行时控制通过连接器（Connector）进行，因此文件系统、shell 和终端功能使用连接器所在机器的本地权限运行。
- 前端显示的配对命令会将当前浏览器所在 origin 作为服务器 URL。
- 本地数据库、虚拟环境、构建输出、参考缓存以及运行时文件存储均被 Git 忽略。
