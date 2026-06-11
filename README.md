<div align="center">

# Agents Anywhere

<h3>Remote control plane for Claude Code, Codex, and more coding agents.</h3>

Run agents on your own laptop, remote devbox, or cloud sandbox. Control sessions, approvals, files, terminals, and runtime state from one self-hostable web workspace.

[Docker Quickstart](#quickstart-run-the-full-app-with-docker) · [Pair Connector](#pair-and-start-the-connector) · [Self-host](#self-host-production-style-deployment) · [简体中文](README.zh-CN.md)

![Agents Anywhere session workspace](docs/screenshots/hero.png)

Watch long-running sessions, approve actions, inspect files, and open a terminal without moving the agent out of its original machine. To run the current open-source stack, start with [Docker Quickstart](#quickstart-run-the-full-app-with-docker).

</div>

---

> **Status: open-source development.**
> This repository contains the full Web frontend, FastAPI backend, and Python Connector CLI. It can run locally or be self-hosted with Docker. The primary client today is the Web console; mobile browsers are supported, and native mobile/desktop clients are in development.

## What Is Agents Anywhere?

You start a Claude Code or Codex task in a terminal. It runs for a while: reading files, editing code, running tests, waiting for you to approve an operation. When the agent blocks on an approval, an error, or a quick correction from you, you have to get back to that machine.

Agents Anywhere adds a remote control plane:

- The agent still runs on your machine, with your local account, local files, and local permissions.
- The Connector runs next to the agent and syncs runtime state, safe filesystem operations, shell/terminal capabilities, and approval requests to the backend.
- The Web console connects to the backend so you can inspect sessions, take over work, approve actions, browse files, and open terminals.

**It is the remote, not a new agent host.** Your code is not moved into the relay service for execution, and your model accounts and model bills remain with your own Claude Code / Codex toolchain.

## Why It Exists

Coding agents are no longer just one-off chat windows. They can run for minutes or longer, change files across a workspace, call tools, and pause at the exact moment a human decision is needed.

Without a remote control plane:

- You have to stay at the machine running the agent.
- If you walk away, the task can block on an approval or error.
- Multiple machines, sessions, and runtimes become hard to manage together.

Agents Anywhere turns those long-running tasks into a workspace you can reopen at any time: check state, inspect files, watch output, approve, interrupt, continue, and switch devices from the same Web UI.

## Product Preview

**Desktop: unified control plane**

![Unified control plane](docs/screenshots/control-plane.png)

Devices and sessions are collected in one workspace, so you can switch across machines, runtimes, and tasks.

**Mobile: sessions and devices**

![Mobile sessions and devices](docs/screenshots/mobile.png)

Native mobile clients are in development. Today, you can also use the Web console from a mobile browser for status checks, device management, and lightweight approvals.

## Current Capabilities

- **Unified session workspace.** Create, inspect, pin, archive, mark read, take over, and manage sessions.
- **Codex / Claude runtime integration.** The Connector discovers local Codex and Claude runtimes and reports capabilities.
- **Approvals and sync.** Supports interrupt, sync, approval resolution, and timeline polling/SSE.
- **Local file access.** Browse workspaces, read/write files, upload content, and download content through an online Connector.
- **Remote shell and terminal.** Run one-shot shell commands, shell tasks, and interactive terminals.
- **Device pairing.** Start from a Web-generated token command or from `agent-connector login` with a pairing code.
- **Self-hosted backend.** The FastAPI backend supports SQLite for local development and PostgreSQL for production-style deployments.
- **Web console.** React + Vite frontend for auth, devices, workspaces, runtime settings, team/admin management, and session detail.

## Supported Agents

Agents Anywhere does not replace your agent. It runs next to an existing runtime through the Connector:

| Agent | Vendor | Current status |
| --- | --- | --- |
| Claude Code | Anthropic | Integrated in current code |
| Codex | OpenAI | Integrated in current code |
| Cursor | Anysphere | Planned |
| OpenCode | SST | Planned |
| Gemini CLI | Google | Planned |

Connector adapters are extensible. New runtimes should reuse the existing session, timeline, approval, filesystem, and terminal capabilities where possible.

## Supported Platforms

| Platform | Current status |
| --- | --- |
| Web | Primary client today; supports modern desktop and mobile browsers |
| iOS | Native client in development |
| Android | Native client in development |
| macOS | Native desktop client in development |
| Windows | Native desktop client in development |

This repository currently includes the Web frontend, FastAPI backend, and Connector CLI. Native client code will land in the public repository or separate packages once the implementations are ready.

Want to run it now? Jump to [Docker Quickstart](#quickstart-run-the-full-app-with-docker). If you want to connect your own machine, continue to [Pair And Start The Connector](#pair-and-start-the-connector).

## FAQ

**Where does my code actually run?**
On the machine running the Connector. The backend handles auth, state, file metadata, and RPC routing; it does not execute your code on the server.

**What do I install on my dev machine?**
Run the Python CLI in `connector/`. It should live on the same machine as Codex / Claude and the workspace you want to control.

**Do my model accounts go through Agents Anywhere?**
No. The Connector uses the Codex / Claude runtime and login state already present on your machine. Agents Anywhere does not proxy model account credentials.

**Codex and Claude already provide official remote control. Why use Agents Anywhere?**
Official remote control is usually tied to each vendor's subscription account and product surface. Agents Anywhere does not need to bind to your model subscription account; it only needs the Connector to reach a runtime that is already logged in locally. The goal is one unified entry point for multiple agents: Codex, Claude, and more agents over time. More adapters are in development, and Connector adapter contributions are welcome.

**Can I self-host it?**
Yes. Use SQLite for local development, a production-style single-container SQLite deployment, or PostgreSQL compose. See [docker/README.md](docker/README.md).

**Which agents are supported today?**
The current code focuses on Codex and Claude. Other runtimes can be added by implementing Connector adapters.

## Technical Guide And Self-Hosting

The sections above describe the product: Agents Anywhere solves the problem of agents running elsewhere while humans still need to take over. The sections below are for developers and self-hosters: architecture, local startup, Connector pairing, production-style deployment, key environment variables, and verification commands. If you only want to try it, start with [Docker Quickstart](#quickstart-run-the-full-app-with-docker). If you want to add a runtime or deploy this for a team, read the architecture and Connector pairing flow first.

## Architecture

```text
┌────────────────────┐        HTTP / WebSocket        ┌────────────────────┐
│     Web Client     │  ───────────────────────────▶  │   FastAPI Server   │
│  browser console   │  ◀───────────────────────────  │ auth / sessions /  │
└────────────────────┘                                │ RPC broker / files │
                                                      └─────────┬──────────┘
                                                                │
                                                       connector WebSocket
                                                                │
                                                      ┌─────────▼──────────┐
                                                      │     Connector      │
                                                      │ local daemon + CLI │
                                                      └─────────┬──────────┘
                                                                │
                                                      ┌─────────▼──────────┐
                                                      │ Codex / Claude     │
                                                      │ local workspace    │
                                                      └────────────────────┘
```

Repository layout:

```text
server/      FastAPI backend, SQLite/PostgreSQL storage, Connector RPC broker
connector/   Local daemon and CLI for Codex / Claude runtime integration
web/         React + Vite frontend
docker/      Development, production, and PostgreSQL compose deployment files
docs/        Shared reference notes
```

Package-specific docs:

- [Server](server/README.md)
- [Connector](connector/README.md)
- [Web](web/README.md)
- [Docker](docker/README.md)

## Quickstart: Run The Full App With Docker

Run the development container from the repository root. It starts the FastAPI backend and Vite frontend in one container, and publishes only the Vite port:

```bash
docker build -f docker/Dockerfile.dev -t agents-anywhere:dev . \
  && docker run --rm -it \
    --name agents-anywhere-dev \
    -p 5173:5173 \
    -v agents-anywhere-dev-data:/data \
    agents-anywhere:dev
```

Open:

```text
http://127.0.0.1:5173
```

The first startup on an empty database logs a bootstrap token. Use it in the Web UI to create the first admin user.

## Quickstart: Local Development

The backend uses Python + FastAPI. Use `uv` for dependencies:

```bash
cd server
uv sync
AGENT_SERVER_DB=agent-server.sqlite3 \
  uv run uvicorn agent_server.app:create_app --factory --host 127.0.0.1 --port 8000
```

The frontend uses React + Vite. Use `yarn`:

```bash
cd web
yarn install
yarn dev
```

Vite listens on `127.0.0.1:5173` and proxies API / WebSocket requests to `http://127.0.0.1:8000` by default. Override the backend target when needed:

```bash
cd web
AGENTS_ANYWHERE_API=http://127.0.0.1:8000 yarn dev
```

## Pair And Start The Connector

The Connector should run on the machine that actually owns the workspace and agent runtime. It uses that machine's local filesystem permissions, shell permissions, and Codex / Claude login state.

### Option A: Start From The Web Console

Add a device in the Web UI, copy the generated command, and run it on the target machine. The command shape is:

```bash
cd connector
uv sync
uv run agent-connector start \
  --server-url http://127.0.0.1:8000 \
  --connector-id conn_xxx \
  --connector-token cxt_xxx
```

You can also save the config first, then start:

```bash
cd connector
uv run agent-connector configure \
  --server-url http://127.0.0.1:8000 \
  --connector-id conn_xxx \
  --connector-token cxt_xxx

uv run agent-connector start
```

The default config path is `~/.agent-server/connector.json`. Override it with `--config` or `AGENT_CONNECTOR_CONFIG`.

### Option B: Start Pairing From The Connector

```bash
cd connector
uv sync
uv run agent-connector login --server-url http://127.0.0.1:8000
```

The terminal prints a pairing code. Enter that code in the Web UI pairing dialog; the Connector saves its config and starts. To save the config without starting immediately:

```bash
uv run agent-connector login --server-url http://127.0.0.1:8000 --no-start
```

If `codex` or `claude` is not on `PATH`, configure the runtime path from the UI or set these before starting the Connector:

```bash
CODEX_BIN=/path/to/codex
CLAUDE_BIN=/path/to/claude
```

## Self-Host: Production-Style Deployment

### Single-Container SQLite

The production-style image builds the frontend, serves it from FastAPI, and persists database/file data under `/data`:

```bash
docker build -f docker/Dockerfile -t agents-anywhere:latest . \
  && docker run --rm -it \
    --name agents-anywhere \
    -p 8000:8000 \
    -v agents-anywhere-data:/data \
    -e AGENT_SERVER_SECRET=change-me-before-production \
    agents-anywhere:latest
```

Open:

```text
http://127.0.0.1:8000
```

### PostgreSQL Compose

```bash
POSTGRES_PASSWORD=change-me \
AGENT_SERVER_SECRET=change-me-too \
docker compose -f docker/docker-compose.postgres.yml up --build
```

The compose file runs PostgreSQL and the production-style server image:

- Backend and frontend are available on port `8000`.
- PostgreSQL data uses the `agents-anywhere-pg` volume.
- Uploads and attachments use a persistent volume mounted at `/data`.

For production, change at least `AGENT_SERVER_SECRET` and the database password, and put HTTPS in front of the service.

## Key Environment Variables

Server:

| Variable | Purpose |
| --- | --- |
| `AGENT_SERVER_DB` | SQLite database path. Defaults to `agent-server.sqlite3`. |
| `AGENT_SERVER_DB_URL` | Explicit SQLAlchemy URL. Takes precedence over `AGENT_SERVER_DB`. |
| `AGENT_SERVER_DB_BACKEND` | Database backend selector. Use `postgres` for PostgreSQL deployments. |
| `AGENT_SERVER_FILES_BACKEND` | File storage backend. Use `local` or `s3`. Defaults to `local`. |
| `AGENT_SERVER_FILES_LOCAL_ROOT` | Local file/attachment storage directory. |
| `AGENT_SERVER_FILES_S3_BUCKET` | S3 bucket name when `AGENT_SERVER_FILES_BACKEND=s3`. |
| `AGENT_SERVER_FILES_S3_PREFIX` | Optional S3 key prefix. |
| `AGENT_SERVER_FILES_S3_ENDPOINT_URL` | Optional S3-compatible endpoint URL. |
| `AGENT_SERVER_SECRET` | Server secret for signed auth tokens. Required in production. |
| `AGENT_SERVER_STATIC_DIR` | Frontend build output directory. When set, the backend serves the Web UI. |
| `AGENT_SERVER_CORS_ORIGINS` | Explicit allowed CORS origins. |

Connector:

| Variable | Purpose |
| --- | --- |
| `AGENT_CONNECTOR_CONFIG` | Connector config path. |
| `AGENT_SERVER_URL` | Backend URL used when `--server-url` is omitted. |
| `AGENT_CONNECTOR_ID` | Connector id used when `--connector-id` is omitted. |
| `AGENT_CONNECTOR_TOKEN` | Connector token used when `--connector-token` is omitted. |
| `CODEX_BIN` | Codex CLI/app-server path. |
| `CLAUDE_BIN` | Claude Code CLI path. |

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

## License

[MIT](LICENSE)
