# Agent Runtime Protocol v1

Status: draft, authoritative for the next v2 runtime refactor.

This directory replaces the older v2 catalog/session/command planning notes as the source of truth for the next breaking runtime refactor. Older migration documents may describe the current implementation or an earlier plan, but new work should follow this protocol unless this directory is updated.

## Problem

Connector code currently mixes four concerns:

- Connector UI/control entry points such as CLI and desktop RPC.
- Connector application concerns such as auth, WebSocket RPC, ingest flushing, configuration, and runtime lifecycle.
- Agent runtime integration details for Codex, Claude, and future runtimes.
- Server-facing notification names and payload shapes.

That makes features such as model selection, permissions, commands, Codex IPC state, and timeline synchronization grow through runtime-specific conditionals. The next v2 refactor should make Connector modular: upper layers depend only on a runtime protocol, while each runtime adapter implements that protocol.

## Layering

```text
CLI / Desktop RPC / UI
        |
Connector application layer
  - pairing/auth
  - server HTTP and WebSocket
  - local configuration
  - runtime lifecycle
  - server RPC dispatch
  - notification flushing
        |
Agent Runtime Protocol
  - Connector -> Runtime ABC
  - Runtime -> Connector host client ABC
  - dataclass domain models
        |
Runtime adapters
  - Codex
  - Claude
  - OpenCode
  - ACP
        |
Native runtime process, SDK, IPC, local history, and filesystem state
```

The Connector application layer must not know Codex IPC, Claude SDK, or runtime-native selection details. Runtime adapters must not know server notification method names such as `timeline.itemUpsert` or `protocol.modelCatalogUpdated`. They call the host client instead.

## Domain model

The protocol separates session data into four domain objects:

- `SessionMeta`: what this session is.
- `SessionState`: what this session is currently doing and which runtime options it currently selected.
- `SessionTimeline`: what happened in this session.
- `SessionNotice`: what currently needs user attention or records notification/interaction state.

Runtime-level catalogs and command lists are live reads, not session state.

| Concept | Scope | Source of truth | Durable on Server | Notes |
| --- | --- | --- | --- | --- |
| Session meta | Session | Platform and runtime metadata projection | Yes | Identity, connector/runtime binding, title, cwd, archive/pin/read metadata. |
| Session state | Session | Runtime projection | Yes | Status, selections, status reason, error, metadata. |
| Session timeline | Session | Runtime normalized projection | Yes | Timeline items and recovery cursor. |
| Session notice | Session | Runtime/platform projection | Yes | Notifications, interactions, approvals, input requests, and errors needing user attention. |
| Model catalog | Runtime | Runtime local read | No, except transitional code | Read on demand when the UI opens the selector. |
| Permission catalog | Runtime | Runtime local read | No, except transitional code | Read on demand when the UI opens the selector. |
| Command list | Session | Runtime local read | No | Read on demand when the user types `/`. |
| Command execution | Session | Runtime RPC result | No | Side effects are reported separately through host events. |

## Breaking changes

This refactor is allowed to be breaking. The target design removes model and permission selections from message/session request payloads and from durable `SessionView` fields.

Remove or deprecate these as protocol truth:

- `SessionView.modelSelectionId`
- `SessionView.permissionSelectionId`
- `MessageCreateRequest.modelSelectionId`
- `MessageCreateRequest.permissionSelectionId`
- `SessionCreateRequest.modelSelectionId`
- `SessionCreateRequest.permissionSelectionId`
- Server-persisted model/permission catalogs as the primary read path
- frontend-built command lists

## Selection semantics

`selectionId` keeps the existing meaning: a stable platform identifier for a runtime option.

The intended uniqueness rule is:

```text
runtime + scope + option identity -> selectionId
```

Within one runtime and one scope, a `selectionId` uniquely identifies one option. A stable hash remains acceptable and preferred for controllability.

Selections are part of `SessionState`, not `SessionMeta` and not message payloads:

```json
{
  "sessionId": "sess_...",
  "runtime": "codex",
  "status": "idle",
  "selections": {
    "model": "sel_model_...",
    "permission": "sel_permission_..."
  }
}
```

Runtime can update selections at any time. User-initiated selection changes may be limited by runtime/session state.

For model catalogs, a `selectionId` must identify one concrete executable choice. If a model exposes reasoning or effort variants, the model item itself must not have a `selectionId`; each reasoning item carries the concrete `selectionId`. If a model has no reasoning variants, the model item carries the concrete `selectionId`.

## New session semantics

Blank session creation is not a protocol target for the first refactor.

New session uses one combined operation:

```text
create_and_start_session(session_id, content, selections, attachments, ...)
```

The frontend reads runtime-level model and permission catalogs before creation. There is no runtime default in the protocol. The frontend may remember the user's most recent selection locally; if that selection is missing or disabled, it should choose the first enabled option.

## Existing session send semantics

For an existing session, sending a message only sends message content and attachments.

```text
update_session_selections(...)
start_turn(content, attachments, client_message_id)
```

Model and permission state must be updated before sending. `start_turn` must not carry one-off model or permission selection fields.

## Documents

- [Connector -> Runtime ABC](./connector-to-runtime.md)
- [Runtime -> Connector host client](./runtime-host-client.md)
- [Connector structure target](./connector-structure.md)
- [Server API and database target](./server-api-db.md)
- [Web behavior](./web-behavior.md)
- [Migration sequence](./migration-sequence.md)
