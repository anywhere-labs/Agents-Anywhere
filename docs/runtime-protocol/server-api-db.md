# Server API and Database Target

Status: draft.

This document describes the server-facing target for the Agent Runtime Protocol v1 refactor. It is intentionally breaking.

## Server responsibility

The Server remains the durable platform source of truth for:

- users
- connectors
- session meta
- session state
- session timeline
- session notices/interactions
- active WebSocket/SSE recovery cursors

The Server is not the source of truth for runtime model/permission catalogs. Catalog reads are live Connector RPC calls to the active runtime.

## Session model split

### `sessions` -> `SessionMeta`

Platform session metadata only:

- id
- connector id
- runtime
- external session id
- title
- cwd
- pin/archive/read metadata
- platform ordering/read metadata
- ordering_time

Do not store runtime selections or running state in `sessions`.

### RuntimeLive state and selections

Runtime-owned current session state is not a durable Server table in the target
design.

```text
status
selections
status_reason
error
metadata
```

This state deliberately excludes command data, catalog data, timeline items,
notices, ordering time, and active turn id.

Example:

```json
{
  "status": "idle",
  "selections": {
    "model": "sel_model_...",
    "permission": "sel_permission_..."
  }
}
```

Selection and status changes should be applied from runtime projection events, not by the server guessing runtime-native state.

RuntimeLive state is the display state source. Session-scoped effective
capability is the action availability source. Legacy `sessions.status` should
be kept only as a migration/backfill projection. State updates are live facts.
Selection updates merge by scope, and selections may contain future scopes
beyond the built-in `model` and `permission` keys.

### `timeline_items` -> `SessionTimeline`

Persisted chronological session record:

- timeline items
- event/recovery cursor state

Timeline remains upsert-only. Hiding replaces deletion.

### `notices` -> `_deprecated` persisted notice design

This section describes an older design. Current API docs define notices as
non-durable RuntimeLive facts. Server must not use a persisted notices table as
the source of current session notices.

The older persisted-notice idea covered:

- notifications
- approvals
- input requests
- confirmations
- runtime/platform errors that should be shown to the user

If a notice has historical value, the runtime should write that history to
SessionTimeline. Current live notice semantics are defined in
[Session API Proposal](../api/session-api-proposal.md).

## API target

Paths are draft names. Implementation may adjust names, but the semantics should remain. The detailed client-facing session API proposal lives in [Session API proposal](../api/session-api-proposal.md).

### Runtime-level catalog reads

```text
GET /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/catalogs/model
GET /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/catalogs/permission
```

These routes call Connector RPC, which calls runtime local reads. They do not read the durable server catalog tables as the primary path.

### Session RuntimeLive state

```text
GET /api/v2/sessions/{sessionId}/runtime/state
PATCH /api/v2/sessions/{sessionId}/runtime/selections
```

The old persisted `session_states` target is removed from the current design.
Runtime state and selections are RuntimeLive facts. The Server forwards reads
and writes to the owning runtime and does not store them as authoritative
session truth.

`PATCH` asks the runtime to update selections. The runtime may accept or reject
based on current state. UI reconciliation arrives through
`runtime.state.updated` and `runtime.capability.updated`, or through a live
runtime read.

Request shape should mirror the state map and allow one or more scopes:

```json
{
  "selections": {
    "model": "sel_model_...",
    "permission": "sel_permission_..."
  }
}
```

### Commands

```text
GET /api/v2/sessions/{sessionId}/runtime/commands
POST /api/v2/sessions/{sessionId}/runtime/commands
```

Both routes call Connector RPC. Command list is not durable. The GET endpoint
returns the full current command list; Web performs fuzzy matching locally.

### New session

```text
POST /api/v2/sessions/create-and-start
```

Blank new sessions are not part of the first target. New session creation and first message dispatch are one operation.

Request shape should include:

- connector id
- runtime id/type
- server-preallocated session id
- title/cwd
- selection ids
- first message content
- attachments
- client message id

### Existing session message send

```text
POST /api/v2/sessions/{sessionId}/runtime/messages
```

Public message send only carries content, attachments, and client message id. It
must not carry model/permission selection ids. Server may still forward current
runtime selections to the Connector runtime RPC so the runtime can apply current
state when starting the turn.

## Connector ingest target

Runtime host client calls should be mapped to server ingest methods. Draft semantic events:

```text
session.meta.upsert
session.state.updated
timeline.sync
timeline.item.upsert
notice.upsert
runtime.error
```

Server ingress should validate each payload and upsert projections. Runtime implementations target host client methods rather than notification names; old runtime notification names should not be reintroduced into the active Connector path.

## Snapshot target

Session snapshot should return separate fields:

```json
{
  "meta": {},
  "state": {},
  "timeline": {},
  "notices": [],
  "effectiveCapabilities": {},
  "eventCursor": "seq:..."
}
```

Do not include model/permission catalogs in session snapshot as the primary selection source. Catalogs are read on demand from runtime-level APIs.

## Compatibility cleanup

Remove or deprecate:

- `sessions.model_selection_id`
- `sessions.permission_selection_id`

Already removed from active request contracts:

- `MessageCreateRequest.modelSelectionId`
- `MessageCreateRequest.permissionSelectionId`
- `SessionCreateRequest.modelSelectionId`
- `SessionCreateRequest.permissionSelectionId`

Bind-only `POST /sessions` accepts `selections`; new user tasks use
`POST /sessions/create-and-start`.

Still to remove or deprecate:

- snapshot `catalogs.model` and `catalogs.permission` as primary UI source
- server catalog validation as the primary runtime option check
