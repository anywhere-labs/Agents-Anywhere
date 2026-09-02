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
| Users, connectors, sessions, notices/interactions, timeline, catalogs, runtime config | PostgreSQL | Durable, Alembic-versioned |
| Connector ownership lease, cross-instance RPC routing, invalidation Pub/Sub, distributed locks, short-lived tickets and transfer coordination | Redis | Reconstructible coordination state, finite TTL where retained |
| Accepted-but-unflushed Timeline upserts and live Timeline sequence head | Redis | Operationally persistent with AOF `everysec`, persistent `/data`, and no eviction; no TTL |
| Local WebSockets, pending RPC futures, send locks, listener tasks | Server process | Process lifetime only |
| Attachments and uploaded files | Configured file backend | Durable according to backend policy |

Connector online status is derived from the live presence port. SQL records
durable connector metadata such as `last_seen_at` and `device_os`, but it is not
the source of truth for current instance ownership. Coordination state remains
reconstructible from active connections after restart.

PostgreSQL becomes the durable source of truth for a Timeline upsert when the
write buffer flushes it. Until then, distributed Server instances retain the
accepted upsert and live sequence head in Redis. Redis sequence values come from
revision ranges leased durably from PostgreSQL; Redis loss can therefore abandon
unused values but cannot cause sequence reuse. Compose enables AOF with
`appendfsync everysec`, persists `/data`, and sets `noeviction` because these
pending/sequencer keys have no TTL. This is an operational durability window,
not a second authoritative Timeline database: failure before the latest AOF sync
can lose an unflushed upsert, while consistency-sensitive/manual reads fence and
flush pending writes to PostgreSQL first. The lease size defaults to `4096` and
is configurable with `AGENT_SERVER_TIMELINE_REVISION_LEASE_SIZE`.

This design has two distinct loss windows. In a distributed deployment, AOF
`everysec` can lose the newest commands that Redis has acknowledged but has not
yet fsynced. In the no-Redis single-process fallback, accepted-but-unflushed
Timeline payloads exist only in process memory, so a process crash loses all
payloads since the last flush (normally up to the configured flush interval).
The PostgreSQL allocation high watermark prevents either failure from reusing a
revision, but it cannot reconstruct payloads lost before their database flush;
the local fallback is therefore a development mode, not a durable HA design.

The Redis security and capacity boundary includes `INFO server`: the Server ACL
must allow that command so the sequencer can read `run_id` and detect a Redis
restart or failover. In the current implementation every Timeline upsert reads
`run_id`, and an accepted change rechecks it after revision allocation. Redis
ACL validation and expected `INFO` command throughput are consequently rollout
requirements for high-frequency ingestion.

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

### v2.23 writer compatibility

The `v2.23` revision-clock model is not writer-compatible with `v2.22`. A rollout
must stop all old Server and external writer processes, migrate the database,
and then start only `v2.23` writers. The migration advisory lock coordinates
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
Because an ordinary `v2.23` allocation lease can make the first condition true
before the whole range is consumed, downgrade will commonly be unavailable once
new writers have handled Timeline traffic.
