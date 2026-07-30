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
| Connector ownership lease, cross-instance RPC routing, invalidation Pub/Sub, distributed locks, short-lived tickets and transfer coordination | Redis | Ephemeral, finite TTL where retained |
| Local WebSockets, pending RPC futures, send locks, listener tasks | Server process | Process lifetime only |
| Attachments and uploaded files | Configured file backend | Durable according to backend policy |

Connector online status is derived from the live presence port. SQL records
durable connector metadata such as `last_seen_at` and `device_os`, but it is not
the source of truth for current instance ownership. Redis persistence is
disabled because coordination state must be rebuilt from active connections
after restart.

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

Alembic revisions use product schema versions (`v2_0`, `v2_1`, `v2_2`, `v2_3`, and so
on), independent of package SemVer. Every schema change adds one revision.
Alembic applies all intermediate revisions in order, so a database may upgrade
across multiple versions in one command.

Runtime startup requires the database to already be at the exact current
revision. Only the explicit migration command mutates schema. Revision `v2_3`
removes the archived v1 columns and the transitional Approval table after
Interaction notices become authoritative.
