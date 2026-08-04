# API Documentation

Status: draft, API documentation home.

All Server HTTP, SSE, and WebSocket API documentation should live under this directory. Older API notes outside `docs/api/` should be moved here or marked deprecated when touched.

## Documents

- [API v2 namespace](./namespace.md): `/api/v2` namespace and client/connector URL rules.
- [Session API proposal](./session-api-proposal.md): authoritative target for the split `SessionMeta` / `SessionTimeline` / `RuntimeLive` client API.
- [Session service architecture](./session-service-architecture.md): Server, Connector, Runtime, and Web ownership boundaries for session data and realtime updates.
- [Realtime API](./realtime.md): session, dashboard, connector, and terminal realtime channel semantics.

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
/connectors/{connectorId}/protocol/capabilities
/connectors/{connectorId}/runtimes
/connectors/{connectorId}/runtimes/discover
/connectors/{connectorId}/runtimes/{runtimeId}/config
/connectors/{connectorId}/runtimes/{runtimeId}/active
```

Target runtime catalog reads should live under connector runtime resources:

```text
/connectors/{connectorId}/runtimes/{runtimeId}/catalogs/models
/connectors/{connectorId}/runtimes/{runtimeId}/catalogs/permissions
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

## Deprecated or transitional API areas

These routes are migration/deprecation areas. They may exist while data and
callers are moved, but they are not the target design for new work:

```text
GET  /api/v2/agents/{runtime}/model-catalog
GET  /api/v2/agents/{runtime}/permission-catalog
GET  /api/v2/sessions/events/dashboard
POST /api/v2/sessions
GET  /api/v2/sessions/{sessionId}/state with timeline query params
GET  /api/v2/sessions/{sessionId}/runtime-state
POST /api/v2/sessions/{sessionId}/sync
POST /api/v2/sessions/{sessionId}/interactions/{noticeId}/respond
message/create modelSelectionId and permissionSelectionId fields
snapshot.catalogs as a primary catalog source
server-persisted notices as runtime notice truth
server-persisted protocol catalogs/capabilities as runtime truth
hardcoded session commands
```

`snapshot.catalogs` is now a compatibility shell and should be empty in the
target flow. Model and permission catalogs are read from live runtime catalog
endpoints when the selector is opened.

`POST /api/v2/sessions` is bind-only during the migration: callers must provide
an existing `externalSessionId` and pass selections through `selections`.
New user tasks must use
`POST /api/v2/sessions/create-and-start`.
