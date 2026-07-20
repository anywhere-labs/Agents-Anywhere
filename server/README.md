# Agent Server

FastAPI backend for Agents Anywhere. The server owns authentication, users,
connectors, sessions, timeline state, approvals, file metadata, terminal
brokering, and connector RPC dispatch.

## Layout

```text
agent_server/
  api/          FastAPI route modules
  core/         Shared domain helpers and auth/setup primitives
  infra/        Database, file storage, connector RPC, timeline, terminal broker
  services/     Session, shell, and terminal workflows
  app.py        FastAPI app factory and local uvicorn entry helper
tests/          Backend tests
pyproject.toml  Server dependencies
run.sh          Local helper for SQLite development
```

## Run

Install dependencies:

```bash
uv sync
```

Start the backend from this directory:

```bash
AGENT_SERVER_DB=agent-server.sqlite3 \
  uv run uvicorn agent_server.app:create_app --factory --host 127.0.0.1 --port 8000
```

The first startup on an empty database logs a bootstrap token. Use that token in
the web UI to create the first admin user.

Health check:

```bash
curl http://127.0.0.1:8000/api/v2/health
```

## Environment

| Variable | Purpose |
| --- | --- |
| `AGENT_SERVER_DB` | SQLite database path. Defaults to `agent-server.sqlite3`. |
| `AGENT_SERVER_DB_URL` | Explicit SQLAlchemy URL. Takes precedence over `AGENT_SERVER_DB`. |
| `AGENT_SERVER_DB_BACKEND` | Database backend selector. Use `postgres` with `AGENT_SERVER_DB_URL`. |
| `AGENT_SERVER_FILES_BACKEND` | File storage backend. Use `local` or `s3`. Defaults to `local`. |
| `AGENT_SERVER_FILES_LOCAL_ROOT` | Local attachment/file root. Defaults next to the database. |
| `AGENT_SERVER_FILES_S3_BUCKET` | S3 bucket name when `AGENT_SERVER_FILES_BACKEND=s3`. |
| `AGENT_SERVER_FILES_S3_PREFIX` | Optional S3 key prefix. |
| `AGENT_SERVER_FILES_S3_ACCESS_KEY` | S3 access key. |
| `AGENT_SERVER_FILES_S3_SECRET_KEY` | S3 secret key. |
| `AGENT_SERVER_FILES_S3_REGION` | S3 region. Defaults to `us-east-1`. |
| `AGENT_SERVER_FILES_S3_ENDPOINT_URL` | Optional S3-compatible endpoint URL. |
| `AGENT_SERVER_FILES_S3_VIRTUAL_HOST_STYLE` | Set to `true` for virtual-host-style S3 URLs. |
| `AGENT_SERVER_SECRET` | Secret used for signed auth tokens. Set this outside local dev. |
| `AGENT_SERVER_SETUP_TOKEN_TTL` | First-run setup token TTL in seconds. |
| `AGENT_SERVER_PUBLIC_ORIGIN` | Public Web origin used for OAuth redirect URLs when reverse-proxy headers or `returnTo` are unavailable. Example: `https://agents.example.com`. |
| `AGENT_SERVER_CORS_ORIGINS` | Comma-separated explicit CORS origins. |
| `AGENT_SERVER_CORS_ORIGIN_REGEX` | CORS origin regex. Defaults to local `localhost` / `127.0.0.1` ports. |
| `AGENT_SERVER_STATIC_DIR` | Built frontend directory. When set, `/` serves `index.html` and `/assets` serves static assets. |

## Main API Areas

All product API, SSE, and WebSocket endpoints are namespaced under `/api/v2`.

- `/api/v2/auth/*`: bootstrap, register, login, current user, avatar, password change.
- `/api/v2/admin/*`: instance settings, runtime schemas, user management, service info.
- `/api/v2/connectors/*`: connector lifecycle, preferences, runtime capabilities, file
  listing through connector RPC.
- `/api/v2/connector/*`: connector auth, ingest, file transfer, and WebSocket RPC.
- `/api/v2/pairing/*`: browser pairing flow for connector login/claim.
- `/api/v2/agents/*`: runtime modes, models, efforts, and config schemas.
- `/api/v2/sessions/*`: session lifecycle, runtime settings, events, takeover,
  messages, interrupt, sync, filesystem, shell, terminal, and uploads.
- `/api/v2/approvals/*`: approval resolution.

See `../docs/api-v2-migration.md` for Web and Connector migration notes.

## Web Frontend

The current Web console lives in `../web-next` and runs as a Next.js app. In
development, start the FastAPI server on `127.0.0.1:8000`, then start Next:

```bash
cd ../web-next
AGENTS_ANYWHERE_API=http://127.0.0.1:8000 yarn dev
```

For production, run the `web-next` Next server separately and set
`AGENTS_ANYWHERE_API` to the backend URL. Docker uses `http://server:8000`.

Legacy static serving is still available for old built frontends by setting
`AGENT_SERVER_STATIC_DIR`, but it is no longer the primary deployment path for
`web-next`.

```bash
AGENT_SERVER_STATIC_DIR=/path/to/legacy/dist \
  uv run uvicorn agent_server.app:create_app --factory --host 127.0.0.1 --port 8000
```

## Verify

```bash
uv run ruff check . --exclude .venv
uv run pytest -q
```
