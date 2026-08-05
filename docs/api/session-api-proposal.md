# Session API Proposal

Status: authoritative proposal for the next breaking session API cleanup.

This document defines the target client-facing session API around three
separate facts:

```text
SessionMeta      durable Server fact
SessionTimeline  durable Server fact written by Runtime
RuntimeLive      non-durable Runtime fact forwarded by Server
```

Connector channel endpoint names stay stable:

```text
POST /api/v2/connector/auth
POST /api/v2/connector/ingest
WS   /api/v2/connector/ws
```

The refactor happens behind these endpoints and in the client-facing session
API. The Server must not become the source of truth for runtime state, notices,
capabilities, catalogs, commands, or selections.

## Source-of-truth rules

Every fact must have one owner.

| Fact | Owner | Durable | Pull source | Push source |
| --- | --- | --- | --- | --- |
| SessionMeta | Server | yes | Server DB | Server session WS |
| SessionTimeline | Server DB, written by Runtime | yes | Server DB | Server session WS |
| Runtime session state | Runtime | no | Runtime RPC | Runtime push through connector WS |
| Runtime notices | Runtime | no | Runtime RPC | Runtime push through connector WS |
| Runtime-scoped effective capabilities | Runtime plus Server policy | no | Runtime RPC plus Server policy | Runtime push through connector WS |
| Session-scoped effective capabilities | Runtime plus Server policy | no | Runtime RPC plus Server policy | Runtime push through connector WS |
| Runtime catalogs | Runtime | no | Runtime RPC | Runtime push through connector WS |
| Runtime commands | Runtime | no | Runtime RPC | optional runtime push |
| Session selections | Runtime | no | Runtime RPC | Runtime push through connector WS |
| Connector presence | Server | no/durable connector row only | Server connection state | Server WS |

Pull and push must agree:

- If a fact can be pushed to Web, the corresponding read endpoint must return
  the same latest fact from the same owner.
- If a fact is read from Server DB, runtime live pushes must not mutate it.
- If a fact is read from Runtime RPC, Server must not synthesize stale DB
  fallback except for explicit `unavailable` presence projection.

## Durable resources

### SessionMeta

SessionMeta is the Server-owned session list and display metadata:

```text
id
connectorId
runtime
externalSessionId
origin
title
cwd
takeover
pinned / pinnedAt
archived / archivedAt
lastReadSeq
lastSyncedAt
sourceObservedAt
lastActivityAt
lastItemAt
lastItemOrderSeq
sortAt
createdAt / updatedAt / updatedSeq
```

Rules:

- `sessions.status` is not a runtime running-state source.
- Server may expose connector presence on the meta/list view.
- Server may compute `sortAt`, but runtime running/blocking status must not
  affect sorting.
- List sorting uses one primary ordering input at a time:

```text
lastItemAt -> lastActivityAt -> createdAt
```

### SessionTimeline

SessionTimeline is the UI chat context and the only durable conversation fact.

Runtime adapters reduce native events into stable platform timeline items. The
Server persists those items, computes item diffs, assigns sequence numbers, and
broadcasts incremental updates through the session WebSocket.

Rules:

- Timeline is upsert-only.
- Deletion is represented as an upserted hidden item.
- `contentHash` is the canonical item state identity.
- Server may bump outgoing revision for event classification, but must not use
  revision as the write/no-write truth.
- Timeline does not own current runtime status.
- Timeline does not own current notice state.
- Timeline may contain historical records of interactions, approvals, compact,
  tool calls, and errors.

## Runtime live resources

RuntimeLive is non-durable and owned by the runtime. Server is an RPC and WS
relay, with only user authorization and connector presence policy layered on
top.

### Runtime session state

Runtime session state includes:

```text
status: idle | waiting | running | blocked | error | disconnected
selections
statusReason
error
metadata
```

Rules:

- Runtime is the source of `idle`, `waiting`, `running`, `blocked`, and `error`.
- Server may project `disconnected` when connector/runtime is unreachable.
- Server must not derive running or blocked from active timeline items, open
  notices, active runs, or turn end items.
- A runtime state push and a runtime state read must produce the same fact.

### Runtime notices

Notice is a special RuntimeLive resource.

Rules:

- Notice is non-durable.
- Runtime is the only fact source.
- Server must not cache notices in DB as the session truth.
- Server responds to notice actions by forwarding RPC to runtime.
- If a notice has historical value, runtime writes the history to timeline.
- Refreshing a page reads current notices from runtime RPC, not from Server DB.

Examples:

```text
approval requested      -> live runtime notice
approval approved       -> runtime updates/removes live notice
approval history shown  -> runtime writes/updates timeline item
```

### Runtime catalogs, selections, effective capabilities, commands

Rules:

- Catalog reads are live runtime RPCs.
- Selection reads and updates are live session-scoped runtime RPCs.
- Capability reads return effective capability sets.
- Runtime-scoped effective capabilities are read from runtime resources and
  affect dashboard/setup/create behavior.
- Session-scoped effective capabilities are read from session runtime resources
  and affect current session actions.
- Server may apply authorization, takeover, connector presence, runtime
  reachability, and feature policy. Server must not infer runtime-owned action
  availability from durable session data.
- Command lists are live runtime RPCs, normally read when the user enters
  command mode.
- Server must not treat catalog/capability DB rows as authoritative session UI
  facts.

## Target HTTP API

All routes are mounted under `/api/v2`.

### SessionMeta

```text
GET   /sessions
GET   /sessions/{sessionId}/meta
PATCH /sessions/{sessionId}/meta
POST  /sessions/read
POST  /sessions/archive
POST  /sessions/unarchive
```

`GET /sessions` returns SessionMeta summaries for dashboard/list views. It may
include connector presence, but must not include runtime state as durable fact.

`PATCH /sessions/{sessionId}/meta` updates only Server-owned display metadata:

```json
{
  "title": "New title",
  "pinned": true,
  "archived": false
}
```

`POST /sessions/read` accepts a direct JSON array of session ids:

```json
["sess_1", "sess_2"]
```

`POST /sessions/archive` accepts a direct JSON array of session ids and archives
those sessions:

```json
["sess_1", "sess_2"]
```

`POST /sessions/unarchive` accepts the same direct JSON array and unarchives
those sessions:

```json
["sess_1", "sess_2"]
```

The removed per-session and bulk aliases migrate as follows:

```text
removed: POST /sessions/{sessionId}/read
use:     POST /sessions/read with ["{sessionId}"]

removed: POST /sessions/bulk-read
use:     POST /sessions/read

removed: POST /sessions/bulk-archive
use:     POST /sessions/archive with ["sess_1", "sess_2"]
use:     POST /sessions/unarchive with ["sess_1", "sess_2"]
```

### SessionTimeline

```text
GET /sessions/{sessionId}/timeline
```

Query modes:

```text
?mode=latest&limit=200
?mode=changes&afterSeq=123&limit=200
?mode=history&beforeOrderSeq=456&limit=100
```

Response:

```json
{
  "sessionId": "sess_...",
  "items": [],
  "nextSeq": 123,
  "hasMore": false,
  "serverTime": "2026-08-04T..."
}
```

Timeline reads do not return runtime state, notices, catalogs, or capabilities.

### Aggregate snapshot

```text
GET /sessions/{sessionId}/snapshot
```

Snapshot is an aggregate first-paint/recovery endpoint. It is not a new fact
source.

Response shape:

```json
{
  "meta": {},
  "timeline": {
    "items": [],
    "nextSeq": 123,
    "hasMore": false
  },
  "runtime": {
    "available": true,
    "state": {},
    "notices": [],
    "capabilities": {},
    "catalogs": {}
  },
  "eventCursor": "seq:123",
  "serverTime": "2026-08-04T..."
}
```

Sources:

- `meta`: Server DB.
- `timeline`: Server DB.
- `runtime.*`: live runtime RPC.

If runtime is unavailable:

```json
{
  "runtime": {
    "available": false,
    "reason": "runtime_offline",
    "state": {
      "status": "disconnected"
    },
    "notices": [],
    "capabilities": {},
    "catalogs": {}
  }
}
```

The unavailable state must be clearly marked as Server presence projection, not
as a cached runtime fact.

### Runtime live endpoints

```text
GET   /sessions/{sessionId}/runtime/state
GET   /sessions/{sessionId}/runtime/notices
POST  /sessions/{sessionId}/runtime/notices/{noticeId}/respond
GET   /sessions/{sessionId}/runtime/capabilities
GET   /sessions/{sessionId}/runtime/catalogs/model
GET   /sessions/{sessionId}/runtime/catalogs/permission
GET   /sessions/{sessionId}/runtime/commands
POST  /sessions/{sessionId}/runtime/commands
PATCH /sessions/{sessionId}/runtime/selections
POST  /sessions/{sessionId}/runtime/messages
POST  /sessions/{sessionId}/runtime/steer
POST  /sessions/{sessionId}/runtime/interrupt
```

`/sessions/{sessionId}/runtime/capabilities` returns session-scoped effective
capabilities. Web must use those capabilities for current-session action
availability instead of deriving availability from local runtime status.

Runtime-scoped live endpoints use runtime resources:

```text
GET /runtimes/{runtime}/capabilities
GET /runtimes/{runtime}/catalogs/model
GET /runtimes/{runtime}/catalogs/permission
GET /runtimes/{runtime}/commands
```

When the route must target a specific connector, connector ownership is encoded
in the path:

```text
GET /connectors/{connectorId}/runtimes/{runtime}/capabilities
GET /connectors/{connectorId}/runtimes/{runtime}/catalogs/model
GET /connectors/{connectorId}/runtimes/{runtime}/catalogs/permission
GET /connectors/{connectorId}/runtimes/{runtime}/commands
```

Command endpoints intentionally do not accept query parameters:

```text
GET /sessions/{sessionId}/runtime/commands
```

Command search and fuzzy matching happen in Web after reading the command list.
Do not add command query parameters unless the command collection becomes too
large for a normal live read.

Do not add new APIs like `/agents/{runtime}/model-catalog?connectorId=...`.

Rules:

- These endpoints call runtime RPC.
- Server authorizes the user and connector/session ownership.
- Server may return `runtime_unavailable`.
- Server does not persist successful read results as truth.
- Selection update changes runtime session state immediately; whether it affects
  the current turn or next turn is a runtime boundary.

### Create and start

```text
POST /sessions/create-and-start
```

Request:

```json
{
  "connectorId": "conn_...",
  "runtime": "codex",
  "title": "Optional title",
  "cwd": "/workspace",
  "selections": {
    "model": "sel_model_...",
    "permission": "sel_permission_..."
  },
  "message": {
    "content": "Hello",
    "attachments": [],
    "clientMessageId": "client_..."
  }
}
```

Rules:

- Server preallocates SessionMeta.
- Runtime receives the platform `sessionId` before producing timeline/state
  updates.
- Runtime validates selections.
- Runtime creates the native session and starts the first turn as one action.
- Runtime writes first user/assistant timeline items through the normal
  timeline path.

## Session WebSocket

One session WebSocket carries all session-scoped updates:

```text
WS /sessions/{sessionId}/ws?ticket=...
```

Event namespaces:

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

Notes:

- `timeline.*` events are durable and recoverable from Server DB.
- `runtime.*` events are live facts. Recovery may require a runtime RPC read,
  not a Server snapshot.
- `runtime.capability.updated` carries an effective capability set. On the
  session socket it is session-scoped; on dashboard/runtime sockets it is
  runtime-scoped.
- `session.refetch_required` is reserved for durable meta/timeline recovery.
- `runtime.refetch_required` means the Web client should call the relevant
  runtime live endpoint.
- Current `session.status_changed`, `notice.*`, and
  `effectiveCapabilities` payloads are compatibility shapes and should migrate
  to these names.

## Event recovery

```text
GET /sessions/{sessionId}/events?after=seq:123
```

This endpoint recovers durable session events:

- SessionMeta changes.
- Timeline item changes.
- Durable refetch signals.

It must not pretend to recover runtime live notices/state from DB. If the client
misses runtime live updates, it should call the corresponding runtime live
endpoint after reconnect.

## Removed legacy route blocks

This target API intentionally removes the old legacy route block. If an
implementation still exposes those routes during migration, it must either
route them to the scoped APIs in this document or return an explicit migration
error. Removed agent catalog query routes should not start runtimes or perform
connector RPC. Removed connector protocol capability reads should not serve UI
capability facts.

Migration guide:

- Old session state reads move to `/sessions/{sessionId}/runtime/state`.
- Old selection updates move to `/sessions/{sessionId}/runtime/selections`.
- Old message sends move to `/sessions/{sessionId}/runtime/messages`.
- Old command execution moves to `/sessions/{sessionId}/runtime/commands`.
- Old interaction responses move to
  `/sessions/{sessionId}/runtime/notices/{noticeId}/respond`.
- Old connector protocol capability reads move to runtime-scoped or
  session-scoped effective capability endpoints.
- Old agent catalog reads with `connectorId` query params move to
  `/connectors/{connectorId}/runtimes/{runtime}/catalogs/model` and
  `/connectors/{connectorId}/runtimes/{runtime}/catalogs/permission`.
