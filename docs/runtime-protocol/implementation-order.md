# Runtime Protocol Implementation Order

Status: active migration plan, updated after the first Connector rewrite stack.

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
- Server no longer accepts `protocol.modelCatalogUpdated` or
  `protocol.permissionCatalogUpdated` on active Connector ingest, and session
  snapshot no longer returns Server-persisted catalogs. The old catalog table and
  low-level service remain as migration remnants until a later database cleanup.
- `repository_ports.py` has the right idea, but many ports are broad composite interfaces that recreate a large Store facade.
- `core/models.py` is too broad and mixes unrelated API/domain schemas.

### Connector

Connector has crossed the first large rewrite boundary. The active root package
is now thin and old pre-protocol code is reference-only:

```text
connector/connector/
  core/
  server/
  runtime_protocol/
  runtimes/
  local/
  _reference/
```

Completed Connector migration pieces:

- `RuntimeProvider`, `AgentRuntime`, `RuntimeHostClient`, and
  `RuntimeSupervisor` exist under `runtime_protocol/`.
- JSON runtime config storage exists under `core/runtime_config_store.py`.
- `BackendRpcClient` is now a server-layer coordinator around auth, ingest,
  dispatch, runtime supervisor, local ops, and runtime host mapping.
- Native `runtimes/codex` and `runtimes/claude` provider/runtime packages exist.
- Old Codex/Claude/adapter code lives under `_reference/`.
- Architecture tests forbid active imports of deprecated root modules.

Remaining Connector gaps:

- Runtime command catalog/execution is still not the primary active UI path.
- Codex IPC parity is not yet complete enough to treat IPC state/timeline/notice
  as fully projected protocol events.
- Some runtime behavior is feature-incomplete compared with the old reference
  adapters and must be migrated by reimplementing protocol behavior, not by
  restoring the old adapter contract.
- The root package still contains a few cross-layer utility files
  (`launch.py`, `logging.py`, `paths.py`, `time.py`). They are acceptable while
  thin, but should move only if it improves boundaries without churn.

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

Status: completed for the first rewrite stack. Keep adding narrow tests before
new behavior changes.

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

Status: completed as `connector/connector/runtime_protocol/`.

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

The package is intentionally still named `runtime_protocol`. It started as a
transitional name because the old `connector/runtime.py` root
module existed. That old root module is gone, but the rename to
`connector.runtime` is not required for this migration and should only happen as
a dedicated breaking cleanup if it clearly improves readability.

Define:

- `AgentRuntime`
- `RuntimeHostClient`
- `RuntimeProvider`
- `RuntimeSupervisor`
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
- Supervisor discover/start/stop/resolve behavior.
- Supervisor maps discovery failure to unavailable inventory.
- Supervisor rejects provider config for the wrong runtime.
- `RuntimeOperationResult` and `RuntimeCommandResult` include `ok`, `code`, `message`, and result payload fields.
- Model selection id rules:
  - reasoning variants carry selection ids;
  - non-reasoning model items carry selection ids.

Acceptance:

- New modules exist.
- Existing Connector behavior is unchanged.

## Phase 2: split Connector root modules and replace adapter dispatch

Status: mostly completed for active Connector paths.

Goal: make Connector application code depend on `AgentRuntime` directly, not on the old dict-shaped `Adapter` protocol. This is a rewrite, not a legacy compatibility wrapper.

The current extraction result is:

```text
ConnectorConfig           -> core/config.py
ProtocolRevisionClock     -> server/protocol_revision.py
JsonSyncStateStore        -> server/sync_state.py
HTTP/token helpers        -> server/auth.py and server/client.py
notification queue/flush  -> server/ingest.py
server RPC dispatch       -> server/dispatch.py
server method mapping     -> server/rpc.py
JSON-RPC frame helpers    -> core/json_rpc.py
runtime owner helpers     -> core/runtime_owner.py
generic provider classes  -> runtime_protocol/provider.py and runtime_protocol/supervisor.py
attachment helpers        -> runtime_protocol/attachments.py
```

Move concrete provider code out of `runtime_lifecycle.py` and make providers create `AgentRuntime` instances:

```text
CodexRuntimeProvider  -> runtimes/codex/provider.py
ClaudeRuntimeProvider -> runtimes/claude/provider.py
```

Rules:

- Do not add import shims for old runtime paths in the active Connector package.
- Pre-protocol Codex/Claude modules are reference-only under `_reference/` and must not be imported by active Connector code.
- Remove the old `Adapter` protocol from the active dispatch path.
- Do not add `legacy_adapter.py`, `host_legacy.py`, or a compatibility wrapper around the old adapter API.
- Runtime adapters must not return `backendNotifications`.
- Runtime adapters must not receive `notification_sink`.
- Keep commits small: one concern per commit.

Runtime config store:

```text
connector/connector/core/runtime_config_store.py
```

Rules:

- Store values by runtime id.
- Use the canonical Connector data directory.
- Do not use sqlite.
- Do not validate runtime semantics in the store.
- Return defensive copies so callers cannot mutate cached state.

Acceptance:

- Root `runtime.py` is removed from the active package.
- Runtime config values survive process restart through JSON.
- Missing runtime config loads as `{}`.
- Invalid JSON or invalid root shape fails explicitly.
- Generic runtime code no longer imports Codex or Claude modules.
- Server RPC dispatch resolves an `AgentRuntime`.
- New runtime code emits through `RuntimeHostClient`, not raw notification result dictionaries.

## Phase 3: implement Connector-native `RuntimeHostClient`

Status: completed for the active transport boundary. Continue extending the
host client only with semantic protocol calls, not raw adapter notifications.

Goal: replace adapter-side server notification construction with a Connector-owned host client.

Add:

```text
connector/connector/server/runtime_host.py
```

This host client maps semantic runtime events to the Connector server channel:

```text
session_meta_upsert
session_state_update
timeline_sync
timeline_item_upsert
notice_upsert
runtime_error
attachment_download
sync_state_*
```

Rules:

- This is not a legacy bridge for old adapters.
- The host client is the only Connector layer allowed to know server ingest payload details.
- Runtime adapters call host methods only.
- If Server does not yet support the final semantic ingest shape, update Server alongside this phase instead of preserving adapter-side legacy notifications.

Acceptance:

- Codex/Claude runtime implementations can report meta/state/timeline/notice through `RuntimeHostClient`.
- `BackendRpcClient` can route migrated runtime calls through `RuntimeSupervisor -> AgentRuntime`.
- `turn.start`, `turn.steer`, and `turn.interrupt` dispatch paths resolve only through `RuntimeSupervisor -> AgentRuntime`.
- `backendNotifications` is not part of the active runtime path.

## Phase 4: migrate Codex provider/runtime directly

Status: first native slice completed. Continue parity migration inside
`runtimes/codex`; do not import `_reference.codex` from active code.

Goal: replace `connector.codex.adapter.CodexAdapter` with a native `AgentRuntime` implementation.

Start with `CodexProvider` only:

```text
connector/connector/runtimes/codex/provider.py
```

First provider slice:

- `discover()`
- `get_config_schema()`
- `validate_config()`
- `create_runtime()` returns native `CodexRuntime`.

Evaluate the official Codex SDK first:

- Python SDK package: `openai-codex`
- Async entry point: `AsyncCodex`
- It controls the local Codex app-server over JSON-RPC.
- Published builds include a pinned Codex CLI runtime dependency.

Use the SDK if it exposes enough surface for:

- thread list/read/resume/start;
- turn start/steer/interrupt;
- streamed item/timeline events;
- model and permission catalog reads;
- command/slash-command support or enough primitives to implement it;
- session state and notice projection.

If the SDK hides required streaming or catalog details, use app-server JSON-RPC directly through a typed client generated from `codex app-server generate-json-schema`, but keep that implementation inside `runtimes/codex`.

Rules:

- Do not continue expanding hand-written Codex IPC as the primary integration path.
- Codex IPC may remain only for app/IDE token-level co-presence if the SDK/app-server cannot represent that surface.
- `CodexRuntime` implements `AgentRuntime`.
- `CodexRuntime` calls `RuntimeHostClient`.
- `steer_turn` and `interrupt_turn` do not require `turn_id`.
- Tool calls keep `SessionState.status = "running"` while active.

Acceptance:

- `CodexProvider` does not import `_reference.codex`.
- `CodexProvider` exposes `sdkMode: auto | sdk | app-server`.
- `auto` prefers the SDK when the `openai-codex` package is available.
- SDK mode is backed by an active `CodexRuntimeClient` adapter boundary, so
  future SDK API changes stay inside `runtimes/codex/sdk_client.py`.
- The app-server JSON-RPC client remains only as a fallback/reference path while
  Codex migrates fully to SDK-backed integration.
- `CodexProvider` keeps `ipcEnabled` as a beta config field and notes macOS-only
  test coverage. The `ipc` capability should remain false until active
  `runtimes/codex` code projects IPC state/timeline/notice events through
  `RuntimeHostClient`.
- Basic `CodexRuntime` supports `identity`, `start`, `stop`, `get_config`, model catalog, permission catalog, session list, session snapshot, session state reads, text-only turn start, text-only steer, local interrupt, and minimal live timeline item upserts.
- Basic `CodexRuntime` depends only on the narrow `CodexRuntimeClient`
  protocol; SDK/app-server transport details stay outside the runtime reducer.
- Codex text-only `create_and_start_session()` and `start_turn()` call the
  active Codex runtime client, not connector-layer IPC/app-server code.
- Codex turn start updates `SessionState.status` through `waiting` then `running`, and `turn/completed` maps back to `idle`.
- Codex no longer returns `backendNotifications`.
- Codex runtime events produce `SessionMeta`, `SessionState`, `SessionTimeline`, and `SessionNotice`.
- Codex turn start, steer, and interrupt paths use `AgentRuntime` when the native runtime is running.

## Phase 5: add Server `SessionState` as durable projection

Status: implemented for the current state/selections path. Remaining work is to
make all UI running-state decisions and all runtime event sources converge on
this projection.

Goal: make `SessionState` a first-class durable model and migrate old session
projection data into it.

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
- Web reads the new `SessionState` projection; any old field merge is part of the
  migration/backfill step, not a long-term compatibility path.

## Phase 6: add `SessionNotice` native path

Status: partial. Notices stay separate from timeline. Server ingest/respond and
Connector dispatch paths exist; Codex app-server approval requests now project
to `SessionNotice` through `RuntimeHostClient`. Claude approval parity and
additional notice kinds remain.

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

Status: partially implemented. Server/Connector command RPC and Web slash menu
now use runtime reads. Codex exposes the native `/compact` command through
`thread/compact/start`. Remaining work is additional concrete runtime command
catalog entries and runtime-specific command execution behavior.

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

Status: mostly completed for active message/create-and-start payloads. Legacy
selection fields are rejected on active Server notification and message paths.

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

## Phase 9: migrate Claude to native `AgentRuntime`

Status: first native slice completed. Continue parity migration inside
`runtimes/claude`; do not import `_reference.claude` from active code.

Goal: make Claude follow the same protocol with explicit unsupported behavior.

Refactor Claude so:

- `ClaudeSdkAdapter` implements `AgentRuntime`.
- Claude calls `RuntimeHostClient`.
- unsupported methods return standardized unsupported errors/results.

Acceptance:

- Claude does not require Server/Web runtime-specific conditionals.
- Capability differences are declared, not inferred from runtime name.

## Phase 10: Web protocol-driven UI

Status: partial. Message selection payload cleanup, runtime-driven command
mode, and dashboard WebSocket lifecycle without fixed connector/session polling
are done. Session detail no longer snapshots after ordinary disconnected
message/command/interaction actions; direct snapshots are limited to initial
load and explicit `snapshotRequired` recovery. The full
meta/state/timeline/notices endpoint split remains.

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

## Phase 11: remove compatibility paths

Status: in progress. Active Connector root adapter paths are guarded by tests.
Server/Web compatibility remnants should be removed only when their replacement
path is the active source of truth.

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

## Next commit stack

Continue with:

1. `document current connector structure and enforce migration boundary`
2. `make runtime command APIs server-routed`
3. `make Web slash command menu runtime-driven`
4. `finish SessionNotice interaction response path`
5. `finish Codex IPC event projection into SessionState/Timeline/Notice`
6. `remove remaining server-persisted catalog primary paths`

Do not restart the old first stack. The protocol skeleton and active Connector
rewrite already exist; future work should extend the new protocol path.
