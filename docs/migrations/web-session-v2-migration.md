# Web Session v2 migration

This document describes the Web migration target for the v2 session page. It is intentionally written before the Server and Connector WS work so the implementation can be tested end to end instead of by isolated transport changes.

Compatibility with the old v1/SSE session flow is not required.

## Target startup flow

When Web opens a session detail page:

```text
1. Request a short-lived client WS ticket
2. Open the session-scoped WebSocket
3. Buffer events received before the HTTP snapshot returns
4. Fetch GET /api/v2/sessions/{sessionId}/snapshot
5. Render the snapshot as the authoritative initial state
6. Drop buffered events whose cursor/sequence is not newer than snapshot.eventCursor
7. Apply newer buffered events in sequence
8. Continue applying live WebSocket events
```

The snapshot is the source of truth for initial render. The WebSocket is only the incremental channel after the snapshot cursor.

## HTTP APIs used by Web

Session detail uses:

```text
GET /api/v2/sessions/{sessionId}/snapshot
GET /api/v2/sessions/{sessionId}/timeline?...
GET /api/v2/sessions/{sessionId}/events?after={eventCursor}
POST /api/v2/sessions/{sessionId}/messages
POST /api/v2/sessions/{sessionId}/interrupt
POST /api/v2/sessions/{sessionId}/interactions/{noticeId}/respond
POST /api/v2/ws-ticket
```

New Session uses runtime-scoped catalogs before a session exists:

```text
GET /api/v2/agents/{runtime}/model-catalog
GET /api/v2/agents/{runtime}/permission-catalog
POST /api/v2/sessions
```

No Web v2 code should call:

```text
GET /api/v2/agents/{runtime}/models
GET /api/v2/agents/{runtime}/efforts
GET /api/v2/agents/{runtime}/modes
GET /api/v2/sessions/{sessionId}/events as SSE
POST /api/v2/approvals/{approvalId}/resolve
```

## Session snapshot contract

`GET /api/v2/sessions/{sessionId}/snapshot` must contain everything needed for first paint:

```json
{
  "session": {
    "id": "session_123",
    "status": "running",
    "updatedSeq": 42
  },
  "timeline": {
    "items": [],
    "nextSeq": 43,
    "hasMore": false
  },
  "notices": [],
  "effectiveCapabilities": {
    "revision": 42,
    "capabilities": []
  },
  "runtimeCapabilities": {
    "revision": 12,
    "capabilities": []
  },
  "catalogs": {
    "model": {},
    "permission": {}
  },
  "eventCursor": "seq:42",
  "serverTime": "2026-07-20T10:00:00Z"
}
```

`approvals` should not remain a first-class v2 UI input. Approval is rendered from `notices` as `type = "interaction"` and `interactionType = "approval"`.

## WebSocket ticket

Web must not place the long-lived access token in the WebSocket URL.

```text
POST /api/v2/ws-ticket
```

Request:

```json
{
  "clientId": "web_abc",
  "scope": {
    "sessionId": "session_123"
  }
}
```

Response:

```json
{
  "ticket": "opaque_short_lived_single_use_value",
  "expiresAt": "2026-07-20T10:01:00Z",
  "serverTime": "2026-07-20T10:00:00Z"
}
```

Web then connects:

```text
WS /api/v2/sessions/{sessionId}/ws?ticket=...
```

The ticket is single-use, short-lived, user-bound, client-bound, and session-bound.

## WebSocket event envelope

Every event uses one envelope:

```json
{
  "protocolVersion": "1.0",
  "eventId": "evt_1025",
  "sequence": 1025,
  "cursor": "seq:1025",
  "type": "session.status_changed",
  "sessionId": "session_123",
  "emittedAt": "2026-07-20T10:00:00Z",
  "payload": {}
}
```

Web applies only events newer than the last applied cursor/sequence.

If Web detects a sequence gap, it calls:

```text
GET /api/v2/sessions/{sessionId}/events?after={lastAppliedCursor}
```

If Server returns `snapshotRequired`, Web discards local remote state and reloads the snapshot.

## Required event types for the first end-to-end slice

The first v2 WS slice must support:

```text
session.status_changed
timeline.item_created
timeline.item_updated
notice.created
notice.updated
interaction.response_accepted
interaction.resolved
interaction.failed
capability.updated
```

`catalog.updated` and `schema.updated` can be added in the same transport but Web does not need to depend on them for the first E2E test because the session snapshot already contains current model and permission catalogs.

## Session status mapping

Web v2 only understands:

```text
sending
pending
running
stopping
idle
blocked
```

`sending` is local-only Web state. It is not persisted by Server.

Server and Connector must not expose these legacy session statuses to Web v2:

```text
waiting_approval
error
completed
failed
interrupted
cancelled
```

Migration mapping:

| Source condition | Web v2 status |
| --- | --- |
| User is submitting message and HTTP has not accepted it | `sending` |
| Server accepted message/create request but Connector has not confirmed processing | `pending` |
| Connector confirmed active execution | `running` |
| Blocking interaction is open | `blocked` |
| Server accepted interrupt but Connector has not confirmed stop | `stopping` |
| No active/pending/stopping/blocking execution | `idle` |

Legacy transition mapping:

| Legacy/current value | v2 projection |
| --- | --- |
| `waiting_approval` | `blocked` |
| `error` | `blocked` plus blocking `execution_error` interaction |
| failed `turn.end` | `blocked` plus blocking `execution_error` interaction |
| interrupted/cancelled `turn.end` | `idle` plus operation result/timeline item |

## Error as blocking Interaction

Execution errors are not session statuses. They must be represented as blocking Interaction notices.

Example:

```json
{
  "noticeId": "notice_error_123",
  "type": "interaction",
  "interactionType": "execution_error",
  "title": "Execution failed",
  "message": "The previous agent execution failed. Review the error before continuing.",
  "severity": "error",
  "blocking": {
    "scope": "session",
    "targetId": "session_123"
  },
  "responseRequired": true,
  "status": "open",
  "actions": [
    {
      "actionId": "continue",
      "label": "Continue",
      "style": "primary",
      "input": {
        "required": false,
        "schema": null,
        "uiSchema": null
      }
    },
    {
      "actionId": "dismiss",
      "label": "Dismiss",
      "style": "secondary",
      "input": {
        "required": false,
        "schema": null,
        "uiSchema": null
      }
    }
  ],
  "context": {
    "operationId": "op_123",
    "timelineItemId": "turn_end_123",
    "error": {
      "code": "runtime_error",
      "message": "..."
    }
  }
}
```

Because this interaction is blocking, Web must not allow a normal new message until it is resolved. This keeps the user decision explicit and avoids silently continuing after a runtime error.

The first v2 implementation does not close interactions by time. `expiresAt` can remain a display/protocol field, but Server does not automatically expire an interaction just because wall-clock time passed. Business invalidation is event-driven: runtime reset, turn end, interrupt, connector response saying the approval is no longer pending, session resync, or Server dispatch failure.

`failed` is not considered resolved. It remains an open blocking state so Web can show the failure and let the user retry or choose another action. Blocking is released only when every open blocking interaction for the session reaches one of:

```text
resolved
expired
cancelled
```

If multiple blocking interactions exist, resolving one of them is not enough. Web keeps the session blocked until the snapshot/event stream shows no remaining open blocking interaction.

## Approval as Interaction

Approval is no longer a separate Web data model.

Legacy:

```text
approval.requested
GET pending approvals
POST /api/v2/approvals/{approvalId}/resolve
```

v2:

```text
notice.created with type=interaction and interactionType=approval
POST /api/v2/sessions/{sessionId}/interactions/{noticeId}/respond
```

Web renders only actions declared by the interaction. It must not infer approval choices from runtime name.

## Capability-driven rendering

Web renders controls from `snapshot.effectiveCapabilities`.

Recommended mapping:

| UI | Capability |
| --- | --- |
| Composer normal send | `session.send_message` |
| Interrupt button | `session.interrupt` |
| Steer composer while running | `session.steer` |
| Goal accessory | `session.goal` |
| Manual compact | `session.compact` |
| Approval/interaction renderer | `session.notice.interaction` and/or `session.interaction.approval` |
| Model picker | `catalog.model` |
| Permission picker | `catalog.permission` |
| Runtime config form | `runtime.config` |

Runtime name may be used for labels and icons, not for feature availability.

## Catalog-driven selection

Web submits selection IDs only.

New Session:

```json
{
  "runtime": "codex",
  "modelSelectionId": "sel_model_abc",
  "permissionSelectionId": "sel_permission_def"
}
```

Send Message:

```json
{
  "content": "hello",
  "modelSelectionId": "sel_model_abc",
  "permissionSelectionId": "sel_permission_def"
}
```

Web must not submit native model IDs, reasoning IDs, efforts, mode strings, or permission mode strings.

## Composer rules

Web combines local and server state:

| Condition | Composer behavior |
| --- | --- |
| local `sending` | Disable normal send; show sending state |
| server `pending` | Disable normal send; show queued/dispatching state |
| server `running` and `session.steer` available | Show steer composer |
| server `running` and `session.interrupt` available | Show interrupt |
| server `blocked` | Disable normal send; show blocking Interaction |
| server `stopping` | Disable send/steer/interrupt |
| server `idle` and no blocking interaction | Enable normal send if `session.send_message` available |
| server `blocked` with blocking `execution_error` | Disable normal send until user responds |

If HTTP response and WebSocket event arrive out of order, Web keeps the highest sequence/revision and must not regress state.

## Connector requirements for one-step cleanup

The Server can project old connector notifications into v2 Web events, but Connector should be cleaned up in the same migration so v2 behavior is not permanently dependent on legacy statuses.

Connector should emit standard v2-compatible semantics:

| Current connector output | Required v2 cleanup |
| --- | --- |
| `session.updated.status = waiting_approval` | Emit/translate to `blocked` |
| `session.updated.status = error` | Emit/translate to `blocked`; include error notice payload or enough error detail for Server to create one |
| `approval.requested` | Keep as input temporarily or emit `notice.created` with `interactionType=approval` |
| `timeline.itemUpsert` for failed `turn.end` | Include structured result/error sufficient for Server `execution_error` interaction |
| Runtime capability discovery | Continue publishing `protocol.capabilitiesUpdated`; include session interaction capability where supported |
| Model/permission catalogs | Prefer connector-published stable `selectionId` when dynamic catalogs are added |

The first implementation can still accept current connector notifications at Server ingress, but Connector tests should assert that adapter reducers no longer produce legacy session statuses for v2 paths.

## Server implementation checklist

1. Add v2 Notice / Interaction models.
2. Add persisted or projected open notices to session snapshot.
3. Add WS ticket storage/validation.
4. Add session WebSocket endpoint.
5. Add recoverable event log/cursor endpoint.
6. Convert timeline broker payloads into v2 event envelopes.
7. Project approval requests into blocking approval interactions.
8. Project runtime/turn errors into blocking `execution_error` interactions and `blocked` session status.
9. Add `pending` when message/session create is accepted.
10. Add `stopping` when interrupt is accepted.
11. Ensure Web v2 never receives `waiting_approval` or `error` as `session.status`.

## Connector implementation checklist

1. Codex reducer maps approval block to `blocked`, not `waiting_approval`.
2. Codex reducer maps runtime error session update to `blocked`, not `error`, and keeps structured error content.
3. Codex turn failure produces `turn.end` with result/error and allows Server to create blocking `execution_error`.
4. Claude approval path emits or permits Server projection to blocking approval interaction.
5. Claude failure path emits enough structured error detail for Server `execution_error` interaction.
6. Connector protocol models include Notice / Interaction event shapes.
7. Connector tests cover no legacy `waiting_approval` / `error` session status on v2 notifications.

## Web implementation checklist

1. Replace `EventSource` session stream with ticketed WebSocket.
2. Fetch snapshot after opening WS and buffer early events.
3. Add event reducer keyed by `sequence` / `cursor`.
4. Replace pending approvals state with notices/interactions state.
5. Render approval from generic interaction.
6. Render blocking `execution_error` and require response before normal send.
7. Gate composer, steer, interrupt, goal, compact, model picker, permission picker by effective capabilities.
8. Submit `modelSelectionId` and `permissionSelectionId` only.
9. Remove calls to old model/effort/mode/approval APIs.
10. Add E2E test for normal run, approval block/resume, error block/continue, interrupt, reconnect recovery.

## End-to-end acceptance tests

Minimum real E2E coverage before accepting the migration:

1. New Session with model and permission selection IDs starts successfully.
2. Session detail first paint comes from snapshot.
3. Running session streams timeline updates over WebSocket.
4. Approval request becomes blocking Interaction; responding resumes the agent.
5. Runtime failure returns session to `blocked` and creates blocking `execution_error` Interaction.
6. User cannot send another normal message until the blocking error interaction is resolved.
7. Interrupt moves `running/blocked -> stopping -> idle`.
8. Browser refresh reconnects WS, reloads snapshot, and does not duplicate timeline items.
9. Web never renders behavior by checking `runtime === "codex"` or `runtime === "claude"` except for labels/icons.
