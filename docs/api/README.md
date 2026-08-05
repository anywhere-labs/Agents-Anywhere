# API Documentation

Status: draft, API documentation home.

All Server HTTP, SSE, and WebSocket API documentation should live under this directory. Older API notes outside `docs/api/` should be moved here or marked deprecated when touched.

## Documents

- [API v2 namespace](./namespace.md): `/api/v2` namespace and client/connector URL rules.
- [Session API proposal](./session-api-proposal.md): authoritative target for the split `SessionMeta` / `SessionTimeline` / `RuntimeLive` client API.
- [Session API current gap](./session-api-current-gap.md): current backend implementation gaps against the target session API.
- [Session service architecture](./session-service-architecture.md): Server, Connector, Runtime, and Web ownership boundaries for session data and realtime updates.
- [Effective capability API](./capabilities.md): global and session-scoped effective capability semantics, paths, and realtime events.
- [Realtime API](./realtime.md): session, dashboard, connector, and terminal realtime channel semantics.
- [Frontend migration checklist](./frontend-migration-checklist.md): frontend API call-site replacements and behavior changes to apply after backend cleanup.

## Current API groups

All product endpoints are mounted under `/api/v2`.

### Stable or mostly unrelated to runtime protocol

```text
/auth/*
/oauth/*
/admin/*
/pairing/*
/connector/auth
/connector/ingest
/connector/ws
```

The connector channel endpoints are intentionally stable. Runtime protocol refactors should happen behind this channel, not by renaming these endpoints.

### Connector and runtime management

```text
/connectors
/connectors/{connectorId}
/connectors/{connectorId}/preferences
/connectors/{connectorId}/runtimes
/connectors/{connectorId}/runtimes/discover
/connectors/{connectorId}/runtimes/{runtimeId}/capabilities
/connectors/{connectorId}/runtimes/{runtimeId}/config
/connectors/{connectorId}/runtimes/{runtimeId}/active
/connectors/{connectorId}/runtimes/{runtimeId}/catalogs/model
/connectors/{connectorId}/runtimes/{runtimeId}/catalogs/permission
```

Runtime-scoped capability and catalog reads live under runtime resources. If a
specific connector must be selected, the connector is part of the path, not a
query parameter.

Generic runtime routes may exist only when the server can select the runtime
unambiguously:

```text
/runtimes/{runtimeId}/capabilities
/runtimes/{runtimeId}/catalogs/model
/runtimes/{runtimeId}/catalogs/permission
```

### Session API

Session API is the main area that needs redesign. The current target splits
durable Server facts from live Runtime facts:

```text
SessionMeta      -> durable Server DB
SessionTimeline  -> durable Server DB, written by Runtime updates
RuntimeLive      -> non-durable Runtime state/notices/catalogs/capabilities
```

See [Session API proposal](./session-api-proposal.md) and
[Session service architecture](./session-service-architecture.md).

### Realtime API

Realtime API is split by lifecycle:

```text
client dashboard lifecycle -> /dashboard/ws
client session lifecycle   -> /sessions/{sessionId}/ws and /sessions/{sessionId}/events
connector lifecycle        -> /connector/ws
terminal lifecycle         -> session/connector terminal streams
```

See [Realtime API](./realtime.md).

## Removed legacy API areas

The old legacy API list is intentionally removed from the target docs.
If a migration build still exposes those routes, they are compatibility shims
only and should forward to the scoped APIs documented here.

Migration guide:

- Agent catalog routes with `connectorId` query parameters move to connector
  runtime catalog paths.
- Connector protocol capability routes move to runtime-scoped or session-scoped
  effective capability paths.
- Session state routes move to `/sessions/{sessionId}/runtime/state`.
- Session selection routes move to `/sessions/{sessionId}/runtime/selections`.
- Session message and command routes move under
  `/sessions/{sessionId}/runtime/*`.
- Session read/archive bulk aliases move to `POST /sessions/read` and
  `POST /sessions/archive`. Read accepts a direct JSON array of session ids.
  Archive accepts `{ "ids": [...], "archived": true|false }`.
- `snapshot.catalogs` is not a primary catalog source.
- Server-persisted notices, catalogs, and capabilities are not runtime truth.
- Hardcoded session commands are removed; command lists come from runtime live
  reads.

`snapshot.catalogs` is now a compatibility shell and should be empty in the
target flow. Model and permission catalogs are read from live runtime catalog
endpoints when the selector is opened.

`POST /api/v2/sessions` is bind-only during the migration: callers must provide
an existing `externalSessionId` and pass selections through `selections`.
New user tasks must use
`POST /api/v2/sessions/create-and-start`.
