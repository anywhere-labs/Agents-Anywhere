# Realtime API

Status: proposal and current-behavior map.

Agents Anywhere uses realtime channels for three different lifecycles:

- session detail updates;
- dashboard connector/session list updates;
- connector RPC/ingest presence;
- terminal streams.

Connector channel endpoint names stay stable. Session and dashboard realtime
semantics should be tightened around the new session model:

```text
SessionMeta and SessionTimeline are durable Server facts.
Runtime state, notices, catalogs, capabilities, commands, and selections are
non-durable RuntimeLive facts.
```

## Session realtime

Primary realtime channel:

```text
WS /api/v2/sessions/{sessionId}/ws?ticket=...
```

Recovery endpoint:

```text
GET /api/v2/sessions/{sessionId}/events?after=seq:123
```

Ticket endpoint:

```text
POST /api/v2/ws-ticket
```

### Intended lifecycle

```text
GET /sessions/{sessionId}/snapshot
  -> reads durable meta/timeline from Server and RuntimeLive facts from runtime RPC
  -> receive durable eventCursor
POST /ws-ticket
  -> session scope ticket
WS /sessions/{sessionId}/ws?ticket=...
  -> receive session.subscribed
  -> receive incremental events
GET /sessions/{sessionId}/events?after=seq:...
  -> only for reconnect/cursor recovery
```

`/events` is not snapshot polling. It is a cursor recovery API. If WebSocket is healthy, the client should not call `/events` on a fixed interval.

### Target event types

```text
session.subscribed
session.meta.updated
timeline.item_created
timeline.item_updated
timeline.snapshot
runtime.state.updated
runtime.notice.snapshot
runtime.notice.updated
runtime.capability.updated
runtime.catalog.updated
runtime.refetch_required
session.refetch_required
```

Current event types such as `session.status_changed`, `notice.created`,
`notice.updated`, `notice.snapshot`, and embedded `effectiveCapabilities`
payloads are compatibility shapes. They should migrate to the `runtime.*`
namespace for live Runtime facts.

### Recovery rules

- Event cursor format is `seq:{number}`.
- Timeline items are upsert-only.
- A sequence gap does not automatically require snapshot.
- Server returns `snapshotRequired=true` only when durable meta/timeline
  recovery is explicitly impossible.
- Client pulls snapshot only for initial load or `snapshotRequired=true`.
- Runtime state and catalogs are not recovered from Server DB. After reconnect,
  Web calls the relevant runtime live endpoint if it needs current state or
  catalogs.
- Runtime notice and capability updates are recovered when Server has a
  sequence-backed projection for them. Web may still refresh the corresponding
  runtime live endpoint after reconnect when it needs the latest exact fact.
- `runtime.capability.updated` carries effective capabilities. On a session
  WebSocket, it is session-scoped and controls current session actions. On a
  dashboard/runtime WebSocket, it is runtime-scoped and controls setup,
  create-session, catalog, and feature entry points.
- Web should not derive action availability from `runtime.state.updated` when a
  matching effective capability exists.

## Dashboard realtime

Primary realtime channel:

```text
WS /api/v2/dashboard/ws?ticket=...
```

Legacy SSE during migration:

```text
GET /api/v2/sessions/events/dashboard?token=...
```

The Web client should prefer dashboard WebSocket and stop fixed-interval polling of:

```text
GET /api/v2/connectors
GET /api/v2/sessions
```

### Current dashboard behavior

The current dashboard WebSocket sends:

```text
dashboard.snapshot
```

on connect, and sends another full snapshot when a debounced `dashboard.changed` invalidation arrives.

This is acceptable as a near-term replacement for polling. If full snapshots become too heavy, the next step is delta events:

```text
connector.created
connector.updated
connector.deleted
connector.presence.updated
runtime.updated
session.created
session.meta.updated
session.state.updated
session.archived
```

Do not implement delta dashboard events until the snapshot WebSocket path is stable.

## Connector realtime

Stable connector channel:

```text
WS /api/v2/connector/ws
```

Stable connector HTTP endpoints:

```text
POST /api/v2/connector/auth
POST /api/v2/connector/ingest
```

These endpoint names should not change as part of the runtime protocol refactor.

### Connector runtime RPC methods

The runtime protocol refactor evolves payload semantics behind
`WS /api/v2/connector/ws`. Runtime configuration is provider-managed and
read-only once a runtime instance is running:

```text
runtime.discover
runtime.configSchema
runtime.config
runtime.validateConfig
runtime.start
runtime.stop
runtime.modelCatalog
runtime.permissionCatalog
session.discover
session.create
session.sync
session.state
session.selections.update
session.commands
session.command.execute
interaction.respond
turn.start
turn.steer
turn.interrupt
```

`runtime.configSchema` performs a live provider read for UI/CLI configuration
forms. `runtime.config` returns saved raw values when the runtime is stopped,
and the running runtime's read-only effective `RuntimeConfig` projection when
it is running. Config mutation still flows through `runtime.validateConfig` and
`runtime.start`; running `AgentRuntime` instances do not accept direct config
updates.

`runtime.discover` includes runtime-native capability inputs. They are not the
primary frontend contract. The frontend contract is effective capability:

```text
GET /connectors/{connectorId}/runtimes/{runtime}/capabilities
GET /sessions/{sessionId}/runtime/capabilities
runtime.capability.updated
```

The Server may apply authorization, takeover, connector reachability, and
feature policy. It must not infer runtime-owned action availability from
durable session data.

Runtime host live events are sent as connector WebSocket notifications on
`WS /api/v2/connector/ws`. `POST /api/v2/connector/ingest` is reserved for
explicit bulk sync and disconnected WebSocket fallback; it must still compute
changed timeline items and publish session WebSocket events for frontend
convergence.

The target semantic connector notification methods are:

```text
session.meta.upsert
timeline.sync
timeline.itemUpsert
runtime.state.updated
runtime.notice.snapshot
runtime.notice.updated
runtime.capability.updated
runtime.catalog.updated
runtime.error
```

Compatibility connector notification names may remain during migration:

```text
session.state.updated
notice.upsert
protocol.capabilitiesUpdated
```

The Server should translate compatibility names into RuntimeLive events without
treating them as durable session truth.

The connector application layer bridges `RuntimeHostClient` calls to these
server-facing notification payloads. Runtime adapters should never call
connector HTTP/WS transports directly.

## Terminal realtime

Current terminal channels include:

```text
WS /api/v2/sessions/{sessionId}/terminals/{terminalId}/stream
WS /api/v2/connectors/{connectorId}/terminals/{terminalId}/stream
WS /api/v2/connectors/{connectorId}/terminals-v2/{terminalId}/stream
WS /api/v2/connector/terminals/{terminalId}/relay
```

Terminal APIs are local capability APIs, not Agent Runtime Protocol session APIs. They can be cleaned up later as a separate local-capabilities interface pass.

Do not block the runtime protocol migration on terminal endpoint consolidation.
