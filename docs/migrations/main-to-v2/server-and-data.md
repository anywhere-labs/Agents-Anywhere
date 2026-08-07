# Server and Data Migration

This document covers the Server contract and durable-state migration from
`main` to v2.

## State ownership

v2 separates durable product state from live runtime facts:

| State | Owner | Storage |
| --- | --- | --- |
| Users, connectors, session metadata, timeline, file metadata, import archive | Server | PostgreSQL |
| Runtime state, selections, notices, catalogs, effective runtime capabilities | Active runtime, projected through Connector | Live reads and pushes; not authoritative database state |
| Connector presence, routed RPC, invalidations, WebSocket tickets, locks | Server coordination layer | Redis with finite lifetimes |
| Connector runtime process, sync cursors, local credentials | Connector | Local process and atomic JSON files |

Redis is disposable coordination state. Do not enable Redis persistence as a
substitute for PostgreSQL backups.

## Environment changes

| `main` setting | v2 setting | Notes |
| --- | --- | --- |
| `AGENT_SERVER_DB=/path/agent-server.sqlite3` | `AGENT_SERVER_DB_URL=postgresql+asyncpg://...` | The v2 runtime rejects SQLite. |
| none | `AGENT_SERVER_DB_BACKEND=postgres` | Optional assertion used by the Docker images. |
| none | `AGENT_SERVER_REDIS_URL=redis://...` | Required for distributed production coordination. |
| process-local defaults | `AGENT_SERVER_INSTANCE_ID` and Redis prefix/timeouts | Use a unique instance id when explicitly configured. |
| local file directory beside SQLite | `AGENT_SERVER_FILES_BACKEND=local|s3` plus backend settings | Migrate the file payloads separately from database rows. |

The Server origin remains the configured public origin. Clients must not put
`/api/v2` into `AGENTS_ANYWHERE_API`, `NEXT_PUBLIC_AGENTS_ANYWHERE_API`, or
Connector `serverUrl`; URL helpers append the namespace.

## Database revision chain

The current Server requires exact Alembic revision `v2_7` and reports product
schema version `2.7`.

| Revision | Migration purpose |
| --- | --- |
| `v1_legacy` | Fingerprint and stamp the last supported unversioned v1 layout. |
| `v2_0` | Create the strict v2 schema, migrate device runtimes, add selection columns, and map `waiting_approval`/`error` sessions to `blocked`. |
| `v2_1` | Add Server-instance and connection fencing fields for Connector presence. |
| `v2_2` | Migrate runtime settings and selections, and archive legacy rows in `legacy_import_archive`. |
| `v2_3` | Remove approvals and legacy catalog/settings tables after archiving and conversion. |
| `v2_4` | Widen protocol capability and catalog revisions to PostgreSQL `BIGINT`. |
| `v2_5` | Introduce an intermediate durable `session_states` projection. |
| `v2_6` | Remove `session_states`; runtime state and selections become live runtime facts. |
| `v2_7` | Remove persisted notices; runtime notices become live runtime facts. |

The v2.3, v2.6, and v2.7 transitions are intentionally forward-only. Do not
plan a database downgrade as the rollback mechanism.

## Importing the v1 SQLite database

The import tool opens the original SQLite file read-only, copies it through the
SQLite backup API, upgrades only the copy, creates/upgrades the target
PostgreSQL schema, imports in one transaction, and compares row counts and
SHA-256 digests table by table.

### Rehearsal

Create an empty disposable PostgreSQL database, then run from `server/`:

```bash
uv run python -m agent_server.infra.db.migrations rehearse-v1 \
  --source-sqlite /backup/agent-server.sqlite3 \
  --target-url postgresql+asyncpg://agents:password@db/agents_rehearsal \
  --report migration-report.json
```

The target must contain no product rows. Keep the report with the release
artifacts and investigate every failure before scheduling cutover.

### Final import

After stopping all v1 writers, run the same verified command against a newly
created, empty production target and save a separate report:

```bash
uv run python -m agent_server.infra.db.migrations rehearse-v1 \
  --source-sqlite /backup/final-agent-server.sqlite3 \
  --target-url postgresql+asyncpg://agents:password@db/agents_production \
  --report final-migration-report.json
```

Despite the command name, this operation writes the target database. Never aim
it at a populated database.

For a new empty v2 installation, skip the legacy import and run:

```bash
AGENT_SERVER_DB_URL=postgresql+asyncpg://agents:password@db/agents_production \
  uv run python -m agent_server.infra.db.migrations upgrade
```

Verify before Server startup:

```bash
AGENT_SERVER_DB_URL=postgresql+asyncpg://agents:password@db/agents_production \
  uv run python -m agent_server.infra.db.migrations current --verbose
```

Expected output includes `schemaVersion=2.7 revision=v2_7`.

## API namespace

All product HTTP, SSE, and WebSocket endpoints move under `/api/v2`:

| `main` | v2 |
| --- | --- |
| `/health` | `/api/v2/health` |
| `/auth/*` | `/api/v2/auth/*` |
| `/oauth/*` | `/api/v2/oauth/*` |
| `/connectors/*` | `/api/v2/connectors/*` |
| `/connector/*` | `/api/v2/connector/*` |
| `/pairing/*` | `/api/v2/pairing/*` |
| `/sessions/*` | `/api/v2/sessions/*` |

Use the shared namespace helpers described in
[API namespace](../../api/namespace.md). Do not concatenate `/api/v2` at every
call site.

## Session API migration

The combined `main` session API is split by ownership. Important replacements
are:

| `main` route | v2 route |
| --- | --- |
| `PATCH /sessions/{id}` | `PATCH /api/v2/sessions/{id}/meta` |
| `POST /sessions/{id}/read` | `POST /api/v2/sessions/read` with a direct id array |
| `POST /sessions/bulk-archive` | `POST /api/v2/sessions/archive` or `/unarchive` with a direct id array |
| `GET /sessions/{id}/state` | `/api/v2/sessions/{id}/meta`, `/timeline`, `/runtime/state`, or `/snapshot` according to ownership |
| `GET/PATCH /sessions/{id}/runtime-settings` | Runtime config routes plus `/api/v2/sessions/{id}/runtime/selections` |
| `POST /sessions/{id}/messages` | `POST /api/v2/sessions/{id}/runtime/messages` |
| `POST /sessions/{id}/interrupt` | `POST /api/v2/sessions/{id}/runtime/interrupt` |
| `POST /approvals/{id}/resolve` | `POST /api/v2/sessions/{id}/runtime/notices/{noticeId}/respond` |
| Frontend-built commands | `GET/POST /api/v2/sessions/{id}/runtime/commands` |
| New blank session plus first message | `POST /api/v2/sessions/create-and-start` |

Message payloads carry content, attachments, and `clientMessageId`. They do not
carry one-off model or permission fields. Selection changes go through
`PATCH /runtime/selections` before an existing-session send. The runtime is the
final validator.

See [Session API current gap](../../api/session-api-current-gap.md) for the full
route inventory and [Clients](./clients.md) for client behavior.

## Startup and readiness

The v2 Server does not mutate production schema during normal startup. Start a
dedicated migrator first, then Server. Readiness must return HTTP 200:

```bash
curl --fail http://127.0.0.1:8000/api/v2/health/ready
```

Confirm:

- database status is `ok` with schema version `2.7`;
- Redis status is `ok` in the distributed deployment;
- the Server instance id is present;
- a stale or unversioned database produces 503 rather than serving traffic.

Also migrate the file-storage payloads and verify attachment downloads. The
database import migrates metadata, not external/local file bytes.
