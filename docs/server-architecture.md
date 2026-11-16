# Server Architecture

The v2 Server uses explicit transport, service, domain, repository-port, and
infrastructure boundaries. The current refactor keeps behavior stable while
moving dependencies toward the domain.

## Layers

| Layer | Owns | May depend on |
| --- | --- | --- |
| `agent_server/core` | Domain values, API-neutral models, validation, auth primitives | Python and other `core` modules |
| `agent_server/services` | Use-case orchestration, application errors, repository and RPC ports | `core`, declared ports, and transitional runtime adapters |
| `agent_server/infra` | PostgreSQL repositories, Redis coordination, files, WebSocket RPC, brokers | `core`, service ports |
| `agent_server/api` | FastAPI routes, authentication dependencies, HTTP/WebSocket error mapping | `core`, services, infra composition |
| `agent_server/app.py` | Process composition and lifecycle | all layers |

`core` must not import an outer layer. Services must not import FastAPI, API
modules, or the concrete `Store` facade. These rules are enforced by
`tests/test_architecture_boundaries.py`.

## State Ownership

| State | Owner | Persistence |
| --- | --- | --- |
| Users, connectors, the session directory (titles, status, read marks), catalogs, runtime config, command receipts | PostgreSQL | Durable, Alembic-versioned |
| Session content: timeline, plans, goals, queued messages | The device (v3 Connector) | Read through the device link; the Server stores none of it (from `v2_60`) |
| Current runtime notices and interaction/approval status | Runtime | Read live via Connector RPC and relayed as events; not persisted as current state in Server PostgreSQL |
| Connector ownership lease, cross-instance RPC routing, invalidation Pub/Sub, distributed locks, short-lived tickets and transfer coordination | Redis | Reconstructible coordination state, finite TTL where retained |
| Local WebSockets, pending RPC futures, send locks, listener tasks | Server process | Process lifetime only |
| Attachments staged until the device fetches them, and files a share exposes | Configured file backend | Durable according to backend policy |

Approval operations can still produce logs. The Codex adapter logs approval
response attempts, failures, and completion; log retention depends on how the
Connector is launched. These operational logs are distinct from the Runtime's authoritative current approval state.

Connector online status is derived from the live presence port. SQL records
durable connector metadata such as `last_seen_at` and `device_os`, but it is not
the source of truth for current instance ownership. Coordination state remains
reconstructible from active connections after restart.

Session content lives on the device. A v3 Connector answers reads through the
device link and streams changes while someone watches; the Server forwards them
without storing them. The Server keeps only directory facts the device reports
(status, the newest item's type and time, `headSeq`, `latestTurnEndSeq`) and
`seq_ceiling`, the highest sequence it forwarded, so a device that lost its
database restarts its clock above anything a client has seen. The upgrade to
`v2_60` deletes the content v2 stored (see below).

## Connector Flow

1. The Connector authenticates against durable credentials in PostgreSQL.
2. The accepting Server instance claims the Connector lease through the RPC
   manager. Redis rejects a second live owner in distributed deployments.
3. SQL records connection metadata without storing the lease owner.
4. Requests targeting another instance are routed through Redis Pub/Sub to the
   lease owner.
5. Heartbeats refresh the lease. Disconnect or timeout releases it.
6. API responses merge durable Connector data with live presence status.

## Database Versions

Alembic revisions use product schema versions (`v2_0`, `v2_1`, `v2_2`, `v2_3`,
`v2_4`, and so on), independent of package SemVer. Every schema change adds one revision.
Alembic applies all intermediate revisions in order, so a database may upgrade
across multiple versions in one command.

Runtime startup requires the database to already be at the exact current
revision. Only the explicit migration command mutates schema. Revision `v2_3`
removes the archived v1 columns and the transitional Approval table after
Interaction notices become authoritative.

### v2.24 writer compatibility

The `v2.24` revision-clock model is not writer-compatible with `v2.23` or older. A rollout
must stop all old Server and external writer processes, migrate the database,
and then start only `v2.24` writers. The migration advisory lock coordinates
concurrent migrators; it is not an application-write fence and does not make a
rolling mixed-version deployment safe.

On PostgreSQL, the migration changes the relevant sequence columns from `int4`
to `int8`. The type alterations can require strong locks and, depending on the
PostgreSQL version and physical table/index layout, storage rewrites. A
production rollout must be rehearsed on representative data with lock duration,
runtime, and free-space impact measured before choosing the maintenance window.

Downgrade is an offline operation: all writers must remain stopped while its
preconditions are evaluated and the schema changes run. It refuses if any
session has an allocated range ahead of its durable sequence
(`seq_allocated_high <> seq`) or if a value cannot fit signed 32-bit storage.
Because an ordinary `v2.24` allocation lease can make the first condition true
before the whole range is consumed, downgrade will commonly be unavailable once
new writers have handled Timeline traffic.

### v2.60: the Server stops holding session content

`v2_60` drops the timeline, planning, goal and message queue tables and clears
the run parameters that could hold message text. It cannot be downgraded; back
up the database first. Read marks become positions on the device's turn clock:
the migration leaves `-1` ("read") or `-2` ("unread") on each session, and the
device's first `latestTurnEndSeq` turns the sentinel into a real position.
Stored attachments are deleted by the Server in the background after it starts
(the migration sets `instance_settings.v3_attachment_purge = pending`); files
that a share exposes are kept.
