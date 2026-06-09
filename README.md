# Agents Anywhere

Agents Anywhere is a web workspace for running local agent runtimes from a
browser. The backend is the HTTP source of truth, the connector runs on a user
machine or remote host, and the frontend provides auth, device pairing, session
management, runtime settings, filesystem access, terminal access, approvals,
and timeline inspection.

## Packages

```text
server/      FastAPI backend, SQLite/PostgreSQL storage, connector RPC broker
connector/   Local daemon and CLI for Codex / Claude runtime integration
web/         React + Vite frontend
docker/      Development, production, and PostgreSQL compose deployment files
docs/        Shared reference notes only
```

Package-specific docs live with the package:

- [Server](server/README.md)
- [Connector](connector/README.md)
- [Web](web/README.md)
- [Docker](docker/README.md)

## Quickstart

Use Docker when you want the fastest full-app startup from a clean checkout.

Development container: builds the backend + web dev image, starts FastAPI
inside the container, starts Vite with its proxy pointed at that backend, and
publishes only the Vite port.

```bash
docker build -f docker/Dockerfile.dev -t agents-anywhere:dev . \
  && docker run --rm -it \
    --name agents-anywhere-dev \
    -p 5173:5173 \
    -v agents-anywhere-dev-data:/data \
    agents-anywhere:dev
```

Open `http://127.0.0.1:5173`.

Production-style container: builds the frontend, serves the built assets from
FastAPI, persists runtime data under `/data`, and publishes only the backend
port.

```bash
docker build -f docker/Dockerfile -t agents-anywhere:latest . \
  && docker run --rm -it \
    --name agents-anywhere \
    -p 8000:8000 \
    -v agents-anywhere-data:/data \
    -e AGENT_SERVER_SECRET=change-me-before-production \
    agents-anywhere:latest
```

Open `http://127.0.0.1:8000`.

PostgreSQL-backed production-style compose:

```bash
POSTGRES_PASSWORD=change-me \
AGENT_SERVER_SECRET=change-me-too \
docker compose -f docker/docker-compose.postgres.yml up --build
```

The first startup on an empty database logs a bootstrap token. Use it in the
web UI to create the first admin user.

## Current Features

- First-run bootstrap, login, registration control, user management, and avatar
  upload.
- Connector creation, browser-based pairing, token exchange, heartbeat,
  reconnect, and online/offline status.
- Runtime discovery and per-device agent settings for Codex and Claude.
- Session create/list/update, archive/pin/read state, takeover, messages,
  interrupt, sync, approvals, and timeline polling/SSE.
- Connector RPC for local filesystem browsing, file read/write, uploads,
  downloads, one-shot shell commands, shell tasks, and interactive terminals.
- Web dashboard for sessions, devices, workspaces, runtime settings, team/admin
  management, and session detail.

## Local Development

Start the backend:

```bash
cd server
uv sync
AGENT_SERVER_DB=agent-server.sqlite3 \
  uv run uvicorn agent_server.app:create_app --factory --host 127.0.0.1 --port 8000
```

Start the web app in another shell:

```bash
cd web
yarn install
yarn dev
```

The Vite dev server proxies API and WebSocket routes to
`http://127.0.0.1:8000` by default. Override the backend target when needed:

```bash
cd web
AGENTS_ANYWHERE_API=http://127.0.0.1:8000 yarn dev
```

Create or pair a connector from the UI, then start the local connector:

```bash
cd connector
uv sync
uv run agent-connector start \
  --server-url http://127.0.0.1:8000 \
  --connector-id conn_xxx \
  --connector-token cxt_xxx
```

For a saved connector config:

```bash
cd connector
uv run agent-connector configure \
  --server-url http://127.0.0.1:8000 \
  --connector-id conn_xxx \
  --connector-token cxt_xxx

uv run agent-connector start
```

If `codex` or `claude` is not on `PATH`, configure the runtime path from the UI
or set `CODEX_BIN=/path/to/codex` / `CLAUDE_BIN=/path/to/claude` before
starting the connector.

## Verify

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

## Deployment

Docker deployment files are under [docker/](docker/README.md). The production
image builds the frontend, serves it from the FastAPI backend, and persists
database/files under `/data`. The compose file runs PostgreSQL for the server
database and a separate persistent volume for uploaded files / attachments.

## Notes

- Local development servers are not started automatically by default.
- Runtime control happens through the connector, so filesystem, shell, and
  terminal features run with the connector machine's local permissions.
- The pairing command shown in the frontend uses the current browser origin as
  the server URL.
- Local databases, virtual environments, build output, reference caches, and
  runtime file stores are ignored by Git.
