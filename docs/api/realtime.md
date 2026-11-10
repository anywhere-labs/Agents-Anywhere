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
  -> post-subscription cursor reconciliation and reconnect recovery
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

Removed compatibility event types:

- `session.status_changed`
- `notice.created`
- `notice.updated`
- `notice.snapshot`
- embedded `effectiveCapabilities` aliases in session realtime events

Use `runtime.state.updated`, `runtime.capability.updated`,
`runtime.notice.updated`, and `runtime.notice.snapshot` for live Runtime facts.

### Recovery rules

- Event cursor format is `seq:{number}`.
- Timeline items are upsert-only.
- A sequence gap does not automatically require snapshot.
- Server returns `snapshotRequired=true` only when durable meta/timeline
  recovery is explicitly impossible.
- Client pulls snapshot only for initial load or `snapshotRequired=true`.
- Runtime state and catalogs are not recovered from Server DB. After the
  initial session subscription and reconnect, Web and Desktop read
  `GET /sessions/{sessionId}/runtime/state` after successful event recovery.
  This read also runs when the connector is offline, using the endpoint's
  cached/persisted fallback. Older runtime-state revisions are ignored; events
  received before the live read participate in its version check, while events
  received during the read are applied afterwards. Failed live reads retain
  the existing state and buffered events. Catalogs use their runtime live
  endpoints when needed.
- Runtime notices are recovered when Server has a sequence-backed projection.
  Session meta and the latest persisted effective capability projection are
  also returned when recovery starts at the current cursor, because presence
  and capabilities can change without advancing the durable session sequence.
  When the connector is online, Web reads the live session capability endpoint
  after recovery and keeps that Runtime result authoritative.
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

Removed legacy SSE:

```text
GET /api/v2/sessions/events/dashboard?token=...
```

Do not add new clients for this route. Dashboard lifecycle updates use
`/dashboard/ws`.

The Web client should prefer dashboard WebSocket and stop fixed-interval polling of:

```text
GET /api/v2/connectors
GET /api/v2/projects
GET /api/v2/sessions/list
```

### Current dashboard behavior

The current dashboard WebSocket sends:

```text
dashboard.snapshot
```

on connect, and sends another full snapshot when a `dashboard.changed` invalidation arrives.

Invalidations are throttled per user on each Server worker. The first change after a
quiet period is delivered at once; further changes within
`AGENT_SERVER_DASHBOARD_MIN_INTERVAL_SECONDS` (default 2 seconds) collapse into one
trailing delivery, and every Dashboard socket of that user on the worker shares one
snapshot build. A client therefore sees the latest state at most one interval late
and never misses the final change of a burst.

The snapshot also carries the owned runtime instances (`runtimes`) and the model
configuration overview (`modelConfig`: profiles, where they are applied and the
Tokens Anywhere link). Neither contains API keys or tokens; see
[Model configuration API](./model-config.md).

Each snapshot contains the complete owned project and session metadata inventories,
including both active and archived sessions. `sessionPages` reports no more pages.
Web and iOS group, filter and sort these sessions locally. Expanding a project,
switching a device filter or opening archives does not fetch another session list.
An explicit HTTP refresh reads `/projects` and `/sessions/list` once each, alongside
the connector list; it does not issue a request for every project or archive state.

Building the session inventory does not read the timeline. Each timeline write
stores a summary of the session's newest timeline item (its order, `orderSeq` and
display time) on the session in the same transaction, and the snapshot reads only
session rows. `lastItemAt`, `lastItemOrderSeq` and `sortAt` keep their meaning.

Project mutations refresh the shared project list. A session with an unknown or
missing project binding also triggers a shared project refresh and remains visible
under ungrouped sessions. Clients coalesce concurrent project reads and remember
unresolved bindings, so every message on an unassigned session does not cause a new
request. A failed read can retry after a later update. Newer push or mutation data
takes precedence over an earlier HTTP read.

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

`interaction.respond` also answers Runtime questionnaires projected as
`input_request` notices. Codex synchronous questions reply to the pending
app-server request. Codex asynchronous questions use the same Notice/Form
contract, while Connector converts the submitted answers into the native
question-reply message and sends it to the active turn or starts a new turn.
No separate client endpoint is required.

`runtime.configSchema` performs a live provider read for UI/CLI configuration
forms. `runtime.config` returns saved raw values when the runtime is stopped,
and the running runtime's read-only effective `RuntimeConfig` projection when
it is running. Config mutation still flows through `runtime.validateConfig` and
`runtime.start`; running `AgentRuntime` instances do not accept direct config
updates.

The `runtime.start` reply and the `runtime.statusChanged` notification carry
the instance lifecycle `status` plus an optional `error` (only meaningful for
`error`) and an optional `phase` (`{code, message, retryable?}`) that names the
step a non-error status is in, for example `waiting_bridge` while a DSH
instance is `starting`, or `syncing` / `sync_interrupted` while a `running` DSH
instance rebuilds its session baseline (session operations already work then).
A phase is progress, not a fault: the Server stores it on the runtime instance
(`phase` in `RuntimeInstanceStatus`), does not re-issue `runtime.start` while
an instance reports a starting phase (session operations get a retryable
`409 runtime_starting` instead), and clients render it as progress text next to
the `starting` or `running` badge.

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

`timeline.sync` with `complete: true` replaces the whole session timeline: the
Server writes only changed items and deletes items the snapshot no longer holds.
A snapshot too large for one request is sent as pages, each carrying the optional
`snapshotRange: {afterOrderSeq?, throughOrderSeq?}`. A page with a range holds every
snapshot item with `afterOrderSeq < orderSeq <= throughOrderSeq` (a missing or null
bound is unbounded), and the Server replaces only that range regardless of
`complete`. Such a page never resets clients to its items: changed items are
published incrementally, and a page that deletes or moves stored rows raises the
timeline reset fence and asks clients to refetch. An inverted or out-of-range
bound is rejected with `invalid_snapshot_range`. See
[DSH snapshot uploads](../dsh-snapshot-uploads.md).

`POST /api/v2/connector/ingest` isolates notification failures inside a batch.
One malformed or conflicting notification must not produce HTTP 500 or prevent
later notifications in the same request from being applied. The response
includes:

```json
{
  "accepted": 2,
  "rejected": [
    {
      "index": 1,
      "method": "timeline.itemUpsert",
      "code": "notification_failed",
      "message": "...",
      "errorType": "ValidationError"
    }
  ],
  "serverTime": "..."
}
```

`accepted` counts successfully applied notifications. `rejected` reports
per-notification failures using the original zero-based batch index. Explicit
protocol violations that are intentionally unsupported may still return HTTP
400; unexpected processing failures should be logged and reported through
`rejected` instead of surfacing as HTTP 500.

时间线通知中的 `orderSeq` 必须在 PostgreSQL `integer` 范围内
（−2147483648–2147483647）。单条通知请求中的越界值返回 HTTP 400
`invalid_order_seq`；混合批次通过 `rejected` 返回该通知的原始索引和
`invalid_order_seq`，继续处理同一批次的其他通知。`timeline.sync` 的任一条目
越界时拒绝整条同步通知，避免部分应用完整快照。

旧版本遗留在缓冲中的越界条目会按原顺序移到持久时间线末尾；接收新条目前
先完成修复，滚动升级时已缓存的会话也遵循这一顺序。修复会在同一数据库
事务中推进会话游标并记录时间线重置边界。客户端收到 `session.refetch_required`
后，使用修复前游标请求 `/events` 将得到 `snapshotRequired: true`，随后读取
快照获得新排序；断线重连也通过同一边界恢复。

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
