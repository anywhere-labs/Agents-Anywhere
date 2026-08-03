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
| Commands | Partial | `/compact` exists; command-mode lifecycle and UI-facing failure semantics remain incomplete. |
| Session discovery/sync | Partial | Basic `thread/list` and snapshot exist; sync markers and rename-only updates remain incomplete. |
| Dashboard realtime | Not started | Polling/SSE replacement with dashboard-level realtime remains server/web work. |
| Codex IPC side-channel | Deferred | Old IPC behavior is reference-only while the runtime is SDK-first. |

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

### T02. Codex SDK-native event normalizer

Status: complete.

Goal:

- Introduce a clear SDK-native event normalization layer.
- Stop making new reducer logic depend primarily on legacy app-server method names.
- Normalize SDK thread snapshots, turn stream events, item objects, and request/response events into one internal Codex event shape.

Required behavior:

- SDK objects using `model_dump`, plain dicts, dataclasses, and simple objects all normalize consistently.
- Legacy method-shaped dicts remain accepted only as compatibility input.
- Normalized events expose stable fields: `thread_id`, `turn_id`, `item_id`, `event_type`, `item_type`, `role`, `status`, `content`, `raw`.

Completed:

- Added `CodexSdkEvent` as the SDK-native normalized event shape.
- SDK stream `notification_dict` now serializes from `CodexSdkEvent`.
- `CodexNotificationProjector` reads normalized event fields before dispatching.
- `CodexTimelineAccumulator` accepts normalized events directly while keeping legacy notification compatibility.
- Added coverage for legacy method-shaped dicts, plain dicts, model-dump objects, dataclasses, and simple objects.

Follow-up:

- T04 expands the actual timeline item type coverage produced from normalized events.

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
- create-and-start remains the only send path that carries initial selections.

Completed:

- `get_session_state` reads Codex `thread/read` and derives session-level
  `model` / `permission` selection ids from current native thread settings.
- Selection id parsing is strict; unknown model or permission selection ids now
  return `codex_invalid_selection` instead of silently falling back.
- Unsupported selection scopes return `codex_invalid_selection_scope`.
- `update_session_selections` validates ids, updates Codex thread settings via
  runtime client `thread/update`, and pushes merged `session.state.updated`.
- Existing-session `start_turn` remains selection-free; model/permission changes
  must be applied before sending.
- `create_and_start_session` remains the only send/create path carrying initial
  selections and now uses the same strict validation.
- Codex SDK client adapts `thread/update` to available thread settings methods
  such as `update_settings`.

Verification:

```bash
cd connector
uv run pytest tests/test_codex_runtime.py tests/test_connector_runtime.py -q
uv run pytest tests/test_codex_sdk_client.py -q
uv run ruff check connector/runtimes/codex tests/test_codex_runtime.py tests/test_codex_sdk_client.py
```

### T07. Command mode behavior

Status: not started.

Goal:

- Make `/xxx` commands a first-class session interaction mode.

Required behavior:

- command list is a live runtime read.
- disabled commands include `disabled_reason`.
- command execution is separate from normal message send.
- unknown command and invalid args never fall back to normal message.
- command result has consistent success/failure semantics.
- long-running command side effects are reported through state/timeline/notice updates.

Verification:

```bash
cd connector
uv run pytest tests/test_codex_runtime.py tests/test_connector_runtime.py -q
```

### T08. Session discovery and sync markers

Status: not started.

Goal:

- Restore old connector's efficient existing-session synchronization behavior in the new protocol shape.

Required behavior:

- `list_sessions` produces `SessionMeta`.
- stable session id mapping survives connector restarts.
- archived/deleted/unresumable sessions are not deleted from server; they are projected as metadata/local state or hidden state.
- unchanged sessions do not force timeline snapshots.
- title/cwd/order changes can upsert meta without timeline sync.
- sync state uses JSON store through `RuntimeHostClient.sync_state_*`.

Verification:

```bash
cd connector
uv run pytest tests/test_codex_runtime.py tests/test_sync_state.py -q
```

### T09. Server ingest alignment

Status: not started.

Goal:

- Ensure server ingest behavior matches the new runtime host events and does not rely on legacy replacement semantics.

Required behavior:

- `session.meta.upsert` maps to `SessionMeta`.
- `session.state.updated` is partial-merge safe.
- `timeline.sync` is upsert/reconcile, not delete/replace.
- `notice.upsert` supports interaction lifecycle updates.
- content hash is item-state identity, not item identity.
- sequence gaps do not force snapshot unless server explicitly declares recovery impossible.

Verification:

```bash
cd server
uv run pytest tests/test_backend_mvp.py -q
```

### T10. Web session interaction alignment

Status: not started.

Goal:

- Make Web render and operate from the new session split.

Required behavior:

- `SessionState.status` is the sole running-state source.
- `waiting`, `running`, `blocked`, `error`, and `disconnected` map to composer/button states.
- snapshot is used only for initial load, explicit recovery, or manual refresh.
- user optimistic messages reconcile with runtime echoes by `clientMessageId`.
- commands, notices, selections, and timeline items use their dedicated APIs.

Verification:

```bash
cd web
yarn lint
```

### T11. Dashboard realtime

Status: not started.

Goal:

- Replace repeated connector/session list polling with a dashboard-level realtime channel.

Required behavior:

- dashboard lifecycle is separate from session detail lifecycle.
- initial dashboard snapshot includes connector and session list state.
- dashboard changes push snapshot or invalidation without one-second polling.
- existing SSE compatibility remains until the WebSocket path is verified.

Verification:

```bash
cd server
uv run pytest tests/test_backend_mvp.py -q
cd ../web
yarn lint
```

### T12. Codex IPC optional side-channel

Status: deferred.

Goal:

- Reintroduce Codex IPC only as an optional SDK-runtime side-channel if product scope requires Codex App/IDE token-level synchronization.

Required behavior if resumed:

- IPC events enter the same SDK/platform reducer pipeline.
- web messages do not incorrectly take IPC ownership.
- follower start/steer/interrupt requests receive responses when IPC method type is request.
- broadcasts remain fire-and-forget.
- IPC desync does not force server snapshot polling.

Verification:

```bash
cd connector
uv run pytest tests/_reference/reference_codex_ipc_protocol.py tests/_reference/reference_codex_ipc_state.py -q
```

## Definition of done

The connector refactor behavior migration is considered complete when:

- T01 through T11 are complete or explicitly moved out of scope.
- T12 is either complete or documented as intentionally unsupported for the SDK-first release.
- Connector tests pass.
- Server ingest tests pass for runtime host events.
- Web no longer depends on periodic snapshot polling for normal session operation.
- A real Codex SDK end-to-end run can send, stream, tool-call, approve/reject, steer, interrupt, complete, refresh, and reopen without duplicate user messages or stale running state.
