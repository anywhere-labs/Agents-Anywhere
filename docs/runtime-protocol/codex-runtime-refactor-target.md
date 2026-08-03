# Codex Runtime Refactor Target

Status: active execution target for `v2-connector-refactor`.

Date: 2026-08-03.

This document defines the next Connector-only refactor target for the active
Codex runtime. It supersedes ad-hoc "keep splitting files" decisions for this
slice. Each implementation round should pick the next unchecked item from the
checklist, update this document, run the listed verification, commit, and push.

## Why this target exists

The active Codex runtime has already moved away from app-server/IPC and now
uses the official Codex SDK through the `CodexRuntimeClient` boundary. The
remaining problem is not only file size; it is that several runtime behaviors
still pass through transitional dict-shaped projection code.

The goal is to make the Codex runtime look like this:

```text
Codex SDK typed object
  -> Codex SDK adapter type
  -> Codex runtime projection dataclass
  -> platform timeline/state/notice dataclass
  -> Connector host client
  -> Server JSON boundary
```

The anti-pattern we are removing is:

```text
Codex SDK typed object
  -> generic dict/model dump
  -> scattered `.get(...)` reducer
  -> platform dataclass
```

Dynamic dict access remains acceptable at JSON/SDK unknown fallback boundaries,
but it should stop being the normal path for known Codex SDK events and items.

## Current code-backed state

Current important active files:

```text
connector/connector/runtimes/codex/runtime.py                 ~280 lines
connector/connector/runtimes/codex/notifications.py           ~319 lines
connector/connector/runtimes/codex/turns/controller.py        ~337 lines
connector/connector/runtimes/codex/sessions/reader.py         ~194 lines
connector/connector/runtimes/codex/timeline/projection.py     ~412 lines
connector/connector/runtimes/codex/timeline/content.py        ~200 lines
connector/connector/runtimes/codex/timeline/raw_content.py    ~197 lines
```

Recently completed cleanup:

- `runtime_protocol.timeline` now has platform timeline item and content
  classes.
- Codex item classes live in `timeline/items.py`.
- Codex content projection lives in `timeline/content.py`.
- Raw content extraction lives in `timeline/raw_content.py`.
- Architecture tests guard that `items.py` does not own content projection and
  `projection.py` does not own raw content extraction.

Remaining high-risk areas:

- `timeline/projection.py` still owns multiple responsibilities:
  - projection dataclass;
  - thread snapshot reduction;
  - notification raw item extraction;
  - raw item parent type/status/role helpers.
- `notifications.py` still contains important side effects and several private
  lifecycle handlers. It is readable, but it mixes turn lifecycle, notices,
  timeline item activity, and state writes.
- SDK typed objects are not yet the primary reducer shape everywhere. Some
  known paths still become method/params/raw dictionaries before projection.
- `sessions/reader.py` and `timeline/projection.py` still share snapshot
  behavior through raw thread dictionaries.
- `turns/controller.py` is still a large orchestrator for start/steer/interrupt
  behavior and state publication.

## Target module shape

The Codex runtime package should move toward this tree:

```text
runtimes/codex/
  provider.py
  provider_config.py
  runtime.py                    # AgentRuntime facade only
  runtime_helpers.py

  sdk/
    runtime_client.py            # narrow protocol and typed request/result classes
    client.py                    # official SDK adapter
    events.py                    # SDK event wrapper/types
    shapes.py                    # SDK shape readers at the SDK boundary

  timeline/
    items.py                     # Codex timeline item classes and native item registry
    content.py                   # Codex content -> platform content class mapping
    raw_content.py               # temporary raw content fallback extraction
    projection.py                # CodexTimelineProjection only
    events.py                    # notification/event -> projection input
    snapshot.py                  # thread snapshot -> RuntimeTimelineItem tuple
    raw_item.py                  # temporary raw parent/status/role/revision helpers
    accumulator.py
    identity.py

  sessions/
    reader.py                    # session list/state/snapshot orchestration

  turns/
    controller.py                # turn operation orchestration
    lifecycle.py                 # turn status transitions, if needed
    interactions.py
    commands.py

  notifications/
    projector.py                 # public handler
    turn_lifecycle.py            # terminal/running turn state projection
    timeline_activity.py         # item activity projection
    notices.py                   # approval/error notice projection
```

The exact package split can be adjusted during implementation, but the
dependency direction should remain:

```text
runtime.py -> sessions / turns / notifications / catalogs
notifications -> timeline / notices / host
sessions -> sdk runtime client / timeline snapshot
timeline snapshot/events -> projection -> typed platform item/content
sdk client -> SDK only
```

Generic Connector server code must not import any Codex internals.

## Execution checklist

### C01. Split notification raw event extraction

Status: complete.

Move from `timeline/projection.py`:

- `raw_item_from_notification`
- `notification_delta`

Target module:

```text
connector/connector/runtimes/codex/timeline/events.py
```

Rules:

- Preserve public exports from `connector.runtimes.codex.timeline`.
- Do not change runtime behavior.
- Add an architecture test that `projection.py` does not define notification
  raw extraction.

Completed:

- Added `connector/connector/runtimes/codex/timeline/events.py`.
- Moved `raw_item_from_notification` and `notification_delta` out of
  `timeline/projection.py`.
- Preserved public package exports from `connector.runtimes.codex.timeline`.
- Added an architecture test that keeps notification raw extraction out of
  `projection.py`.

Verification:

```bash
cd connector
uv run ruff check connector/runtimes/codex tests/test_codex_runtime.py tests/test_connector_architecture.py
uv run pytest tests/test_codex_runtime.py tests/test_connector_architecture.py -q
```

### C02. Split thread snapshot reduction

Status: complete.

Move from `timeline/projection.py`:

- `timeline_items_from_thread`
- `raw_timeline_items`

Target module:

```text
connector/connector/runtimes/codex/timeline/snapshot.py
```

Rules:

- `sessions/reader.py` should read snapshots through `timeline.snapshot`, not
  through the projection module.
- Preserve existing `pending_messages.attach_to_raw_item(...)` behavior until
  typed snapshot items replace raw dictionaries.
- Add an architecture test that `projection.py` does not define snapshot
  reduction.

Completed:

- Added `connector/connector/runtimes/codex/timeline/snapshot.py`.
- Moved `timeline_items_from_thread` and `raw_timeline_items` out of
  `timeline/projection.py`.
- Preserved public package exports from `connector.runtimes.codex.timeline`.
- Preserved `pending_messages.attach_to_raw_item(...)` during snapshot
  reduction.
- Added an architecture test that keeps snapshot reduction out of
  `projection.py`.

Verification:

```bash
cd connector
uv run ruff check connector/runtimes/codex tests/test_codex_runtime.py tests/test_connector_architecture.py
uv run pytest tests/test_codex_runtime.py tests/test_connector_architecture.py -q
```

### C03. Split raw item metadata helpers

Status: complete.

Move from `timeline/projection.py`:

- `timeline_item_type`
- `timeline_item_status`
- `timeline_raw_type`
- `timeline_raw_status`
- `timeline_item_role`
- `timeline_item_turn_id`
- `timeline_item_revision`

Target module:

```text
connector/connector/runtimes/codex/timeline/raw_item.py
```

Rules:

- Keep these helpers explicitly marked as transitional raw SDK/JSON boundary
  code.
- Do not expand their use into business logic.
- `projection.py` should import these helpers, but should not own raw probing.

Completed:

- Added `connector/connector/runtimes/codex/timeline/raw_item.py`.
- Moved raw item parent type, status, role, turn id, revision, and raw
  type/status helpers out of `timeline/projection.py`.
- Preserved public package exports from `connector.runtimes.codex.timeline`.
- Added an architecture test that keeps raw item metadata helpers out of
  `projection.py`.

Verification:

```bash
cd connector
uv run ruff check connector/runtimes/codex tests/test_codex_runtime.py tests/test_connector_architecture.py
uv run pytest tests/test_codex_runtime.py tests/test_connector_architecture.py -q
```

### C04. Remove `CodexTimelineProjection.to_legacy_raw()`

Status: done.

Replace the remaining projection-to-dict loop with direct typed fields.

Removed problem:

- `CodexTimelineProjection.to_codex_timeline_item()` calls `to_legacy_raw()`.
- Identity, source, type/status/role, and content helpers then read that raw
  dict.

Target behavior:

- `CodexTimelineProjection` directly exposes the fields needed by item identity,
  source metadata, content mapping, and parent item selection.
- If a fallback raw mapping is still needed for debugging, store it as explicit
  metadata, not as the primary reducer input.

Rules:

- Do not remove unknown fallback diagnostics.
- Do not change platform item ids unless a test documents the intended
  migration.
- Add tests proving snapshot/live identity remains stable.

Verification:

```bash
cd connector
uv run ruff check connector/runtimes/codex tests/test_codex_runtime.py
uv run pytest tests/test_codex_runtime.py -q
```

Completed:

- Removed the projection-to-raw round trip from live notification accumulation.
- Added typed projection methods for item id, derived key, effective role, and
  pending Web message matching.
- Kept raw fallback data only as explicit item metadata for diagnostics.
- Added an architecture test preventing active Codex timeline code from
  reintroducing `to_legacy_raw`.

Verification:

```bash
cd connector
uv run ruff check connector/runtimes/codex tests/test_codex_runtime.py tests/test_connector_architecture.py
uv run pytest tests/test_codex_runtime.py tests/test_connector_architecture.py -q
```

### C05. Make SDK typed events the primary notification path

Status: done.

Current event flow still allows known SDK events to become raw method/params
dictionaries before timeline/status projection.

Target behavior:

- Known SDK notifications are dispatched by typed payload classes at the SDK
  boundary.
- `method` strings remain labels/sanity checks, not the primary reducer shape.
- Unknown SDK notifications may still enter fallback diagnostics.

Expected modules:

```text
runtimes/codex/sdk/events.py
runtimes/codex/timeline/events.py
runtimes/codex/notifications.py
```

Rules:

- Known SDK fields use attribute access.
- No `model_dump()`, `vars()`, `__dict__`, or recursive dump as the known-event
  reducer path.
- Keep existing tests for streaming assistant deltas, turn completion,
  interrupt/cancel/failure, approval notices, and item activity.

Verification:

```bash
cd connector
uv run ruff check connector/runtimes/codex tests/test_codex_runtime.py tests/test_codex_sdk_client.py
uv run pytest tests/test_codex_runtime.py tests/test_codex_sdk_client.py -q
```

Completed:

- Added `connector/connector/runtimes/codex/timeline/typed_events.py` for
  known SDK notification payload projection.
- `CodexSdkEvent` now retains the typed SDK payload for known notifications.
- Live item accumulation tries typed SDK projection before falling back to
  method/params diagnostics.
- Terminal turn sync uses typed SDK turn payloads when available.
- Delta accumulation reads typed SDK delta fields when available.
- Added tests proving typed SDK deltas and turn completion still project when
  `params` is empty, so known SDK reducer behavior no longer depends on the
  dict-shaped notification body.
- Added an architecture test preventing generic SDK model dumps in typed
  timeline projection.

Verification:

```bash
cd connector
uv run ruff check connector/runtimes/codex tests/test_codex_runtime.py tests/test_codex_sdk_client.py tests/test_connector_architecture.py
uv run pytest tests/test_codex_runtime.py tests/test_codex_sdk_client.py tests/test_connector_architecture.py -q
```

### C06. Split notification side-effect handlers

Status: done.

Current `notifications.py` owns:

- approval request notice creation;
- turn started/running/terminal state transitions;
- failed turn notices;
- item activity timeline upserts;
- blocking notice closeout;
- direct session state writes.

Target behavior:

Split into focused components while preserving behavior:

```text
notifications/projector.py
notifications/turn_lifecycle.py
notifications/timeline_activity.py
notifications/notices.py
```

Rules:

- Public flow methods should not be hidden behind many `_private` lifecycle
  names.
- Methods with side effects must have short docstrings explaining host state or
  notice/timeline writes.
- Runtime state updates remain semantic `RuntimeHostClient` calls.

Verification:

```bash
cd connector
uv run ruff check connector/runtimes/codex tests/test_codex_runtime.py tests/test_connector_architecture.py
uv run pytest tests/test_codex_runtime.py tests/test_connector_architecture.py -q
```

Completed:

- Replaced the active `notifications.py` module with a
  `notifications/` package that keeps `CodexNotificationProjector` exported from
  `connector.runtimes.codex.notifications`.
- Moved top-level notification dispatch into `notifications/projector.py`.
- Moved turn started/completed/failed side effects into
  `notifications/turn_lifecycle.py`.
- Moved item activity running-state updates and timeline item upserts into
  `notifications/timeline_activity.py`.
- Moved approval notices, blocking notice closeout, and failed-turn notice
  publication into `notifications/notices.py`.
- Added side-effect docstrings to the split handlers.
- Added an architecture test that prevents the projector from owning
  `timeline_sync`, `timeline_item_upsert`, or `notice_upsert`.

Verification:

```bash
cd connector
uv run ruff check connector/runtimes/codex tests/test_codex_runtime.py tests/test_connector_architecture.py
uv run pytest tests/test_codex_runtime.py tests/test_connector_architecture.py -q
```

### C07. Revisit turn controller split

Status: done.

Current `turns/controller.py` is a large orchestration class for:

- create-and-start;
- start;
- steer;
- interrupt;
- selection setting before send;
- pending client message registration;
- state publication.

Target behavior:

Keep `CodexTurnController` as a small facade and split side-effect-heavy
operations into explicit collaborators only if the split improves readability.

Candidate modules:

```text
turns/start.py
turns/steer.py
turns/interrupt.py
turns/state_publish.py
```

Rules:

- Do not split purely for file count.
- Preserve current waiting/running/idle/blocking behavior.
- Preserve client message id registration/dedupe behavior.

Verification:

```bash
cd connector
uv run ruff check connector/runtimes/codex tests/test_codex_runtime.py
uv run pytest tests/test_codex_runtime.py -q
```

Completed:

- Kept `CodexTurnController` as the public operation facade.
- Moved create-and-start session orchestration into
  `turns/session_start.py`.
- Moved session selection validation/state publication into
  `turns/selections.py`.
- Added `turns/selection_scopes.py` for shared selection scope validation.
- Preserved `turns/actions.py` as the owner of start/steer/interrupt side
  effects.
- Preserved `turns/commands.py` and `turns/interactions.py` as existing focused
  collaborators.
- Added side-effect docstrings for the newly split session creation and
  selection update handlers.
- Added an architecture test preventing `CodexTurnController` from directly
  owning `start_thread`, `session_meta_upsert`, or `session_states.update`.

Verification:

```bash
cd connector
uv run ruff check connector/runtimes/codex tests/test_codex_runtime.py tests/test_connector_architecture.py
uv run pytest tests/test_codex_runtime.py tests/test_connector_architecture.py -q
```

## Stop conditions

Stop and ask before proceeding if any step would require:

- changing Server API behavior;
- changing Web rendering behavior;
- reintroducing Codex IPC/app-server as an active path;
- changing platform timeline item ids;
- changing `SessionState.status` semantics;
- deleting `_reference` migration material.

## Current target

The next unchecked implementation item is:

```text
none; C01-C07 are implemented
```

Before marking the refactor complete, run the broader connector verification
set and audit C01-C07 against this document.
