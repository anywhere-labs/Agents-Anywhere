# Docker

Docker files for Agents Anywhere.

The current Web console lives in `web-next/`. Production Docker builds export it
as static files and the FastAPI backend serves those files and API/WebSocket
paths from the same origin.

## Quickstart

Run from the repository root.

Development container:

```bash
docker build -f docker/Dockerfile.dev -t agents-anywhere:dev . \
  && docker run --rm -it \
    --name agents-anywhere-dev \
    -p 5174:5174 \
    -v agents-anywhere-dev-data:/data \
    agents-anywhere:dev
```

Open `http://127.0.0.1:5174`.

PostgreSQL-backed compose:

```bash
POSTGRES_PASSWORD=change-me \
AGENT_SERVER_SECRET=change-me-too \
docker compose -f docker/docker-compose.postgres.yml up --build
```

Open `http://127.0.0.1:5174`.

## Development Image

`docker/Dockerfile.dev` starts the FastAPI backend and the Next.js dev server in
one container.

```bash
docker build -f docker/Dockerfile.dev -t agents-anywhere:dev .
docker run --rm -it \
  -p 5174:5174 \
  -v agents-anywhere-data:/data \
  agents-anywhere:dev
```

Inside the container:

- backend listens on `127.0.0.1:8000`
- Next dev listens on `0.0.0.0:5174`
- Next rewrites API/WebSocket traffic to the backend
- SQLite data is stored at `/data/agent-server.sqlite3`

## Production Images

`docker/Dockerfile` builds the `web-next` static export in an intermediate
stage and copies it into the final `server` image.

Build and run a SQLite-backed service manually:

```bash
docker build -f docker/Dockerfile --target server -t agents-anywhere-server:latest .

docker run -d \
  --name agents-anywhere-server \
  -p 5174:8000 \
  -v agents-anywhere-data:/data \
  -e AGENT_SERVER_SECRET=change-me-before-production \
  agents-anywhere-server:latest
```

Persistent server data under `/data`:

- SQLite database: `/data/agent-server.sqlite3`
- uploaded files / attachments: `/data/agent-server.files/`

Set `AGENT_SERVER_FILES_BACKEND=s3` and the matching
`AGENT_SERVER_FILES_S3_*` variables to store uploaded files in S3-compatible
object storage instead of the local `/data/agent-server.files/` directory.

Use Debian apt and PyPI mirrors when official sources are slow:

```bash
docker build -f docker/Dockerfile --target server -t agents-anywhere-server:latest \
  --build-arg APT_MIRROR=https://mirrors.ustc.edu.cn/debian \
  --build-arg PIP_INDEX_URL=https://mirrors.ustc.edu.cn/pypi/simple \
  .
```

## PostgreSQL Compose

`docker/docker-compose.postgres.yml` runs PostgreSQL and the FastAPI server. The
server image includes the statically exported Web console.

```bash
POSTGRES_PASSWORD=change-me \
AGENT_SERVER_SECRET=change-me-too \
docker compose -f docker/docker-compose.postgres.yml up --build
```

The compose file uses:

- `agents-anywhere-pg-next` volume for PostgreSQL data
- `agents-anywhere-files-next` volume mounted at `/data` for uploads / attachments
- public Web port `${AGENTS_ANYWHERE_WEB_PORT:-5174}`
- static `web-next` files served by FastAPI from the same origin as the API
- optional `AGENT_SERVER_PUBLIC_ORIGIN=https://agents.example.com` for OAuth redirect URLs behind a reverse proxy

Publish the Web console on a different host port:

```bash
AGENTS_ANYWHERE_WEB_PORT=18000 \
POSTGRES_PASSWORD=change-me \
AGENT_SERVER_SECRET=change-me-too \
docker compose -f docker/docker-compose.postgres.yml up --build
```

Use a non-default `AGENT_SERVER_SECRET` and database password outside local
development. Put HTTPS in front of the Web service for production.

## Connector Ubuntu Image

`docker/Dockerfile.connector-ubuntu` builds an Ubuntu 24.04 environment with
common CLI tools, `uv`, OpenSSH server, and the Agents Anywhere Connector. It
does not contain server credentials; choose token startup or pairing at runtime.

Build:

```bash
docker build -f docker/Dockerfile.connector-ubuntu -t agents-anywhere-connector:ubuntu2404 .
```

Start with an existing connector token:

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

Start pairing from the container instead:

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

## Connector Ubuntu Image With Agent Installers

`docker/Dockerfile.connector-agents-ubuntu` extends the Connector Ubuntu image
with Node.js and runtime install hooks for Codex CLI and Claude Code.

Build:

```bash
docker build -f docker/Dockerfile.connector-agents-ubuntu -t agents-anywhere-connector:agents-ubuntu2404 .
```

Start and install both agent CLIs at runtime:

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

Runtime install variables:

| Variable | Purpose |
| --- | --- |
| `INSTALL_CODEX` | Install Codex CLI before starting the Connector when true/yes/1/on. |
| `CODEX_NPM_PACKAGE` | Codex npm package. Defaults to `@openai/codex`. |
| `CODEX_VERSION` | Optional Codex package version. |
| `INSTALL_CLAUDE` | Install Claude Code before starting the Connector when true/yes/1/on. |
| `CLAUDE_NPM_PACKAGE` | Claude Code npm package. Defaults to `@anthropic-ai/claude-code`. |
| `CLAUDE_VERSION` | Optional Claude Code package version. |
| `NPM_CONFIG_REGISTRY` | Optional npm registry mirror. |
