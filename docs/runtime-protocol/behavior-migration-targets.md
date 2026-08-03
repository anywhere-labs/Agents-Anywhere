# Connector behavior migration targets

Status: active execution checklist for `v2-connector-refactor`.

This document is the per-round source of truth for migrating behavior from the
old Connector adapters into the new Agent Runtime Protocol implementation. Each
work round must pick exactly one target item, update its status, implement it,
run the listed verification, and commit the result before moving to another
target.

## Round discipline

Every implementation round follows this sequence:

1. Pick the first unchecked target unless the user explicitly chooses another.
2. Restate the target id in the work update, for example `T02`.
3. Implement only behavior needed by that target.
4. Add or update tests named for the behavior, not just the module changed.
5. Run the target verification command.
6. Update this document's status if the behavior is genuinely complete.
7. Commit the completed node.

Do not mix server, web, IPC, command, and timeline refactors in the same round
unless the target explicitly requires that integration.

## Current progress summary

Rough completion by behavior area:

| Area | Status | Notes |
| --- | --- | --- |
| SDK timeline source | Complete for T02 | Codex SDK stream input now flows through `CodexSdkEvent`; broader item coverage continues in T04. |
| Timeline identity and dedupe | Complete for T01 | `clientMessageId` tagging, live/snapshot echo projection, and stable fallback identity are covered; broader SDK event coverage continues in T02/T04. |
| Turn lifecycle | Complete for T03 | Codex runtime now covers waiting/running/blocked/idle convergence, failed-turn blocking notices, item-event running inference, and stale no-active-turn correction. |
| Notice/interaction lifecycle | Complete for T05 | Codex approvals now move through open/responding/resolved/closed, failed responses remain retryable, and blocking state is released only after open blocking notices are gone. |
| Tool/reasoning/file reduce | Complete for T04 | SDK/native message, reasoning, tool, file-change, runtime/system, and unknown fallback items reduce to platform-safe timeline shapes. |
| Selections | Complete for T06 | Catalogs are live runtime reads; Codex session state can read current selections, update selections through runtime state, reject invalid ids, and keep existing sends selection-free. |
| Commands | Complete for T07 | Codex commands are live runtime reads; `/compact` execution is separated from messages, disabled/invalid/unknown commands fail without fallback, and command side effects publish notice/state updates. |
| Session discovery/sync | Complete for T08 | Codex discovery returns SessionMeta for active and hidden local sessions, uses host JSON sync markers, skips timeline sync for unchanged sessions, and allows rename/meta-only updates. |
| Server ingest | Complete for T09 | Runtime host notifications now land as partial state updates, upsert-only Codex timeline sync, hidden session meta, and interaction lifecycle notices. |
| Web session interaction | Complete for T10 | Session detail composer now derives action state from `SessionState.status`, resolves optimistic messages by `clientMessageId`, and refreshes missing runtime state through the dedicated state endpoint instead of snapshot. |
| Dashboard realtime | Complete for T11 | Dashboard connects through a dedicated WebSocket lifecycle, receives the initial connector/session snapshot there, and receives pushed snapshots for changes without recurring connector/session list polling. |
| Codex IPC side-channel | Intentionally unsupported for SDK-first release | Old IPC behavior is reference-only; active Codex runtime keeps `ipc=false` and exposes no IPC config switch. |

## Target checklist

### T01. Codex SDK timeline identity and client message projection

Status: complete.

Goal:

- Use SDK-derived facts as Codex runtime input.
- Keep snapshot and live-stream timeline identity stable.
- Preserve `clientMessageId` on web-originated user message echoes.
- Avoid content-hash-based identity for fallback items.

Completed:

- Added Codex pending client message registry.
- Added Codex timeline identity helper.
- Tagged completed user echoes with `clientMessageId`.
- Tagged live user and steer echoes with `clientMessageId`.
- Added snapshot/live identity equality coverage for shared SDK item ids.
- Added SDK stream-finally completion fallback.

Follow-up:

- Moving more SDK event/object parsing out of old app-server method strings is
  tracked by T02.

Verification:

```bash
cd connector
uv run pytest tests/test_codex_runtime.py -q
uv run ruff check connector/runtimes/codex tests/test_codex_runtime.py
```

### T02. Codex SDK typed event adapter

Status: needs rewrite.

Goal:

- Introduce a clear SDK typed adapter layer.
- Stop making reducer logic depend on generic dict payloads, legacy app-server
  method shapes, or speculative field probing.
- Normalize SDK `Notification`, `Thread`, `Turn`, and `ThreadItem` objects into
  explicit Connector runtime protocol projections.

Required behavior:

- Known Codex SDK types must be read with attribute access. Examples:
  `notification.method`, `notification.payload`, `payload.thread_id`,
  `payload.turn_id`, `payload.item_id`, `payload.delta`, `thread.id`,
  `thread.turns`, `turn.id`, `turn.items`, and wrapped `item.root`.
- Known SDK payloads must be dispatched with type checks such as
  `isinstance(payload, AgentMessageDeltaNotification)`,
  `isinstance(payload, ItemStartedNotification)`, and
  `isinstance(payload, TurnCompletedNotification)`.
- `method` strings may be retained as protocol labels and sanity checks, but
  primary reducer behavior must be driven by typed payloads, not
  `params.get(...)` probing.
- `model_dump()` is allowed only at serialization boundaries:
  - emitting JSON to Server;
  - test assertions for JSON shape;
  - unknown SDK fallback diagnostics.
- Reducer logic must not call `model_dump()`, `vars()`, `__dict__`, or generic
  dataclass recursion before reading known SDK fields.
- Legacy method-shaped dicts may exist only in tests or `_reference/`, not as
  the active Codex SDK stream path.
- The typed adapter emits runtime protocol dataclasses such as
  `RuntimeTimelineItem`, `SessionState`, and `SessionNotice`; raw SDK objects
  may be kept in debug metadata only after the typed projection has been made.

Rewrite order:

1. Build the Codex SDK typed adapter for `Notification`, `Thread`, `Turn`, and
   `ThreadItem`.
2. Rework the Codex timeline reducer to consume typed adapter events/items.
3. Rework the Codex notification projector to dispatch on typed event variants.
4. Only after Codex streaming/status behavior is correct, clean up Server RPC
   request/response DTO parsing.

Acceptance:

- A real Codex SDK turn streams assistant deltas to Server as timeline item
  upserts before the final turn completion event.
- `turn/completed`, interrupted, cancelled, and failed events reliably update
  `SessionState.status`.
- Completed turns do not require `thread/read` refresh before Web can render the
  assistant reply.
- No active Codex SDK reducer path depends on generic dict dumping or casual
  `.get(...)` access for known SDK fields.

Verification:

```bash
cd connector
uv run pytest tests/test_codex_runtime.py -q
uv run pytest tests/test_connector_runtime.py -q
```

### T03. Turn lifecycle state machine

Status: complete.

Goal:

- Make `SessionState.status` reliably reflect the UI running state.
- Ensure every turn path eventually converges.

Required behavior:

- `start_turn`: `waiting -> running`.
- stream/event start without explicit start also becomes `running`.
- tool calls keep the session `running`.
- approval requests move to `blocked`.
- approval response moves back to `running` unless the turn has already ended.
- completed/interrupted/cancelled clear active turn and move to `idle`.
- failed turns create an error/interaction notice and move to a user-actionable state.
- `no active turn` conflicts actively correct stale session state.

Decision:

- Do not add `interrupting` to `RuntimeStatus` in this connector target. Interrupt
  pending remains a user-operation transient; `SessionState.status` stays
  `running` until the runtime confirms interruption, then converges to `idle`.

Completed:

- `start_turn` keeps `waiting -> running`.
- Native turn start and item activity can infer `running` even when no prior
  platform start event was observed.
- Tool output delta keeps the session `running` and interruptible.
- Approval requests move the session to `blocked`.
- Approval responses return to `running` only when an active turn still exists;
  responses after turn completion keep `idle`.
- Completed, interrupted, and cancelled turns clear active turn and converge to
  `idle`.
- Failed turns clear active turn, upsert a blocking `execution_error` notice,
  attach structured error data, and set session state to `blocked`.
- `steer` and `interrupt` no-active-turn conflicts actively correct stale
  session state to `idle`.

Verification:

```bash
cd connector
uv run pytest tests/test_codex_runtime.py -q
uv run pytest tests/test_connector_runtime.py -q
```

### T04. Timeline item reduce coverage

Status: complete.

Goal:

- Reduce common SDK-native Codex events into platform timeline items without exposing Codex-native item types to Web.

Required item coverage:

- user message
- steering user message
- assistant message
- assistant delta
- reasoning
- command/tool call start
- command/tool output delta
- command/tool completion
- tool failure
- file change proposal/application
- runtime/system message
- unknown fallback with safe source metadata

Completed:

- Platform timeline types now hide Codex-native item names from Web-facing
  `RuntimeTimelineItem.type`.
- User, steering-user, assistant, assistant-delta, and reasoning items reduce to
  message/system timeline content with stable text extraction.
- Command execution, command output deltas, command completion/failure,
  function calls, custom tool calls, and tool outputs reduce to tool timeline
  content.
- File change patch/update notifications reduce to artifact timeline content.
- Runtime/system messages reduce to system timeline content.
- Unknown native item types reduce to a safe system fallback while preserving
  source metadata for debugging.

Verification:

```bash
cd connector
uv run pytest tests/test_codex_runtime.py -q
uv run ruff check connector/runtimes/codex tests/test_codex_runtime.py
```

### T05. Notice and interaction lifecycle

Status: complete.

Goal:

- Make approval and future user interactions full lifecycle entities, not just open notices.

Required behavior:

- approval request creates `SessionNotice(status=open, response_required=true)`.
- respond attempt can mark the notice as responding or leave it open with error.
- successful response upserts a resolved/closed notice.
- cancelled/expired runtime interactions close the notice.
- failed response keeps the notice open and retryable.
- blocking session state is released only when no open blocking notice remains.

Completed:

- Runtime-local Codex notice registry tracks lifecycle-relevant approval notices
  without adding local durable config/state.
- Approval requests create `SessionNotice(status=open, response_required=true)`
  and move session state to `blocked`.
- Approval responses upsert `responding` before sending the SDK response.
- Successful approval responses upsert `resolved`, clear response requirement,
  clear blocking data, and remove available actions.
- Failed approval responses upsert `open` with retryable error metadata and keep
  session state `blocked`.
- Terminal turn notifications close open blocking approval notices with
  `status=closed`.
- Runtime-initiated interrupt success/soft-failure also closes open blocking
  approval notices when no terminal notification arrives first.
- Session state leaves `blocked` only when no open blocking notice remains for
  the session.

Verification:

```bash
cd connector
uv run pytest tests/test_codex_runtime.py -q
uv run pytest tests/test_connector_runtime.py -q
uv run ruff check connector/runtimes/codex tests/test_codex_runtime.py
```

### T06. Session selections live behavior

Status: complete.

Goal:

- Complete runtime-level catalog and session-level current selection behavior.

Required behavior:

- model and permission catalogs are live runtime reads.
- entering a session can read current selections.
- `update_session_selections` changes runtime session state, not message payloads.
- runtime pushes `session.state.updated` after selection changes.
- invalid selection returns a clear protocol error.
- public message send remains selection-free; Server may forward current
  `SessionState.selections` to runtime `start_turn`.

Completed:

- `get_session_state` reads Codex `thread/read` and derives session-level
  `model` / `permission` selection ids from current native thread settings.
- Selection id parsing is strict; unknown model or permission selection ids now
  return `codex_invalid_selection` instead of silently falling back.
- Unsupported selection scopes return `codex_invalid_selection_scope`.
- `update_session_selections` validates ids, updates runtime `SessionState`, and
  pushes merged `session.state.updated`; it does not call unavailable SDK thread
  settings update methods.
- Existing-session HTTP message send remains selection-free. Runtime
  `start_turn` can receive current `SessionState.selections` and apply them as
  per-turn SDK options when the runtime lacks persistent thread setting updates.
- `create_and_start_session` remains the only send/create path carrying initial
  selections and now uses the same strict validation.
- Codex SDK client applies selections through `thread.turn(...)` per-turn
  parameters.

Verification:

```bash
cd connector
uv run pytest tests/test_codex_runtime.py tests/test_connector_runtime.py -q
uv run pytest tests/test_codex_sdk_client.py -q
uv run ruff check connector/runtimes/codex tests/test_codex_runtime.py tests/test_codex_sdk_client.py
```

### T07. Command mode behavior

Status: complete.

Goal:

- Make `/xxx` commands a first-class session interaction mode.

Required behavior:

- command list is a live runtime read.
- disabled commands include `disabled_reason`.
- command execution is separate from normal message send.
- unknown command and invalid args never fall back to normal message.
- command result has consistent success/failure semantics.
- long-running command side effects are reported through state/timeline/notice updates.

Completed:

- `list_commands` remains a live runtime read and returns disabled commands with
  `disabled_reason` when the local Codex thread/client is unavailable.
- `/compact` execution is routed through `execute_command` and never through
  normal message send or `turn/start`.
- Unknown commands return `RuntimeCommandResult(ok=false, code=unknown_command)`.
- `/compact` arguments return
  `RuntimeCommandResult(ok=false, code=arguments_not_supported)`.
- Disabled `/compact` returns
  `RuntimeCommandResult(ok=false, code=command_disabled)` and does not call the
  Codex client.
- Successful `/compact` returns `ok=true, code=started` and publishes a
  non-blocking command notice plus a `session.state.updated` metadata update.
- Runtime/client command failures return
  `RuntimeCommandResult(ok=false, code=codex_command_failed)` without falling
  back to normal messages.

Verification:

```bash
cd connector
uv run pytest tests/test_codex_runtime.py tests/test_connector_runtime.py -q
uv run ruff check connector/runtimes/codex tests/test_codex_runtime.py
```

### T08. Session discovery and sync markers

Status: complete.

Goal:

- Restore old connector's efficient existing-session synchronization behavior in the new protocol shape.

Required behavior:

- `list_sessions` produces `SessionMeta`.
- stable session id mapping survives connector restarts.
- archived/deleted/unresumable sessions are not deleted from server; they are projected as metadata/local state or hidden state.
- unchanged sessions do not force timeline snapshots.
- title/cwd/order changes can upsert meta without timeline sync.
- sync state uses JSON store through `RuntimeHostClient.sync_state_*`.

Completed:

- `list_sessions` returns `SessionMeta` for every recognizable Codex thread ref.
- Stable platform session ids continue to derive from connector id + Codex thread
  id, so the mapping survives runtime object restarts.
- Archived, deleted, and unresumable local threads are projected as
  `metadata.local_state` plus `metadata.hidden=true`; Connector does not delete
  them from server state.
- Codex thread refs produce a timeline-change sync marker from revision/update
  style fields while title/cwd/order fields remain meta-only.
- Runtime reads and writes `codex/session-sync/{thread_id}` through
  `RuntimeHostClient.sync_state_*`, backed by the existing JSON sync state store.
- Repeated unchanged discovery returns
  `metadata.sync.requires_timeline_sync=false` and does not read a timeline
  snapshot.
- Rename-only discovery still returns updated `SessionMeta` while keeping
  `requires_timeline_sync=false`.
- `force=true` explicitly marks active sessions as requiring timeline sync even
  when the marker is unchanged.

Verification:

```bash
cd connector
uv run pytest tests/test_codex_runtime.py tests/test_sync_state.py -q
uv run ruff check connector/runtimes/codex tests/test_codex_runtime.py
```

### T09. Server ingest alignment

Status: complete.

Goal:

- Ensure server ingest behavior matches the new runtime host events and does not rely on legacy replacement semantics.

Required behavior:

- `session.meta.upsert` maps to `SessionMeta`.
- `session.state.updated` is partial-merge safe.
- `timeline.sync` is upsert/reconcile, not delete/replace.
- `notice.upsert` supports interaction lifecycle updates.
- content hash is item-state identity, not item identity.
- sequence gaps do not force snapshot unless server explicitly declares recovery impossible.

Completed:

- `session.meta.upsert` now creates or updates server sessions and maps runtime
  hidden/local session state onto the existing archived projection instead of
  ignoring hidden local sessions.
- `session.state.updated` remains partial-merge safe through
  `upsert_session_runtime_state`; legacy model/permission scalar fields remain
  rejected.
- Codex `timeline.sync` now uses sync-style normalization and duplicate
  reconciliation, then upserts changed items without deleting missing persisted
  items or forcing snapshot refetch.
- Claude snapshot sync keeps the explicit replacement path as the old runtime
  compatibility exception.
- `notice.upsert` now accepts interaction lifecycle updates including
  `responding` and `closed`, and reconciles session blocking state on lifecycle
  changes.
- Existing content-hash-as-item-state identity coverage remains in the backend
  suite.
- Recovery behavior keeps `snapshotRequired=false` for recoverable event ranges;
  snapshot is reserved for explicit unrecoverable cases.

Verification:

```bash
cd server
uv run pytest tests/test_backend_mvp.py -q
```

### T10. Web session interaction alignment

Status: complete.

Goal:

- Make Web render and operate from the new session split.

Required behavior:

- `SessionState.status` is the sole running-state source.
- `waiting`, `running`, `blocked`, `error`, and `disconnected` map to composer/button states.
- snapshot is used only for initial load, explicit recovery, or manual refresh.
- user optimistic messages reconcile with runtime echoes by `clientMessageId`.
- commands, notices, selections, and timeline items use their dedicated APIs.

Completed:

- Session detail and composer derive interactive state from
  `SessionRuntimeState.status`; missing state falls back only to idle or
  disconnected, not to the legacy `SessionView.status` running projection.
- Composer maps `waiting`, `pending`, `running`, `stopping`, `blocked`,
  `error`, and `disconnected` into send/interrupt/placeholder behavior.
- Interrupt is shown only for interruptible runtime states instead of whenever
  the interrupt capability exists.
- Session events that carry session metadata without runtime state trigger a
  dedicated `/runtime-state` refresh, avoiding snapshot refetch for ordinary
  state convergence.
- Optimistic user messages are reconciled with runtime echoes only by
  `clientMessageId`, avoiding text-based accidental merges.
- Web notice types now accept `responding` and `closed`; responding
  interactions remain visible until resolved/closed.
- Commands, selections, notices, and timeline items continue to use their
  dedicated APIs.
- `web-next` lint verification now runs a supported TypeScript gate under the
  project's Yarn 4/Corepack setup.

Verification:

```bash
cd web-next
corepack yarn lint
```

### T11. Dashboard realtime

Status: complete.

Goal:

- Replace repeated connector/session list polling with a dashboard-level realtime channel.

Required behavior:

- dashboard lifecycle is separate from session detail lifecycle.
- initial dashboard snapshot includes connector and session list state.
- dashboard changes push snapshot or invalidation without one-second polling.
- existing SSE compatibility remains until the WebSocket path is verified.

Completed:

- Web authenticated dashboard startup now waits for `/dashboard/ws` initial
  `dashboard.snapshot` instead of immediately issuing separate connector and
  session list requests.
- Web keeps REST `refreshData()` as an explicit/manual and first-connect
  fallback path, not as a normal recurring dashboard lifecycle.
- Dashboard WebSocket snapshots contain both connector and session lists.
- Server dashboard change notifications now fan out immediately by default;
  explicit debounce remains supported for tests or future tuning.
- Dashboard WebSocket now has backend coverage for initial snapshot, changed
  snapshot push, and ticket scope rejection.
- Existing `/events/dashboard` SSE compatibility endpoint remains in place.

Verification:

```bash
cd server
uv run pytest tests/test_backend_mvp.py -q
cd ../web-next
corepack yarn lint
```

### T12. Codex IPC optional side-channel

Status: intentionally unsupported for SDK-first release.

Goal:

- Reintroduce Codex IPC only as an optional SDK-runtime side-channel if product scope requires Codex App/IDE token-level synchronization.

Required behavior if resumed:

- IPC events enter the same SDK/platform reducer pipeline.
- web messages do not incorrectly take IPC ownership.
- follower start/steer/interrupt requests receive responses when IPC method type is request.
- broadcasts remain fire-and-forget.
- IPC desync does not force server snapshot polling.

Decision:

- Do not reintroduce Codex IPC in the SDK-first release.
- The active Codex provider/runtime must remain SDK-only.
- Active Codex discovery keeps capability `ipc=false`.
- Active Codex config must not expose `ipcEnabled`, `sdkMode`, or
  `executablePath`.
- Active connector code and active connector tests must not import
  `connector._reference`.
- Historical Codex IPC protocol/state/client/publisher code remains only under
  `_reference/codex` and `_deprecated` docs for future comparison.
- If IPC is resumed later, it must enter through the same
  `CodexRuntimeClient`/SDK-platform reducer boundary, not by reviving the old
  adapter path.

Completed:

- Audited active connector code for `_reference` and IPC imports.
- Kept active provider/runtime SDK-only via existing architecture tests.
- Kept IPC protocol/state reference fixtures passing as frozen reference
  material.
- Documented that T12 is intentionally unsupported rather than merely deferred.

Verification:

```bash
cd connector
uv run pytest tests/_reference/reference_codex_ipc_protocol.py tests/_reference/reference_codex_ipc_state.py -q
uv run pytest tests/test_connector_architecture.py tests/test_codex_provider.py -q
```

## Definition of done

The connector refactor behavior migration is considered complete when:

- T01 through T11 are complete.
- T12 is either complete or documented as intentionally unsupported for the SDK-first release.
- Connector tests pass.
- Server ingest tests pass for runtime host events.
- Web no longer depends on periodic snapshot polling for normal session operation.
- A real Codex SDK end-to-end run can send, stream, tool-call, approve/reject, steer, interrupt, complete, refresh, and reopen without duplicate user messages or stale running state.
