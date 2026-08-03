# Runtime Protocol Implementation Order

Status: active migration plan, updated after the Connector runtime protocol
refactor stack on `v2-connector-refactor`.

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
- Runtime config values are Server-owned; Connector does not persist them
  locally.
- `BackendRpcClient` is now a server-layer coordinator around auth, ingest,
  dispatch, runtime supervisor, local ops, and runtime host mapping.
- Connector server runtime RPC is split into runtime lifecycle/config/catalog,
  session sync/state, and turn/command/interaction coordinators.
- Native `runtimes/codex` and `runtimes/claude` provider/runtime packages exist.
- Active Codex is SDK-only through `CodexRuntimeClient`; historical app-server
  and IPC code is reference/deprecated material only.
- Old Codex/Claude/adapter code lives under `_reference/`.
- Architecture tests forbid active imports of deprecated root modules and
  Codex app-server/IPC tokens.

Remaining Connector gaps:

- Runtime parity still depends on the concrete SDK surfaces available at runtime;
  unsupported behavior must remain explicit through capabilities/errors.
- Additional concrete runtime command catalog entries may be added as runtimes
  expose them.
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

Runtime config ownership:

```text
connector/connector/_deprecated/runtime_config_store.py
```

Rules:

- Runtime config values are persisted by Server, not Connector local disk.
- Connector reports schema/defaults and validates config values supplied by
  Server RPC.
- `runtime.start` requires Server to send config values in the RPC payload.
- Connector process restart must not automatically start runtimes from local
  saved config.
- The old JSON store is kept only under `_deprecated/` as migration reference.

Acceptance:

- Root `runtime.py` is removed from the active package.
- Active Connector code does not import a runtime config store.
- `runtime.config` returns only current effective running config, not saved
  values.
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
- The active Connector adapter uses the SDK surface (`AsyncCodex`,
  `AsyncThread`, `AsyncTurnHandle`) through
  `runtimes/codex/sdk_client.py`.
- Published builds include a pinned Codex CLI runtime dependency.

Use the SDK if it exposes enough surface for:

- thread list/read/resume/start;
- turn start/steer/interrupt;
- streamed item/timeline events;
- model and permission catalog reads;
- command/slash-command support or enough primitives to implement it;
- session state and notice projection.

The active Codex integration is SDK-only. Historical app-server and IPC code may
remain under `_reference/codex` for comparison while SDK coverage is completed,
but it must not be imported by active provider/runtime code.

Rules:

- Do not continue expanding hand-written Codex IPC as an active integration path.
- Do not expose app-server or IPC switches in active Codex runtime config.
- `CodexRuntime` implements `AgentRuntime`.
- `CodexRuntime` calls `RuntimeHostClient`.
- `steer_turn` and `interrupt_turn` do not require `turn_id`.
- Tool calls keep `SessionState.status = "running"` while active.
- Known Codex SDK objects must be read by type and attributes, not generic
  dict probing. For example, use `notification.payload`, `payload.thread_id`,
  `payload.turn_id`, `payload.item_id`, `payload.delta`, `turn.items`, and
  `item.root`.
- The active SDK stream path must dispatch on SDK payload classes such as
  `AgentMessageDeltaNotification`, `ItemStartedNotification`, and
  `TurnCompletedNotification`. Method strings are labels/sanity checks, not the
  primary source of truth for reducer shape.
- `model_dump()` is allowed only at JSON serialization, test assertions, or
  unknown-SDK diagnostics. It is not allowed as the first step of known Codex SDK
  timeline/state reduction.

Acceptance:

- `CodexProvider` does not import `_reference.codex`.
- `CodexProvider` treats the `openai-codex` SDK as the only active runnable surface.
- `CodexProvider` exposes only SDK runtime config fields, currently environment overrides.
- SDK mode is backed by an active `CodexRuntimeClient` adapter boundary, so
  future SDK API changes stay inside `runtimes/codex/sdk_client.py`.
- `CodexRuntimeClient` lives in `runtimes/codex/runtime_client.py`; native
  transports should implement that protocol instead of leaking SDK or
  app-server details into `CodexRuntime`.
- The app-server JSON-RPC client remains only as reference material under
  `_reference/codex/app_server_client.py`.
- `CodexProvider` must not expose `sdkMode`, `executablePath`, or `ipcEnabled`.
  The `ipc` capability remains false in the active SDK runtime.
- Basic `CodexRuntime` supports `identity`, `start`, `stop`, `get_config`, model catalog, permission catalog, session list, session snapshot, session state reads, text-only turn start, text-only steer, local interrupt, and minimal live timeline item upserts.
- Basic `CodexRuntime` depends only on the narrow `CodexRuntimeClient`
  protocol; SDK/app-server transport details stay outside the runtime reducer.
- Codex text-only `create_and_start_session()` and `start_turn()` call the SDK
  runtime client, not connector-layer IPC/app-server code.
- Codex turn start updates `SessionState.status` through `waiting` then `running`, and `turn/completed` maps back to `idle`.
- Codex no longer returns `backendNotifications`.
- Codex runtime events produce `SessionMeta`, `SessionState`, `SessionTimeline`, and `SessionNotice`.
- Codex turn start, steer, and interrupt paths use `AgentRuntime` when the native runtime is running.

Current Codex SDK rewrite sub-order:

1. Rewrite the SDK notification/thread/turn/item adapter to use SDK types and
   attribute access.
2. Rewrite the timeline reducer to consume typed adapter events and typed SDK
   thread items.
3. Rewrite the notification projector to dispatch on typed event variants and
   keep `SessionState.status` correct during streaming, tool calls, terminal
   events, completion, interruption, cancellation, and failure.
4. Then clean up Connector Server RPC DTO parsing/serialization so raw dicts are
   confined to JSON transport boundaries.

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

Status: partial outside Connector. Notices stay separate from timeline.
Connector dispatch paths exist; active Codex SDK approval notifications and
Claude SDK tool approvals project to `SessionNotice` through
`RuntimeHostClient`. Additional Server/Web notice reads and notice kinds remain
outside the connector-only refactor.

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

Status: Connector path implemented. Connector runtime RPC reads command catalogs
from the active runtime, and Codex exposes the native `/compact` command through
`thread/compact/start`. Remaining work is additional concrete runtime command
catalog entries and Server/Web adoption where not already migrated.

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

Status: native Connector slice completed. Continue runtime parity migration
inside `runtimes/claude`; do not import `_reference.claude` from active code.

Goal: make Claude follow the same protocol with explicit unsupported behavior.

Refactor Claude so:

- `ClaudeRuntime` implements `AgentRuntime`.
- Claude calls `RuntimeHostClient`.
- unsupported methods return standardized unsupported errors/results.

Acceptance:

- Claude does not require Server/Web runtime-specific conditionals.
- Capability differences are declared, not inferred from runtime name.
- Active Claude provider/runtime code is split into provider discovery/config,
  session reading, turn control, turn driving, approval control, and timeline
  helpers.

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

Status: in progress. Active Connector root adapter paths and active Codex
app-server/IPC paths are guarded by tests. Server/Web compatibility remnants
should be removed only when their replacement path is the active source of
truth.

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

1. Audit the connector-only objective against current code/tests/docs before
   declaring it complete.
2. If staying connector-only, add only missing architecture guards or concrete
   SDK parity behavior; do not revive app-server/IPC as active Codex code.
3. If moving beyond connector, continue with Server/Web adoption of
   `SessionMeta`, `SessionState`, `SessionTimeline`, `SessionNotice`, runtime
   catalogs, and command APIs.
4. Remove remaining Server/Web compatibility remnants only after the
   replacement path is the active source of truth.

Do not restart the old first stack. The protocol skeleton and active Connector
rewrite already exist; future work should extend the new protocol path.
