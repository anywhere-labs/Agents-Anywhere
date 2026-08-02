# Session API Proposal

Status: proposal for the next breaking session API cleanup.

This document defines the client-facing session API target for Agent Runtime Protocol v1. Connector channel endpoints stay stable:

```text
POST /api/v2/connector/auth
POST /api/v2/connector/ingest
WS   /api/v2/connector/ws
```

The session API needs redesign because the current `/sessions/{id}/state` endpoint mixes session view, timeline reads, approvals, and cursor state, while newer product logic separates `SessionMeta`, `SessionState`, `SessionTimeline`, and `SessionNotice`.

## Design principles

- `SessionMeta`, `SessionState`, `SessionTimeline`, and `SessionNotice` have separate resource boundaries.
- `SessionState.status` is the only UI running-state source.
- `SessionState.status = waiting` means the platform requested a turn, but the runtime has not confirmed processing has started.
- Timeline reads are not state reads.
- Notices are not timeline items.
- Runtime model/permission catalogs are live reads and are not embedded in session snapshot as primary truth.
- Existing-session message send does not carry model/permission selection ids.
- Selection changes update session state before sending.
- Snapshot is for initial load or explicit recovery, not periodic refresh.
- Event recovery is cursor based; sequence gaps do not imply snapshot unless the Server explicitly says `snapshotRequired=true`.

## Target resources

```text
SessionMeta      -> /sessions, /sessions/{sessionId}
SessionState     -> /sessions/{sessionId}/state
SessionTimeline  -> /sessions/{sessionId}/timeline
SessionNotice    -> /sessions/{sessionId}/notices
Realtime         -> /sessions/{sessionId}/ws and /sessions/{sessionId}/events
Aggregate load   -> /sessions/{sessionId}/snapshot
```

## Session list and meta

```text
GET   /api/v2/sessions
GET   /api/v2/sessions/{sessionId}
PATCH /api/v2/sessions/{sessionId}
POST  /api/v2/sessions/{sessionId}/read
POST  /api/v2/sessions/bulk-read
POST  /api/v2/sessions/bulk-archive
```

`GET /sessions` returns list summaries for dashboard/session list UI. A list summary may include both meta and state because the list needs title, archived/read fields, connector status, and running status.

`PATCH /sessions/{sessionId}` updates platform-owned meta/display fields only:

```json
{
  "title": "New title",
  "pinned": true,
  "archived": false
}
```

It must not update selections or runtime running status.

## Create and start

Migration/bind-only:

```text
POST /api/v2/sessions
```

This route must not create a new runtime session or start a turn. It is limited
to binding an already-known `externalSessionId` during migration/discovery.
New user tasks use create-and-start.

Target:

```text
POST /api/v2/sessions/create-and-start
```

Request:

```json
{
  "connectorId": "conn_...",
  "runtime": "codex",
  "title": "Optional title",
  "cwd": "/workspace",
  "selections": {
    "model": "sel_model_...",
    "permission": "sel_permission_..."
  },
  "message": {
    "content": "Hello",
    "attachments": [],
    "clientMessageId": "client_..."
  }
}
```

Rules:

- Server preallocates the platform `sessionId`.
- Runtime receives the platform `sessionId` before producing the first timeline/state event.
- Runtime is the final validator for selection ids.
- Blank new session creation is not a target for the first migration.

Response:

```json
{
  "ok": true,
  "sessionId": "sess_...",
  "result": {},
  "serverTime": "2026-08-02T..."
}
```

## Session state

```text
GET   /api/v2/sessions/{sessionId}/state
PATCH /api/v2/sessions/{sessionId}/state/selections
```

`GET /state` returns only `SessionState`:

```json
{
  "sessionId": "sess_...",
  "runtime": "codex",
  "status": "running",
  "selections": {
    "model": "sel_model_...",
    "permission": "sel_permission_..."
  },
  "statusReason": null,
  "error": null,
  "metadata": {},
  "updatedSeq": 123,
  "updatedAt": "2026-08-02T..."
}
```

Status values:

```text
idle
waiting
running
blocked
error
disconnected
```

`PATCH /state/selections` request:

```json
{
  "selections": {
    "model": "sel_model_..."
  }
}
```

Rules:

- Selection updates merge by scope.
- Unknown future scopes are allowed by the JSON shape.
- Runtime accepts or rejects the update.
- Web may show a short optimistic update, but durable truth arrives through `session.state.updated` or a later `GET /state`.

## Timeline

Target:

```text
GET /api/v2/sessions/{sessionId}/timeline
```

Query modes:

```text
?mode=latest&limit=200
?mode=changes&afterSeq=123&limit=200
?mode=history&beforeOrderSeq=456&limit=100
```

Response:

```json
{
  "items": [],
  "nextSeq": 123,
  "hasMore": false,
  "serverTime": "2026-08-02T..."
}
```

Rules:

- Timeline is upsert-only.
- Hiding replaces deletion.
- Timeline reads do not return `SessionState`.
- Timeline reads do not return `SessionNotice`.

## Notices

Target:

```text
GET  /api/v2/sessions/{sessionId}/notices
POST /api/v2/sessions/{sessionId}/notices/{noticeId}/respond
```

Optional filters:

```text
?status=open
?sinceSeq=123
```

`GET /notices` response:

```json
{
  "notices": [],
  "nextSeq": 123,
  "serverTime": "2026-08-02T..."
}
```

Respond request:

```json
{
  "actionId": "approve",
  "input": {}
}
```

Rules:

- Notice lifecycle is represented by upsert/status update, not deletion.
- User response does not automatically close a notice unless runtime/service semantics do so.
- Existing `/interactions/{noticeId}/respond` can remain as a transitional alias.

## Snapshot

```text
GET /api/v2/sessions/{sessionId}/snapshot?limit=200
```

Response:

```json
{
  "meta": {},
  "state": {},
  "timeline": {
    "items": [],
    "nextSeq": 123,
    "hasMore": false
  },
  "notices": [],
  "effectiveCapabilities": {},
  "eventCursor": "seq:123",
  "serverTime": "2026-08-02T..."
}
```

Rules:

- Snapshot is used for initial load and explicit recovery only.
- Snapshot must not be used as a periodic refresh mechanism.
- Snapshot must not include model/permission catalogs as primary selection source.

## Messages, steer, and interrupt

```text
POST /api/v2/sessions/{sessionId}/messages
POST /api/v2/sessions/{sessionId}/steer
POST /api/v2/sessions/{sessionId}/interrupt
```

Message request:

```json
{
  "content": "Hello",
  "attachments": [],
  "clientMessageId": "client_..."
}
```

Rules:

- Message send does not carry `modelSelectionId` or `permissionSelectionId`.
- If a selection must change, call `PATCH /state/selections` before message send.
- Server may set state to `waiting` after accepting a message request and before runtime confirms turn start.
- Runtime confirms active processing by emitting `session.state.updated` with `status = running`.
- Runtime/session state notifications accept `selections`; legacy
  `modelSelectionId` and `permissionSelectionId` are rejected on active
  notification paths.
- `interrupt` does not carry `turnId`; runtime finds its current active turn or returns conflict.

## Commands

```text
GET  /api/v2/sessions/{sessionId}/commands?query=...
POST /api/v2/sessions/{sessionId}/commands
```

`GET /commands` is a live runtime read. It does not return frontend-built static commands.

Execute request:

```json
{
  "command": "xxx",
  "args": [],
  "raw": "/xxx"
}
```

Response:

```json
{
  "command": "xxx",
  "ok": true,
  "code": null,
  "message": "done",
  "result": {},
  "serverTime": "2026-08-02T..."
}
```

Rules:

- Command execution is not message send.
- `/xxx` lookup or execution failure must not fallback to a normal message.
- Runtime side effects are reported separately through state/timeline/notice events.

## Current route migration table

| Current route | Target | Status |
| --- | --- | --- |
| `POST /api/v2/sessions` | `POST /api/v2/sessions/create-and-start` | Bind-only migration route when `externalSessionId` is present; reject new task creation. |
| `GET /api/v2/sessions/{id}/state?afterSeq=...` | `GET /api/v2/sessions/{id}/timeline` plus `GET /state` | Current route mixes state and timeline. |
| `GET /api/v2/sessions/{id}/snapshot` | Same path, new response shape | Remove `catalogs`; split `meta/state/timeline/notices`. |
| `POST /api/v2/sessions/{id}/messages` with selections | Same path without selections | Selection fields deprecated. |
| `POST /api/v2/sessions/{id}/commands` hardcoded commands | `GET/POST /commands` runtime RPC | Add list endpoint and remove hardcoded command source. |
| `POST /api/v2/sessions/{id}/interactions/{noticeId}/respond` | `POST /api/v2/sessions/{id}/notices/{noticeId}/respond` | Keep alias temporarily. |
| `POST /api/v2/sessions/{id}/sync` | explicit recovery/snapshot paths | Deprecated for normal client use. |
