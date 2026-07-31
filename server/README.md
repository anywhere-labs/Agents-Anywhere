# Agent Server

FastAPI backend for Agents Anywhere. The server owns authentication, users,
connectors, sessions, timeline and Interaction state, file metadata, terminal
brokering, and connector RPC dispatch.

## Layout

```text
agent_server/
  api/          FastAPI HTTP/WebSocket transport and error mapping
  core/         API-neutral domain values, models, and validation
  infra/        PostgreSQL/Redis/file adapters and runtime brokers
  services/     Use cases, application errors, and dependency ports
  app.py        FastAPI app factory and local uvicorn entry helper
tests/          Backend tests
pyproject.toml  Server dependencies
run.sh          Local helper for PostgreSQL-backed development
```

## Run

Install dependencies:

```bash
uv sync
```

PostgreSQL is the v2 runtime database. Start the backend from this directory
after provisioning PostgreSQL and Redis:

```bash
AGENT_SERVER_DB_URL=postgresql+asyncpg://agents:password@127.0.0.1:5432/agents_anywhere \
  uv run python -m agent_server.infra.db.migrations upgrade

AGENT_SERVER_DB_URL=postgresql+asyncpg://agents:password@127.0.0.1:5432/agents_anywhere \
AGENT_SERVER_REDIS_URL=redis://127.0.0.1:6379/0 \
  uv run uvicorn agent_server.app:create_app --factory --host 127.0.0.1 --port 8000
```

SQLite is not a supported Server runtime backend. It is retained only as a
read-only source format for the one-time legacy v1 import tool and in isolated
migration tests.

The Server requires the database to be at its exact Alembic schema revision and
does not mutate a production database during startup. `upgrade` fingerprints an
unversioned v1 database, archives required legacy data, and applies every revision
through the current schema (`v2_3`). Inspect the installed revision with:

```bash
uv run python -m agent_server.infra.db.migrations current --verbose
```

Rehearse a v1 SQLite migration against a disposable, empty PostgreSQL database:

```bash
uv run python -m agent_server.infra.db.migrations rehearse-v1 \
  --source-sqlite /path/to/v1.sqlite3 \
  --target-url postgresql+asyncpg://agents:password@127.0.0.1:5432/agents_rehearsal \
  --report migration-report.json
```

The source is opened read-only and copied with SQLite's backup API. Only the
copy is upgraded. The PostgreSQL target must contain no product rows; the tool
imports in one transaction and verifies every table by row count and SHA-256.
Legacy-only rows and legacy JSON columns are retained in
`legacy_import_archive`; their superseded source tables and columns are removed
by `v2_3`.

The first startup on an empty database logs a bootstrap token. Use that token in
the web UI to create the first admin user.

Health check:

```bash
curl http://127.0.0.1:8000/api/v2/health
curl http://127.0.0.1:8000/api/v2/health/ready
```

## Environment

| Variable | Purpose |
| --- | --- |
| `AGENT_SERVER_DB_URL` | Required PostgreSQL SQLAlchemy URL using the `postgresql+asyncpg` scheme. |
| `AGENT_SERVER_DB_BACKEND` | Optional backend assertion. When set for runtime use, it must be `postgres`. |
| `AGENT_SERVER_DB_POOL_SIZE` | PostgreSQL base connection pool size. Defaults to `10`. |
| `AGENT_SERVER_DB_MAX_OVERFLOW` | PostgreSQL overflow connections per instance. Defaults to `20`. |
| `AGENT_SERVER_DB_POOL_TIMEOUT` | Seconds to wait for a PostgreSQL pool checkout. Defaults to `30`. |
| `AGENT_SERVER_DB_POOL_RECYCLE` | PostgreSQL connection recycle interval in seconds. Defaults to `1800`. |
| `AGENT_SERVER_MIGRATION_LOCK_TIMEOUT` | Seconds a migrator waits for the PostgreSQL advisory lock. Defaults to `120`. |
| `AGENT_SERVER_REDIS_URL` | Redis URL for production/distributed Connector presence, RPC routing, invalidations, single-use WebSocket tickets, and distributed locks. When unset, only the single-process development fallback is available. |
| `AGENT_SERVER_REDIS_PREFIX` | Redis key/channel prefix. Defaults to `agents-anywhere`. |
| `AGENT_SERVER_REDIS_CONNECT_TIMEOUT` | Redis connection timeout in seconds. Defaults to `5`. |
| `AGENT_SERVER_REDIS_HEALTH_CHECK_INTERVAL` | Redis connection health-check interval in seconds. Defaults to `30`. |
| `AGENT_SERVER_INSTANCE_ID` | Optional unique Server instance ID used for Connector RPC routing. A random ID is generated when unset. |
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

Redis is an ephemeral coordination layer, not a source of truth. Session events
remain in the database; Redis Pub/Sub only tells instances to re-fetch them.
The Compose Redis service disables both RDB snapshots and AOF persistence.
It also caps memory at `REDIS_MAXMEMORY` (default `256mb`) and uses
`volatile-lru`; all coordination keys that retain data have finite TTLs.

See `../docs/server-architecture.md` for layer boundaries, state ownership, and
database versioning rules.

## Main API Areas

All product API, SSE, and WebSocket endpoints are namespaced under `/api/v2`.

- `/api/v2/auth/*`: bootstrap, register, login, current user, avatar, password change.
- `/api/v2/admin/*`: instance settings, runtime schemas, user management, service info.
- `/api/v2/connectors/*`: connector lifecycle, preferences, runtime capabilities, file
  listing through connector RPC.
- `/api/v2/connector/*`: connector auth, ingest, file transfer, and WebSocket RPC.
- `/api/v2/pairing/*`: browser pairing flow for connector login/claim.
- `/api/v2/agents/*`: runtime model catalogs, permission catalogs, and config schemas.
- `/api/v2/sessions/*`: session lifecycle, runtime settings, events, takeover,
  messages, interaction responses, interrupt, sync, filesystem, shell, terminal,
  and uploads.

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
