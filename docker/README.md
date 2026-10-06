# Docker

Agents Anywhere v2 主线的 Docker 部署。已有数据库时，运行 Compose 之前先读
[升级指南](../docs/upgrading.md)。当前 schema 版本为 `v2_35`；下文的历史迁移说明
只解释各自的变更，不代表最新目标版本。

当前 Web 控制台位于 `web-next/`。生产 Docker 构建会把导出的静态文件打进最终
镜像，由 FastAPI 后端以同一 origin 同时提供这些文件与 API/WebSocket 路径。

## 快速开始

从仓库根目录运行。

开发容器（需要可达的 PostgreSQL 与 Redis 服务）：

```bash
docker build -f docker/Dockerfile.dev -t agents-anywhere:dev . \
  && docker run --rm -it \
    --name agents-anywhere-dev \
    -p 5174:5174 \
    -v agents-anywhere-dev-data:/data \
    -e AGENT_SERVER_DB_URL=postgresql+asyncpg://agents:password@host.docker.internal:5432/agents_anywhere \
    -e AGENT_SERVER_REDIS_URL=redis://host.docker.internal:6379/0 \
    agents-anywhere:dev
```

打开 `http://127.0.0.1:5174`。

基于 PostgreSQL 的 Compose：

```bash
POSTGRES_PASSWORD=change-me \
AGENT_SERVER_SECRET=change-me-too \
docker compose -f docker/docker-compose.postgres.yml up --build
```

打开 `http://127.0.0.1:5174`。

## 开发镜像

`docker/Dockerfile.dev` 在一个容器里同时启动 FastAPI 后端与 Next.js 开发服务器。

```bash
docker build -f docker/Dockerfile.dev -t agents-anywhere:dev .
docker run --rm -it \
  -p 5174:5174 \
  -v agents-anywhere-data:/data \
  -e AGENT_SERVER_DB_URL=postgresql+asyncpg://agents:password@host.docker.internal:5432/agents_anywhere \
  -e AGENT_SERVER_REDIS_URL=redis://host.docker.internal:6379/0 \
  agents-anywhere:dev
```

容器内部：

- 后端监听 `127.0.0.1:8000`
- Next 开发服务器监听 `0.0.0.0:5174`
- Next 把 API/WebSocket 流量重写到后端
- 需要 PostgreSQL，并通过 `AGENT_SERVER_DB_URL` 配置
- 本地上传与附件可以存放在 `/data` 下

## 生产镜像

`docker/Dockerfile` 在中间阶段构建 `web-next` 静态导出，再把它拷贝进最终的
`server` 镜像。

手动构建并运行基于 PostgreSQL 的服务：

```bash
docker build -f docker/Dockerfile --target server -t agents-anywhere-server:latest .

docker run -d \
  --name agents-anywhere-server \
  -p 5174:8000 \
  -v agents-anywhere-data:/data \
  -e AGENT_SERVER_SECRET=change-me-before-production \
  -e AGENT_SERVER_DB_URL=postgresql+asyncpg://agents:password@host.docker.internal:5432/agents_anywhere \
  -e AGENT_SERVER_REDIS_URL=redis://host.docker.internal:6379/0 \
  agents-anywhere-server:latest
```

数据库状态由 PostgreSQL 存储。除非配置了 S3 兼容存储，上传的文件与附件存放在
`/data/agent-server.files/`。

设置 `AGENT_SERVER_FILES_BACKEND=s3` 和对应的 `AGENT_SERVER_FILES_S3_*` 变量，
可以把上传文件存到 S3 兼容对象存储，而不是本地 `/data/agent-server.files/`。

官方源较慢时使用 Debian apt 与 PyPI 镜像：

```bash
docker build -f docker/Dockerfile --target server -t agents-anywhere-server:latest \
  --build-arg APT_MIRROR=https://mirrors.ustc.edu.cn/debian \
  --build-arg PIP_INDEX_URL=https://mirrors.ustc.edu.cn/pypi/simple \
  --build-arg YARN_REGISTRY=https://registry.npmmirror.com \
  .
```

## PostgreSQL Compose

`docker/docker-compose.postgres.yml` 以固定的 Compose 项目名 `agents-anywhere`
运行 PostgreSQL 与 FastAPI 服务器。服务器镜像内含静态导出的 Web 控制台。

```bash
POSTGRES_PASSWORD=change-me \
AGENT_SERVER_SECRET=change-me-too \
docker compose -f docker/docker-compose.postgres.yml up --build
```

Compose 文件包含：

- `postgres-next` 服务：PostgreSQL 17
- `redis-next` 服务：跨实例协调、Pub/Sub，以及实时 Timeline 序列器/写缓冲
- `migrate-next` 一次性服务：在服务器启动前升级数据库
- `server-next` 服务：FastAPI 后端与静态导出的 Web UI
- `agents-anywhere-pg-next` 卷：PostgreSQL 数据
- `agents-anywhere-redis-next` 卷挂载到 `/data`：Redis AOF 数据
- `agents-anywhere-files-next` 卷挂载到 `/data`：上传/附件
- 对外 Web 端口 `${AGENTS_ANYWHERE_WEB_PORT:-5174}`
- 静态 `web-next` 文件由 FastAPI 提供服务，与 API 同一 origin
- 反向代理之后可选 `AGENT_SERVER_PUBLIC_ORIGIN=https://agents.example.com`，用于 OAuth 回调 URL
- 通过会话级 advisory lock 串行化 PostgreSQL 迁移
- Redis 内存由 `REDIS_MAXMEMORY` 限制（默认 `256mb`），策略 `noeviction`
- Redis AOF 持久化，`appendfsync everysec`；RDB 快照保持关闭
- Timeline revision lease 通过 `AGENT_SERVER_TIMELINE_REVISION_LEASE_SIZE` 配置（默认 `4096`）

把 Web 控制台发布到其他主机端口：

```bash
AGENTS_ANYWHERE_WEB_PORT=18000 \
POSTGRES_PASSWORD=change-me \
AGENT_SERVER_SECRET=change-me-too \
docker compose -f docker/docker-compose.postgres.yml up --build
```

对于最多 8 CPU 机器上的已初始化部署，使用保守的四 worker 起步配置：

```bash
docker compose \
  -f docker/docker-compose.postgres.yml \
  -f docker/docker-compose.8cpu.yml \
  up -d --build server-next
```

同一个 override 也可以叠加到 server 服务名为 `server-next` 的生产 Compose 文件
上。它使用四个 Uvicorn worker、每个 worker 一个计算子进程，把 Server 容器限制在
8 CPU，并把每个 worker 的数据库池固定为 4 个基础加 4 个溢出连接（共 32）。事件
准备阶段每个 worker 最多接收 16 个任务 / 16 MiB（含运行中的任务）。这些是输入
准入预算；进程内存还包括应用状态、输出缓冲与 IPC 拷贝。镜像通过
`agent_server.main` 启动，它会读取这些设置，并在没有 Redis 或启用了单实例
Timeline 快捷方式时拒绝多 worker 运行。

在空数据库上，先以单 worker 完成既有的 bootstrap 流程，再应用该配置：初始 setup
token 是进程本地的。所有 worker 使用共享的上传卷或 S3，以及相同的认证密钥。
即使设置了实例名前缀，每个 worker 的 RPC 身份仍保持唯一。

该配置的实测扩展性与单连接上限见
[会话性能报告](../docs/performance/session-pipeline.md)。

本地开发之外请使用非默认的 `AGENT_SERVER_SECRET` 与数据库密码。生产环境请在 Web
服务前加 HTTPS。

Timeline 写入刷写之后，PostgreSQL 仍是持久事实来源。除失效通知、短生命周期
WebSocket ticket 与分布式锁外，Redis 还承载已接受但未刷写的 Timeline upsert 与
实时 sequence head。sequence head 使用从 PostgreSQL 持久租借的区间，因此 Redis
状态丢失可能留下 sequence 空洞，但不会复用已分配的值。

由于待刷写的 Timeline 与序列器 key 没有 TTL，Redis 使用 AOF `everysec`、持久化
的 `/data` 卷和 `noeviction`。最近一次 AOF 同步之前发生故障仍可能丢失一条未刷写
的 upsert；一致性敏感/手动读取会先加围栏，把待写的 Timeline 刷入 PostgreSQL。

`server-next` 使用的 Redis ACL 除常规数据命令外必须允许 `INFO server`。当前
Timeline 路径每次高频 upsert 都用 `INFO server` 读取 Redis `run_id`，并在为一次
已接受变更分配 revision 后重新读取。上线前请对照生产 Redis 服务验证 ACL 与该
命令的调用频率。

`appendfsync everysec` 下，Redis 或其主机故障可能丢失最近一个尚未 fsync 的命令
区间。如果省略 `AGENT_SERVER_REDIS_URL`，单进程回退会把已接受但未刷写的 Timeline
payload 只保存在进程内存中；进程崩溃会丢失自上次刷写以来接受的所有内容（通常是
最多一个配置的刷写间隔）。两种情况下，PostgreSQL 的持久分配水位都能防止 revision
复用，但无法找回丢失的 payload，因此本地回退只用于开发，不是持久化或多实例部署
方案。

### v2.24 上线与回滚

绝不能让 `v2.23`（或更早）与 `v2.24` 的 Server 写入进程同时写同一个数据库。使用
停止-迁移-启动的部署方式：停止所有旧 Server 与外部写入方，备份数据库并执行迁移，
然后只启动 `v2.24` 的写入进程。`migrate-next` 依赖关系决定了新 Compose 服务的
启动顺序，但它不会隔离仍在运行的旧容器、其他 Compose 项目或外部 Server。

在 PostgreSQL 上，`v2.24` 把会话与 Timeline 的 sequence 列从 `int4` 扩到 `int8`。
依据 PostgreSQL 版本、表大小、索引与可用资源，这些 `ALTER TABLE` 操作可能持有
强锁，并可能重写表或索引存储。请先在生产规模的副本上演练迁移、测量锁与耗时特征，
并在生产执行前预留维护窗口。

降级同样必须在所有写入进程停止后执行。只要存在任何会话有未消费的 revision lease
（`seq_allocated_high <> seq`），或某个 sequence 值超出有符号 32 位存储范围，降级
就会拒绝。由于正常的 `v2.24` 流量可能立即让活跃 lease 超前于持久 sequence，请把
schema 迁移视为只进不退，除非在重启写入进程之前已验证过降级检查。

在空数据库上首次启动时，`server-next` 日志会打印一个 bootstrap token。用它在
Web 界面创建第一个管理员用户。

## Connector Ubuntu 镜像

`docker/Dockerfile.connector-ubuntu` 构建一个 Ubuntu 24.04 环境，包含常用 CLI
工具、`uv`、OpenSSH 服务器以及 Agents Anywhere Connector。镜像不含服务器凭据；
运行时选择 token 启动或配对。

构建：

```bash
docker build -f docker/Dockerfile.connector-ubuntu -t agents-anywhere-connector:ubuntu2404 .
```

使用已有的 connector token 启动：

```bash
docker run --rm -it \
  -p 2222:2222 \
  -v agents-anywhere-connector-data:/data \
  -v "$PWD:/workspace" \
  -e AGENT_SERVER_URL=http://host.docker.internal:8000 \
  -e AGENT_CONNECTOR_ID=conn_xxx \
  -e AGENT_CONNECTOR_TOKEN=cxt_xxx \
  -e SSH_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" \
  agents-anywhere-connector:ubuntu2404
```

也可以从容器内发起配对：

```bash
docker run --rm -it \
  -p 2222:2222 \
  -v agents-anywhere-connector-data:/data \
  -v "$PWD:/workspace" \
  -e AGENT_CONNECTOR_MODE=pair \
  -e AGENT_SERVER_URL=http://host.docker.internal:8000 \
  -e SSH_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" \
  agents-anywhere-connector:ubuntu2404
```

## 带 Agent 安装器的 Connector Ubuntu 镜像

`docker/Dockerfile.connector-agents-ubuntu` 在 Connector Ubuntu 镜像基础上增加了
Node.js，以及 Codex CLI 和 Claude Code 的运行时安装钩子。

构建：

```bash
docker build -f docker/Dockerfile.connector-agents-ubuntu -t agents-anywhere-connector:agents-ubuntu2404 .
```

启动并在运行时安装两个 Agent CLI：

```bash
docker run --rm -it \
  -p 2222:2222 \
  -v agents-anywhere-connector-data:/data \
  -v "$PWD:/workspace" \
  -e AGENT_CONNECTOR_MODE=pair \
  -e AGENT_SERVER_URL=http://host.docker.internal:8000 \
  -e INSTALL_CODEX=true \
  -e INSTALL_CLAUDE=true \
  -e SSH_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" \
  agents-anywhere-connector:agents-ubuntu2404
```

运行时安装变量：

| 变量 | 用途 |
| --- | --- |
| `INSTALL_CODEX` | 为 true/yes/1/on 时，启动 Connector 前安装 Codex CLI。 |
| `CODEX_NPM_PACKAGE` | Codex npm 包。默认 `@openai/codex`。 |
| `CODEX_VERSION` | 可选的 Codex 包版本。 |
| `INSTALL_CLAUDE` | 为 true/yes/1/on 时，启动 Connector 前安装 Claude Code。 |
| `CLAUDE_NPM_PACKAGE` | Claude Code npm 包。默认 `@anthropic-ai/claude-code`。 |
| `CLAUDE_VERSION` | 可选的 Claude Code 包版本。 |
| `NPM_CONFIG_REGISTRY` | 可选的 npm registry 镜像。 |
