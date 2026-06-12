# Docker

Docker deployment files for Agents Anywhere.

## Quickstart

Run from the repository root.

Development container:

```bash
docker build -f docker/Dockerfile.dev -t agents-anywhere:dev . \
  && docker run --rm -it \
    --name agents-anywhere-dev \
    -p 5173:5173 \
    -v agents-anywhere-dev-data:/data \
    agents-anywhere:dev
```

Production-style container:

```bash
docker build -f docker/Dockerfile -t agents-anywhere:latest . \
  && docker run --rm -it \
    --name agents-anywhere \
    -p 8000:8000 \
    -v agents-anywhere-data:/data \
    -e AGENT_SERVER_SECRET=change-me-before-production \
    agents-anywhere:latest
```

Use Debian apt and PyPI mirrors when official sources are slow:

```bash
docker build -f docker/Dockerfile -t agents-anywhere:latest \
  --build-arg APT_MIRROR=https://mirrors.ustc.edu.cn/debian \
  --build-arg PIP_INDEX_URL=https://mirrors.ustc.edu.cn/pypi/simple \
  .
```

PostgreSQL-backed compose:

```bash
POSTGRES_PASSWORD=change-me \
AGENT_SERVER_SECRET=change-me-too \
docker compose -f docker/docker-compose.postgres.yml up --build
```

## Development Image

`docker/Dockerfile.dev` runs the backend and Vite dev server in one container.
Only the Vite port is published.

```bash
docker build -f docker/Dockerfile.dev -t agents-anywhere:dev .
docker run --rm -it \
  -p 5173:5173 \
  -v agents-anywhere-data:/data \
  agents-anywhere:dev
```

Inside the container:

- backend listens on `127.0.0.1:8000`
- Vite listens on `0.0.0.0:5173`
- Vite proxies API/WebSocket traffic to the backend
- SQLite data is stored at `/data/agent-server.sqlite3`

## Production-Style Image

`docker/Dockerfile` builds the frontend, copies `web/dist` into the backend
image, serves it through FastAPI, and only exposes the backend port.

```bash
docker build -f docker/Dockerfile -t agents-anywhere:latest .
docker run --rm -it \
  -p 8000:8000 \
  -v agents-anywhere-data:/data \
  agents-anywhere:latest
```

Persistent data under `/data`:

- SQLite database: `/data/agent-server.sqlite3`
- uploaded files / attachments: `/data/agent-server.files/`

Set `AGENT_SERVER_FILES_BACKEND=s3` and the matching
`AGENT_SERVER_FILES_S3_*` variables to store uploaded files in S3-compatible
object storage instead of the local `/data/agent-server.files/` directory.

## PostgreSQL Compose

`docker/docker-compose.postgres.yml` runs PostgreSQL and the production-style
server image.

```bash
cd docker
POSTGRES_PASSWORD=change-me \
AGENT_SERVER_SECRET=change-me-too \
docker compose -f docker-compose.postgres.yml up --build
```

Connector Ubuntu image with SSH:

```bash
docker build -f docker/Dockerfile.connector-ubuntu -t agents-anywhere-connector:ubuntu2404 .
docker run --rm -it \
  --name agents-anywhere-connector \
  -p 2222:2222 \
  -v agents-anywhere-connector-data:/data \
  -v "$PWD:/workspace" \
  -e AGENT_SERVER_URL=http://host.docker.internal:8000 \
  -e AGENT_CONNECTOR_ID=conn_xxx \
  -e AGENT_CONNECTOR_TOKEN=cxt_xxx \
  -e SSH_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" \
  agents-anywhere-connector:ubuntu2404
```

The compose file uses:

- `agents-anywhere-pg` volume for PostgreSQL data
- `agents-anywhere-files` volume mounted at `/data` for uploaded files /
  attachments
- port `8000` for the backend and frontend by default
- `AGENT_SERVER_STATIC_DIR=/app/web-dist` so the backend serves the built web UI
  and root assets such as `/site.webmanifest`

Set `AGENTS_ANYWHERE_PORT=18000` to publish the service on a different host
port:

```bash
AGENTS_ANYWHERE_PORT=18000 \
POSTGRES_PASSWORD=change-me \
AGENT_SERVER_SECRET=change-me-too \
docker compose -f docker-compose.postgres.yml up --build
```

Use a non-default `AGENT_SERVER_SECRET` and database password outside local
development.

If root web assets return 404, check that the running server container has the
built files:

```bash
docker compose -f docker-compose.postgres.yml exec server \
  sh -lc 'echo "$AGENT_SERVER_STATIC_DIR" && ls -l /app/web-dist/site.webmanifest'
```

## Connector Ubuntu Image

`docker/Dockerfile.connector-ubuntu` builds an Ubuntu 24.04 environment with
common CLI tools, `uv`, OpenSSH server, and the Agents Anywhere Connector. It
does not contain server credentials; choose token startup or pairing at runtime.

Build:

```bash
docker build -f docker/Dockerfile.connector-ubuntu -t agents-anywhere-connector:ubuntu2404 .
```

Use USTC mirrors when official sources are slow:

```bash
docker build -f docker/Dockerfile.connector-ubuntu -t agents-anywhere-connector:ubuntu2404 \
  --build-arg APT_MIRROR=https://mirrors.ustc.edu.cn/ubuntu \
  --build-arg UV_INDEX_URL=https://mirrors.ustc.edu.cn/pypi/simple \
  .
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

The container user is `agent`. SSH listens on container port `2222`; change it
with `SSH_PORT` if needed and publish the same container port. Prefer
`SSH_AUTHORIZED_KEYS` for login. `SSH_PASSWORD` is also supported for temporary
local testing.
