# Runtime Protocol Implementation Order

Status: draft, current execution plan.

This document is the practical order for refactoring Server and Connector toward Agent Runtime Protocol v1. It is more concrete than [Migration sequence](./migration-sequence.md): each phase should be independently reviewable and should avoid mixing protocol design, file moves, database migrations, and runtime behavior changes in one commit.

## Current architecture gaps

### Server

Server already has a useful `api / core / services / infra` shape:

```text
server/agent_server/
  api/
  core/
  services/
  infra/
```

The main gaps are:

- `api/sessions.py` still contains application orchestration, protocol publish helpers, capability projection, and broker fan-out.
- `services/session_run.py` still uses old message/create selection fields and validates selections against server-persisted catalogs.
- `sessions.status` is still the effective running-state projection. The new durable `SessionState` model is not yet the source of truth.
- Server still ingests and stores runtime catalogs through `protocol.modelCatalogUpdated` and `protocol.permissionCatalogUpdated`.
- `repository_ports.py` has the right idea, but many ports are broad composite interfaces that recreate a large Store facade.
- `core/models.py` is too broad and mixes unrelated API/domain schemas.

### Connector

Connector has the larger gap. It is still mostly root-level modules plus concrete runtime packages:

```text
connector/connector/
  runtime.py
  runtime_lifecycle.py
  adapter.py
  protocol.py
  codex/
  claude/
  local/
```

The main gaps are:

- `runtime.py` mixes config, auth, HTTP, WebSocket, RPC dispatch, notification batching, runtime supervision, local ops, attachments, and terminal bridging.
- `runtime_lifecycle.py` mixes generic provider/supervisor concepts with concrete Codex and Claude provider construction.
- `adapter.py` is still a dict-shaped legacy adapter protocol.
- Runtime adapters still return `backendNotifications` or use `notification_sink`.
- Runtime adapters and Connector runtime code still know server notification method names.
- Codex and Claude adapters are still large orchestration modules instead of thin implementations of `AgentRuntime`.

## Target dependency direction

### Server

```text
api -> application services -> domain
application services -> ports
infra -> ports/domain
```

Routes should not directly coordinate broker publishing, connector RPC, repository writes, and projection logic. Services should depend on small ports rather than infra classes or a broad Store facade.

### Connector

```text
app -> server -> runtime
server -> runtime host mapping
runtime -> models/protocol/errors only
runtimes/* -> runtime protocol + native runtime details
```

Generic Connector code must not import Codex or Claude internals. Concrete runtime packages register providers by composition.

## Phase 0: freeze current behavior with narrow tests

Goal: create a safety net before introducing the new protocol layer.

Do:

- Add focused tests around current Connector RPC dispatch for:
  - `session.create`
  - `session.sync`
  - `turn.start`
  - `turn.steer`
  - `turn.interrupt`
- Add focused Server tests for current state/capability behavior:
  - message send transitions to waiting/pending equivalent
  - interrupt remains available during tool/running states
  - sequence gaps do not force snapshot unless recovery is explicitly impossible
- Avoid large snapshots or end-to-end browser work in this phase.

Do not:

- Move files.
- Change runtime behavior.
- Change database schema.

Acceptance:

- Tests document the current compatibility behavior that later phases must preserve or intentionally replace.

## Phase 1: add Connector runtime protocol skeleton

Goal: introduce the new abstractions without changing behavior.

Add the first implementation under a transitional package name:

```text
connector/connector/runtime_protocol/
  __init__.py
  errors.py
  models.py
  protocol.py
  host.py
```

The final target package is still:

```text
connector/connector/runtime/
  __init__.py
  errors.py
  models.py
  protocol.py
  host.py
```

Use `runtime_protocol` first because the current Connector already has a root `connector/runtime.py` module. The package can be renamed to `connector.runtime` after the old module is split into `core/`, `server/`, and application assembly modules.

Define:

- `AgentRuntime`
- `RuntimeHostClient`
- `RuntimeProvider`
- `RuntimeOperationResult`
- `RuntimeCommandResult`
- `SessionMeta`
- `SessionState`
- `SessionTimeline` snapshot/item types
- `SessionNotice`
- catalog and command dataclasses

Rules:

- No keyword-only `*` parameters in the public ABCs.
- Complex entities use dataclasses.
- `RuntimeStatus` uses:

```text
idle
waiting
running
blocked
error
disconnected
```

- `waiting` means Web/Server requested a turn, but runtime has not confirmed processing has started.
- `ordering_time` appears only on `SessionMeta`.
- `SessionState` has no active turn id, command list, catalog data, timeline items, or notices.

Tests:

- ABC default unsupported behavior.
- Public ABC methods do not use keyword-only parameters.
- `RuntimeOperationResult` and `RuntimeCommandResult` include `ok`, `code`, `message`, and result payload fields.
- Model selection id rules:
  - reasoning variants carry selection ids;
  - non-reasoning model items carry selection ids.

Acceptance:

- New modules exist.
- Existing Connector behavior is unchanged.

## Phase 2: add a legacy `RuntimeHostClient` bridge

Goal: let runtime adapters call semantic host methods while the Server still accepts old ingest notifications.

Add:

```text
connector/connector/runtime/host_legacy.py
```

It maps:

```text
session_meta_upsert      -> session.updated
session_state_update     -> session.updated / future session.state.updated
timeline_sync            -> timeline.sync
timeline_item_upsert     -> timeline.itemUpsert
notice_upsert            -> notice.upsert
runtime_error            -> notice.upsert or runtime.statusChanged compatibility
attachment_download      -> current attachment downloader
sync_state_*             -> current JSON sync state store
```

This is explicitly a compatibility bridge. It should be easy to delete after Server natively accepts runtime host events.

Rules:

- New runtime protocol code must not build raw server notification names.
- Only `host_legacy.py` may know the old notification names during this phase.

Acceptance:

- Existing adapters can be wired through `RuntimeHostClient` without changing Server.
- `backendNotifications` can remain only as a compatibility fallback.

## Phase 3: wrap legacy adapters as `AgentRuntime`

Goal: make Connector upper layers depend on `AgentRuntime` before rewriting Codex/Claude internals.

Add a compatibility wrapper:

```text
connector/connector/runtime/legacy_adapter.py
```

It translates:

```text
AgentRuntime method -> old Adapter dict method
```

Examples:

```text
start_turn(...)              -> adapter.start_turn(params)
steer_turn(...)              -> adapter.steer_turn(params)
interrupt_turn(...)          -> adapter.interrupt_turn(params)
get_session_snapshot(...)    -> adapter.sync_session(params)
list_model_catalog(...)      -> adapter.model_catalog(revision=...)
list_permission_catalog(...) -> adapter.permission_catalog(revision=...)
```

Rules:

- Connector server dispatch should call `AgentRuntime`, not `Adapter`, after this phase.
- The wrapper is transitional and should not add new product behavior.

Acceptance:

- `connector/connector/runtime.py` or its extracted dispatch layer resolves an `AgentRuntime`.
- Old Codex/Claude adapters still work behind the wrapper.

## Phase 4: split Connector root modules without behavior changes

Goal: reduce the blast radius before changing Server contracts.

Move or extract incrementally:

```text
ConnectorConfig           -> core/config.py
ProtocolRevisionClock     -> core/revision.py
JsonSyncStateStore        -> core/sync_state.py
HTTP/token helpers        -> server/auth.py and server/client.py
notification queue/flush  -> server/ingest.py
server RPC dispatch       -> server/dispatch.py
server method mapping     -> server/rpc.py
JSON-RPC frame helpers    -> transport/json_rpc.py
launch helpers            -> transport/launch.py
generic provider classes  -> runtime/provider.py and runtime/supervisor.py
```

Move concrete provider code out of `runtime_lifecycle.py`:

```text
CodexRuntimeProvider  -> runtimes/codex/provider.py
ClaudeRuntimeProvider -> runtimes/claude/provider.py
```

Rules:

- Prefer import shims for old paths during the transition.
- Do not move Codex/Claude adapter internals yet unless the move is purely mechanical.
- Keep commits small: one concern per commit.

Acceptance:

- Root `runtime.py` becomes an application assembly/coordinator, not a 900-line networking/runtime/local-ops module.
- Generic runtime code no longer imports Codex or Claude modules.

## Phase 5: add Server `SessionState` as durable projection

Goal: make `SessionState` a first-class durable model while keeping compatibility.

Add database/repository/service/API support for:

```text
session_states
GET /api/v2/sessions/{sessionId}/state
PATCH /api/v2/sessions/{sessionId}/state/selections
```

`session_states` should include:

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

Rules:

- `SessionState.status` becomes the target UI running-state source.
- Existing `sessions.status` remains only as a migration projection until Web is moved.
- State updates are partial and merge non-empty fields.
- Selection updates merge by scope.
- Server does not validate selection ids against DB catalogs as protocol truth.

Acceptance:

- A session can refresh and recover status/selections from `SessionState`.
- Existing Web remains compatible through transitional projection.

## Phase 6: add `SessionNotice` native path

Goal: make notices/interactions separate from timeline and aligned with runtime protocol.

Server already has a notices table concept. Align it with `SessionNotice` semantics:

- session-level only
- durable
- separate from timeline
- used for approvals, input requests, confirmations, warnings, and user-visible runtime errors

Add or update:

```text
GET session notices as part of snapshot
notice.upsert ingest -> SessionNotice
respond_interaction -> Runtime RPC
```

Rules:

- Timeline is not the owner of notice lifecycle.
- User response does not automatically close a notice unless runtime/service semantics require it.
- Closing is represented as an upsert/status update, not deletion.

Acceptance:

- Approval/input request survives refresh.
- Runtime can close or update the notice without touching timeline schema.

## Phase 7: add live runtime catalog and command APIs

Goal: move model/permission/command reads to Connector RPC.

Add or switch primary paths:

```text
GET /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/catalogs/models
GET /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/catalogs/permissions
GET /api/v2/sessions/{sessionId}/commands?query=...
POST /api/v2/sessions/{sessionId}/commands
```

Rules:

- Catalogs are live runtime reads, not durable Server truth.
- Command lists are session live reads, not frontend-built static lists.
- `/xxx` command lookup or execution failure must not fallback to a normal user message.
- Command result uses standardized `ok/code/message/result`.

Acceptance:

- Opening model/permission selectors does not depend on Server catalog tables.
- Typing `/` reads commands from runtime.

## Phase 8: replace message/create selection flow

Goal: remove one-off model/permission fields from message send and existing session create flow.

For existing sessions:

```text
PATCH /sessions/{id}/state/selections
POST /sessions/{id}/messages
```

Message payload contains:

- content
- attachments
- client message id

Message payload must not contain:

- model selection id
- permission selection id

For new sessions:

```text
POST /api/v2/sessions/create-and-start
```

Rules:

- Server preallocates `session_id`.
- create-and-start carries first message and initial selections.
- Runtime is final selection validator.
- No blank new session target for the first migration.

Acceptance:

- Existing session message send has no model/permission fields.
- New session create-and-start binds the first runtime events to the platform session id.

## Phase 9: migrate Codex to native `AgentRuntime`

Goal: remove Codex dependence on legacy dict adapter behavior.

Refactor Codex so:

- `CodexAdapter` implements `AgentRuntime`.
- Codex calls `RuntimeHostClient` for meta/state/timeline/notice updates.
- Codex IPC, app-server stdio, local history, reducer, and sync state stay inside `runtimes/codex`.
- IPC state maps to `SessionState`, `SessionTimeline`, and `SessionNotice`.
- `steer_turn` and `interrupt_turn` do not require `turn_id`.
- Tool calls keep `SessionState.status = "running"` while active.

Rules:

- Codex adapter must not emit raw server notification method names.
- `backendNotifications` should be removed for Codex after native migration.

Acceptance:

- Web message from platform does not duplicate user timeline items after IPC backflow.
- Interrupt button remains visible during tool/running states.
- Codex IPC state survives refresh through Server projections.

## Phase 10: migrate Claude to native `AgentRuntime`

Goal: make Claude follow the same protocol with explicit unsupported behavior.

Refactor Claude so:

- `ClaudeSdkAdapter` implements `AgentRuntime`.
- Claude calls `RuntimeHostClient`.
- unsupported methods return standardized unsupported errors/results.

Acceptance:

- Claude does not require Server/Web runtime-specific conditionals.
- Capability differences are declared, not inferred from runtime name.

## Phase 11: Web protocol-driven UI

Goal: make UI read the new protocol projections and live catalogs.

Update Web:

- session load reads `meta/state/timeline/notices`
- busy/interrupt UI reads `SessionState.status`
- selector opens perform live runtime catalog reads
- selection changes call `PATCH /state/selections`
- message send has no selection fields
- command mode reads runtime command list
- command execution uses command API, not message API
- snapshot is initial load/recovery only, not periodic refresh

Acceptance:

- No periodic session snapshot polling during normal streaming.
- Dashboard connector/session updates use dashboard lifecycle events or WebSocket path, not tight polling.
- Refresh preserves state, notices, and timeline without duplicate user messages.

## Phase 12: remove compatibility paths

Goal: delete old behavior after all clients and runtimes are migrated.

Remove or hard-deprecate:

- `backendNotifications`
- `notification_sink` as adapter API
- old `Adapter` dict protocol
- `protocol.modelCatalogUpdated` and `protocol.permissionCatalogUpdated` as durable catalog truth
- `sessions.model_selection_id`
- `sessions.permission_selection_id`
- message/create selection fields
- `sessions.status` as UI truth
- old hardcoded command behavior
- old root-level Connector modules after shims are no longer needed

Acceptance:

- Runtime adapters only implement `AgentRuntime`.
- Runtime adapters only call `RuntimeHostClient`.
- Server durable truth is `SessionMeta`, `SessionState`, `SessionTimeline`, and `SessionNotice`.

## Recommended first commit stack

Start with this small stack:

1. `connector runtime protocol skeleton`
2. `legacy runtime host bridge`
3. `legacy adapter runtime wrapper`
4. `extract connector config/client/ingest from runtime.py`
5. `server session state projection`

Do not start with Codex IPC rewrites or broad file moves. The protocol skeleton and bridges give us a seam; after that, Codex/Server/Web can be migrated one slice at a time.
