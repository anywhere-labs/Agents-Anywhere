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

### `session_states` -> `SessionState`

Persisted runtime-owned current session projection.

```text
session_id primary key
runtime
status
selections_json
status_reason
error_json
metadata_json
updated_seq
updated_at
```

This state deliberately excludes command data, catalog data, timeline items, and active turn id.

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

`SessionState.status` is the final UI running-state source. Legacy `sessions.status` should be kept only as a migration/backfill projection. State updates are partial and merge non-empty fields. Selection updates merge by scope, and `selections_json` may contain future scopes beyond the built-in `model` and `permission` keys.

### `timeline_items` -> `SessionTimeline`

Persisted chronological session record:

- timeline items
- event/recovery cursor state

Timeline remains upsert-only. Hiding replaces deletion.

### `notices` -> `SessionNotice`

Persisted user-attention and interaction records:

- notifications
- approvals
- input requests
- confirmations
- runtime/platform errors that should be shown to the user

Notices are separate from `SessionTimeline` so future notice/interaction extensions do not force timeline schema changes.

## API target

Paths are draft names. Implementation may adjust names, but the semantics should remain. The detailed client-facing session API proposal lives in [Session API proposal](../api/session-api-proposal.md).

### Runtime-level catalog reads

```text
GET /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/catalogs/models
GET /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/catalogs/permissions
```

These routes call Connector RPC, which calls runtime local reads. They do not read the durable server catalog tables as the primary path.

### Existing session state

```text
GET /api/v2/sessions/{sessionId}/state
PATCH /api/v2/sessions/{sessionId}/state/selections
```

`GET` returns the latest persisted runtime projection, and may refresh from Connector when online.

`PATCH` asks the runtime to update selections in `SessionState`. The runtime may accept or reject based on current state. The durable UI update should arrive as `session.state.updated`.

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
GET /api/v2/sessions/{sessionId}/commands?query=...
POST /api/v2/sessions/{sessionId}/commands
```

Both routes call Connector RPC. Command list is not durable.

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
POST /api/v2/sessions/{sessionId}/messages
```

Message send only carries content, attachments, and client message id. It must not carry model/permission selection ids.

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
- `MessageCreateRequest.modelSelectionId`
- `MessageCreateRequest.permissionSelectionId`
- `SessionCreateRequest.modelSelectionId`
- `SessionCreateRequest.permissionSelectionId`
- snapshot `catalogs.model` and `catalogs.permission` as primary UI source
- server catalog validation as the primary runtime option check
