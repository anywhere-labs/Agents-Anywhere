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
curl http://127.0.0.1:8000/health
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
| `AGENT_SERVER_CORS_ORIGINS` | Comma-separated explicit CORS origins. |
| `AGENT_SERVER_CORS_ORIGIN_REGEX` | CORS origin regex. Defaults to local `localhost` / `127.0.0.1` ports. |
| `AGENT_SERVER_STATIC_DIR` | Built frontend directory. When set, `/` serves `index.html` and `/assets` serves static assets. |

## Main API Areas

- `/auth/*`: bootstrap, register, login, current user, avatar, password change.
- `/admin/*`: instance settings, runtime schemas, user management, service info.
- `/connectors/*`: connector lifecycle, preferences, runtime capabilities, file
  listing through connector RPC.
- `/connector/*`: connector auth, ingest, file transfer, and WebSocket RPC.
- `/pairing/*`: browser pairing flow for connector login/claim.
- `/agents/*`: runtime modes, models, efforts, and config schemas.
- `/sessions/*`: session lifecycle, runtime settings, events, takeover,
  messages, interrupt, sync, filesystem, shell, terminal, and uploads.
- `/approvals/*`: approval resolution.

## Static Frontend Serving

For production-style serving, build the frontend and point the server at the
build output:

```bash
cd ../web
yarn build

cd ../server
AGENT_SERVER_STATIC_DIR=../web/dist \
  uv run uvicorn agent_server.app:create_app --factory --host 127.0.0.1 --port 8000
```

## Verify

```bash
uv run ruff check . --exclude .venv
uv run pytest -q
```
