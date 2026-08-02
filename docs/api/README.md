# API Documentation

Status: draft, API documentation home.

All Server HTTP, SSE, and WebSocket API documentation should live under this directory. Older API notes outside `docs/api/` should be moved here or marked deprecated when touched.

## Documents

- [API v2 namespace](./namespace.md): `/api/v2` namespace and client/connector URL rules.
- [Session API proposal](./session-api-proposal.md): proposed client-facing session API redesign for Agent Runtime Protocol v1.
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

Session API is the main area that needs redesign. See [Session API proposal](./session-api-proposal.md).

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
POST /api/v2/sessions/{sessionId}/sync
POST /api/v2/sessions/{sessionId}/interactions/{noticeId}/respond
message/create modelSelectionId and permissionSelectionId fields
snapshot.catalogs
hardcoded session commands
```
