# Server API and Database Target

Status: draft.

This document describes the server-facing target for the Agent Runtime Protocol v1 refactor. It is intentionally breaking.

## Server responsibility

The Server remains the durable platform source of truth for:

- users
- connectors
- platform sessions
- runtime session state projections
- session selection projections
- timeline items
- notices/interactions
- active WebSocket/SSE recovery cursors

The Server is not the source of truth for runtime model/permission catalogs. Catalog reads are live Connector RPC calls to the active runtime.

## Session model split

### `sessions`

Platform session metadata only:

- id
- connector id
- runtime
- external session id
- title
- cwd
- pin/archive/read metadata
- platform ordering/read metadata

Do not store runtime selections in `sessions`.

### `runtime_session_states`

Persisted runtime-owned UI state projection.

```text
session_id primary key
runtime
status
ordering_time
status_reason
error_json
metadata_json
updated_seq
updated_at
```

This state deliberately excludes model selection, permission selection, command data, catalog data, and active turn id.

### `session_selection_states`

Persisted runtime-owned session selection projection.

```text
session_id primary key
runtime
selections_json
ordering_time
metadata_json
updated_seq
updated_at
```

Example:

```json
{
  "model": "sel_model_...",
  "permission": "sel_permission_..."
}
```

Selection changes should be applied from runtime projection events, not by the server guessing runtime-native state.

## API target

Paths are draft names. Implementation may adjust names, but the semantics should remain.

### Runtime-level catalog reads

```text
GET /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/catalogs/models
GET /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/catalogs/permissions
```

These routes call Connector RPC, which calls runtime local reads. They do not read the durable server catalog tables as the primary path.

### Existing session selection

```text
GET /api/v2/sessions/{sessionId}/selection
PATCH /api/v2/sessions/{sessionId}/selection
```

`GET` returns the latest persisted runtime projection, and may refresh from Connector when online.

`PATCH` asks the runtime to update session selection. The runtime may accept or reject based on current state. The durable UI update should arrive as `session.selection.updated`.

### Existing session runtime state

```text
GET /api/v2/sessions/{sessionId}/runtime-state
```

Returns the latest persisted runtime state projection, and may refresh from Connector when online.

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
session.upsert
session.runtime_state.updated
session.selection.updated
timeline.sync
timeline.item.upsert
notice.upsert
runtime.error
```

Server ingress should validate each payload and upsert projections. Older names may be supported temporarily during migration, but runtime adapters should target host client methods rather than notification names.

## Snapshot target

Session snapshot should return separate fields:

```json
{
  "session": {},
  "runtimeState": {},
  "selectionState": {},
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
